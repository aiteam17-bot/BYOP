-- =============================================================================
-- Group Trip Planner: 007 Supabase foundation hardening
-- (run AFTER schema.sql and 002 to 006)
--
-- HOW TO USE: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Run it once. It deletes no rows and drops no tables or columns.
--
-- What it changes, and why (review list):
--   1. schema_versions: a version record, so the database itself says which
--      migrations are applied.
--   2. Default deny: future tables/functions get no automatic grants; every
--      existing table/function is re-granted explicitly below.
--   3. Helpers move to a `private` schema the API cannot reach. They only
--      answer questions about the signed-in user. The old public helpers
--      (is_trip_member, is_trip_owner, member_role, expense_trip_id, can_plan)
--      took ANY user id and were callable by every signed-in user; their
--      EXECUTE grant is revoked. They are left in place, unused.
--   4. An explicit permission matrix for owner / co-planner / member.
--   5. Every RLS policy is re-created on the private helpers, with checks on
--      both the old row (USING) and the new row (WITH CHECK).
--   6. Rows cannot be moved between trips or people (key-change triggers).
--   7. The organiser's membership cannot be deleted while the trip exists.
--   8. profiles: one row per user, created on sign-up, readable by co-members.
--   9. Invites: hashed, expiring, revocable tokens (trip_invites), rate-limited
--      preview/redeem. The old plaintext trips.invite_token column is kept but
--      no longer readable or writable by users; each existing token is copied
--      in hashed form so already-shared links keep working for 7 days. The
--      old invite_preview / join_trip functions lose their EXECUTE grant.
--  10. The 006 Decide functions are re-created on the permission matrix, with
--      the same names, arguments and messages.
--  11. health_check(): returns 'ok', nothing else, for /api/health.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Version record
-- -----------------------------------------------------------------------------

create table public.schema_versions (
  version    integer primary key,
  name       text not null,
  applied_at timestamptz,
  note       text
);
alter table public.schema_versions enable row level security;

insert into public.schema_versions (version, name, applied_at, note) values
  (1, 'schema.sql',              null, 'applied before version tracking; recorded by 007'),
  (2, '002_trip_flow.sql',       null, 'applied before version tracking; recorded by 007'),
  (3, '003_stay_comparison.sql', null, 'applied before version tracking; recorded by 007'),
  (4, '004_map_locations.sql',   null, 'applied before version tracking; recorded by 007'),
  (5, '005_grants.sql',          null, 'applied before version tracking; recorded by 007'),
  (6, '006_decide.sql',          null, 'applied before version tracking; recorded by 007'),
  (7, '007_foundation.sql',      now(), null);


-- -----------------------------------------------------------------------------
-- 2. Default deny for objects created from now on
-- -----------------------------------------------------------------------------

alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges revoke execute on functions from public;


-- -----------------------------------------------------------------------------
-- 3. Private, hardened helpers (not reachable through the API)
-- -----------------------------------------------------------------------------

create schema private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- Your role on a trip, or null if you are not on it.
create function private.my_role(_trip_id uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select m.role from public.trip_members m
  where m.trip_id = _trip_id and m.user_id = (select auth.uid());
$$;

create function private.is_member(_trip_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.trip_members m
    where m.trip_id = _trip_id and m.user_id = (select auth.uid())
  );
$$;

-- Is another person on a trip? Answers only for trips YOU are on, so it
-- cannot be used to probe other trips.
create function private.is_co_member(_trip_id uuid, _user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_member(_trip_id) and exists (
    select 1 from public.trip_members m
    where m.trip_id = _trip_id and m.user_id = _user_id
  );
$$;

-- Do you share at least one trip with this person?
create function private.shares_trip_with(_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.trip_members mine
    join public.trip_members theirs on theirs.trip_id = mine.trip_id
    where mine.user_id = (select auth.uid()) and theirs.user_id = _user_id
  );
$$;

-- The trip an expense belongs to, only if you are on that trip.
create function private.expense_trip(_expense_id uuid)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select e.trip_id from public.expenses e
  where e.id = _expense_id and private.is_member(e.trip_id);
$$;

-- -----------------------------------------------------------------------------
-- 4. Permission matrix: the single place that says who may do what
--
--   action               owner  co_planner  member
--   read                   ✓        ✓          ✓
--   rsvp / suggest_option  ✓        ✓          ✓
--   vote / nudge           ✓        ✓          ✓
--   edit_own_preferences   ✓        ✓          ✓
--   add_stay / leave       ✓        ✓          ✓
--   rename_trip            ✓        ✓
--   settle_vote            ✓        ✓
--   reopen_vote            ✓        ✓
--   remove_any_option      ✓        ✓
--   manage_invites         ✓        ✓
--   manage_roles           ✓
--   remove_member          ✓
--   edit_trip_dates        ✓
--   delete_trip            ✓
-- -----------------------------------------------------------------------------

create function private.role_allows(_role text, _action text)
returns boolean
language sql immutable set search_path = ''
as $$
  select case
    when _role is null then false
    when _action in ('read', 'rsvp', 'suggest_option', 'vote', 'nudge',
                     'edit_own_preferences', 'add_stay', 'leave')
      then _role in ('owner', 'co_planner', 'member')
    when _action in ('rename_trip', 'settle_vote', 'reopen_vote',
                     'remove_any_option', 'manage_invites')
      then _role in ('owner', 'co_planner')
    when _action in ('manage_roles', 'remove_member', 'edit_trip_dates', 'delete_trip')
      then _role = 'owner'
    else false
  end;
$$;

create function private.can(_trip_id uuid, _action text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.role_allows(private.my_role(_trip_id), _action);
$$;

-- Used inside the API functions: the signed-in user, who must be on the trip
-- and allowed to do this. Raises a readable error otherwise.
create function private.require(_trip_id uuid, _action text)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  _uid  uuid := auth.uid();
  _role text;
begin
  if _uid is null then
    raise exception 'Please sign in first' using errcode = '42501';
  end if;
  select m.role into _role from public.trip_members m
   where m.trip_id = _trip_id and m.user_id = _uid;
  if _role is null then
    raise exception 'You are not a member of this trip' using errcode = '42501';
  end if;
  if not private.role_allows(_role, _action) then
    raise exception '%', case _action
      when 'rename_trip'       then 'Only the organiser or a co-planner can rename the trip'
      when 'settle_vote'       then 'Only the organiser or a co-planner can settle a vote'
      when 'reopen_vote'       then 'Only the organiser or a co-planner can reopen a vote'
      when 'remove_any_option' then 'Only whoever suggested it, the organiser or a co-planner can remove it'
      when 'manage_invites'    then 'Only the organiser or a co-planner can manage invite links'
      when 'manage_roles'      then 'Only the organiser can change roles'
      when 'remove_member'     then 'Only the organiser can remove people'
      when 'edit_trip_dates'   then 'Only the organiser can change the trip dates'
      when 'delete_trip'       then 'Only the organiser can delete the trip'
      else 'You are not allowed to do that'
    end using errcode = '42501';
  end if;
  return _uid;
end;
$$;

revoke all on all functions in schema private from public, anon, authenticated;
-- Only what RLS policies need is executable by signed-in users. These answer
-- for the caller only. (private.require is used only inside API functions.)
grant execute on function private.my_role(uuid)              to authenticated;
grant execute on function private.is_member(uuid)            to authenticated;
grant execute on function private.is_co_member(uuid, uuid)   to authenticated;
grant execute on function private.shares_trip_with(uuid)     to authenticated;
grant execute on function private.expense_trip(uuid)         to authenticated;
grant execute on function private.can(uuid, text)            to authenticated;
grant execute on function private.role_allows(text, text)    to authenticated;


-- -----------------------------------------------------------------------------
-- 5. Guard triggers
-- -----------------------------------------------------------------------------

-- No row may change the trip (or person) it belongs to.
create function private.forbid_key_change()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  _col text;
begin
  foreach _col in array TG_ARGV loop
    if (to_jsonb(new) -> _col) is distinct from (to_jsonb(old) -> _col) then
      raise exception 'Rows cannot be moved between trips or people (% cannot change)', _col
        using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;

create trigger trip_members_keys     before update on public.trip_members    for each row execute function private.forbid_key_change('trip_id', 'user_id');
create trigger preferences_keys      before update on public.preferences     for each row execute function private.forbid_key_change('trip_id', 'user_id');
create trigger stays_keys            before update on public.stays           for each row execute function private.forbid_key_change('trip_id', 'added_by');
create trigger itinerary_items_keys  before update on public.itinerary_items for each row execute function private.forbid_key_change('trip_id');
create trigger expenses_keys         before update on public.expenses        for each row execute function private.forbid_key_change('trip_id');
create trigger expense_splits_keys   before update on public.expense_splits  for each row execute function private.forbid_key_change('expense_id', 'user_id');
create trigger payments_keys         before update on public.payments        for each row execute function private.forbid_key_change('trip_id');
create trigger polls_keys            before update on public.polls           for each row execute function private.forbid_key_change('trip_id', 'kind');
create trigger poll_options_keys     before update on public.poll_options    for each row execute function private.forbid_key_change('trip_id', 'poll_id');
create trigger poll_votes_keys       before update on public.poll_votes      for each row execute function private.forbid_key_change('trip_id', 'poll_id', 'user_id');
create trigger nudges_keys           before update on public.nudges          for each row execute function private.forbid_key_change('trip_id', 'to_user');
create trigger trips_owner_fixed     before update on public.trips           for each row execute function private.forbid_key_change('owner_id');

-- The organiser cannot leave or be removed while the trip exists (deleting
-- the trip removes everyone, which is allowed).
create function private.keep_trip_owner()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.role = 'owner' and exists (select 1 from public.trips t where t.id = old.trip_id) then
    raise exception 'The organiser cannot leave or be removed. Delete the trip instead.'
      using errcode = '42501';
  end if;
  return old;
end;
$$;

create trigger trip_members_keep_owner
  before delete on public.trip_members
  for each row execute function private.keep_trip_owner();

revoke all on function private.forbid_key_change() from public, anon, authenticated;
revoke all on function private.keep_trip_owner()   from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 6. Profiles
-- -----------------------------------------------------------------------------

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  avatar_url   text check (avatar_url is null or avatar_url ~ '^https://'),
  created_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;
create trigger profiles_keys before update on public.profiles
  for each row execute function private.forbid_key_change('id');

-- A readable default name: GitHub username, then full name, then the part of
-- the email before the @.
create function private.default_display_name(_meta jsonb, _email text)
returns text
language sql immutable set search_path = ''
as $$
  select left(coalesce(
    nullif(btrim(_meta ->> 'user_name'), ''),
    nullif(btrim(_meta ->> 'full_name'), ''),
    nullif(btrim(_meta ->> 'name'), ''),
    nullif(split_part(coalesce(_email, ''), '@', 1), ''),
    'Traveller'
  ), 60);
$$;

create function private.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  _avatar text := new.raw_user_meta_data ->> 'avatar_url';
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    private.default_display_name(new.raw_user_meta_data, new.email),
    case when _avatar ~ '^https://' then _avatar end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke all on function private.default_display_name(jsonb, text) from public, anon, authenticated;
revoke all on function private.handle_new_user()                  from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Existing accounts get a profile now (adds rows; changes none).
insert into public.profiles (id, display_name, avatar_url)
select u.id,
       private.default_display_name(u.raw_user_meta_data, u.email),
       case when u.raw_user_meta_data ->> 'avatar_url' ~ '^https://'
            then u.raw_user_meta_data ->> 'avatar_url' end
from auth.users u
on conflict (id) do nothing;

-- New trips: the creator's membership uses their profile name. Still runs in
-- the same transaction as the trip insert, so a trip never exists without its
-- organiser.
create or replace function public.add_owner_as_member()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.trip_members (trip_id, user_id, display_name, role)
  values (
    new.id,
    new.owner_id,
    coalesce(
      (select p.display_name from public.profiles p where p.id = new.owner_id),
      nullif(split_part((select u.email from auth.users u where u.id = new.owner_id), '@', 1), ''),
      'Trip owner'
    ),
    'owner'
  );
  return new;
end;
$$;


-- -----------------------------------------------------------------------------
-- 7. Invites: hashed, expiring, revocable, rate-limited
-- -----------------------------------------------------------------------------

create table public.trip_invites (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.trips (id) on delete cascade,
  -- SHA-256 of the token, hex. The token itself is never stored.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  max_uses   integer check (max_uses is null or max_uses > 0),
  use_count  integer not null default 0 check (use_count >= 0),
  constraint trip_invites_expiry check (expires_at > created_at)
);
create index trip_invites_trip_id_idx on public.trip_invites (trip_id);
alter table public.trip_invites enable row level security;
create trigger trip_invites_keys before update on public.trip_invites
  for each row execute function private.forbid_key_change('trip_id', 'token_hash');

-- Failed lookups per person, for rate limiting. Nobody can read it.
create table public.invite_attempts (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users (id) on delete cascade,
  attempted_at timestamptz not null default now(),
  succeeded    boolean not null
);
create index invite_attempts_user_time_idx on public.invite_attempts (user_id, attempted_at);
alter table public.invite_attempts enable row level security;

create function private.token_hash(_token text)
returns text
language sql immutable set search_path = ''
as $$
  select encode(sha256(convert_to(_token, 'UTF8')), 'hex');
$$;

-- 10 failed invite lookups in 15 minutes blocks further lookups for that
-- person until the window passes. Old rows are pruned as it goes.
create function private.invite_rate_limited(_uid uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.invite_attempts
   where user_id = _uid and attempted_at < now() - interval '1 day';
  return (
    select count(*) from public.invite_attempts a
     where a.user_id = _uid and not a.succeeded
       and a.attempted_at > now() - interval '15 minutes'
  ) >= 10;
end;
$$;

-- The live invite for a token, or nothing. Locks the row for redemption.
create function private.find_invite(_token text)
returns public.trip_invites
language plpgsql security definer set search_path = ''
as $$
declare
  _invite public.trip_invites%rowtype;
begin
  if _token is null or _token !~ '^[0-9a-f]{32}([0-9a-f]{32})?$' then
    return null;
  end if;
  select * into _invite from public.trip_invites i
   where i.token_hash = private.token_hash(_token)
     and i.revoked_at is null
     and i.expires_at > now()
     and (i.max_uses is null or i.use_count < i.max_uses)
   for update;
  return _invite;
end;
$$;

revoke all on function private.token_hash(text)          from public, anon, authenticated;
revoke all on function private.invite_rate_limited(uuid) from public, anon, authenticated;
revoke all on function private.find_invite(text)         from public, anon, authenticated;

-- Existing plaintext tokens become hashed invites valid for 7 more days, so
-- links already sent keep working for now.
insert into public.trip_invites (trip_id, token_hash, created_by, expires_at)
select t.id, private.token_hash(t.invite_token), t.owner_id, now() + interval '7 days'
from public.trips t
where t.invite_token is not null
on conflict (token_hash) do nothing;

-- Create a link (organiser or co-planner). The token is returned ONCE.
create function public.create_invite(_trip_id uuid, _valid_days integer default 7)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  _uid     uuid := private.require(_trip_id, 'manage_invites');
  _token   text;
  _expires timestamptz;
  _id      uuid;
begin
  if _valid_days is null or _valid_days not in (1, 7, 30) then
    raise exception 'Links last 1, 7 or 30 days' using errcode = '22023';
  end if;
  if (select count(*) from public.trip_invites i
       where i.trip_id = _trip_id and i.revoked_at is null and i.expires_at > now()) >= 20 then
    raise exception 'This trip already has 20 active links. Revoke one first.' using errcode = '22023';
  end if;
  -- 244 random bits from two v4 UUIDs.
  _token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  _expires := now() + make_interval(days => _valid_days);
  insert into public.trip_invites (trip_id, token_hash, created_by, expires_at)
  values (_trip_id, private.token_hash(_token), _uid, _expires)
  returning id into _id;
  return jsonb_build_object('id', _id, 'token', _token, 'expires_at', _expires);
end;
$$;

-- Revoke a link (organiser or co-planner). Safe to retry.
create function public.revoke_invite(_invite_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _trip uuid;
begin
  select i.trip_id into _trip from public.trip_invites i where i.id = _invite_id;
  perform private.require(_trip, 'manage_invites');
  update public.trip_invites set revoked_at = now()
   where id = _invite_id and revoked_at is null;
end;
$$;

-- What an invite link points to, before joining: the trip's name and
-- destination, and whether YOU are already on it. Never members, never ids.
-- Returns {"status": "valid" | "invalid" | "rate_limited", ...}.
create function public.preview_invite(_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  _uid    uuid := auth.uid();
  _invite public.trip_invites%rowtype;
  _trip   public.trips%rowtype;
begin
  if _uid is null then
    raise exception 'Please sign in first' using errcode = '42501';
  end if;
  if private.invite_rate_limited(_uid) then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  _invite := private.find_invite(_token);
  if _invite.id is null then
    insert into public.invite_attempts (user_id, succeeded) values (_uid, false);
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into _trip from public.trips t where t.id = _invite.trip_id;
  return jsonb_build_object(
    'status', 'valid',
    'trip_name', _trip.name,
    'destination', _trip.destination,
    'already_member', exists (select 1 from public.trip_members m
                               where m.trip_id = _trip.id and m.user_id = _uid),
    'expires_at', _invite.expires_at
  );
end;
$$;

-- Join with an invite link. Authenticated, one transaction, rate limited and
-- idempotent: joining twice returns "already_member" and uses no extra slot.
-- Returns {"status": "joined" | "already_member" | "invalid" | "rate_limited",
--          "trip_id": ... (only when joined or already a member)}.
create function public.redeem_invite(_token text, _display_name text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  _uid      uuid := auth.uid();
  _invite   public.trip_invites%rowtype;
  _name     text;
  _inserted integer;
begin
  if _uid is null then
    raise exception 'Please sign in first' using errcode = '42501';
  end if;
  if _display_name is not null and char_length(btrim(_display_name)) > 60 then
    raise exception 'Keep your name under 60 characters' using errcode = '22023';
  end if;
  if private.invite_rate_limited(_uid) then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  _invite := private.find_invite(_token);
  if _invite.id is null then
    insert into public.invite_attempts (user_id, succeeded) values (_uid, false);
    return jsonb_build_object('status', 'invalid');
  end if;

  if exists (select 1 from public.trip_members m
              where m.trip_id = _invite.trip_id and m.user_id = _uid) then
    return jsonb_build_object('status', 'already_member', 'trip_id', _invite.trip_id);
  end if;

  _name := left(coalesce(
    nullif(btrim(_display_name), ''),
    (select p.display_name from public.profiles p where p.id = _uid),
    'Traveller'
  ), 60);

  insert into public.trip_members (trip_id, user_id, display_name, role)
  values (_invite.trip_id, _uid, _name, 'member')
  on conflict (trip_id, user_id) do nothing;
  get diagnostics _inserted = row_count;
  if _inserted = 0 then
    return jsonb_build_object('status', 'already_member', 'trip_id', _invite.trip_id);
  end if;

  update public.trip_invites set use_count = use_count + 1 where id = _invite.id;
  insert into public.invite_attempts (user_id, succeeded) values (_uid, true);
  return jsonb_build_object('status', 'joined', 'trip_id', _invite.trip_id);
end;
$$;


-- -----------------------------------------------------------------------------
-- 8. Re-create every RLS policy on the private helpers
-- -----------------------------------------------------------------------------

drop policy trips_select              on public.trips;
drop policy trips_insert              on public.trips;
drop policy trips_update              on public.trips;
drop policy trips_delete              on public.trips;
drop policy trip_members_select       on public.trip_members;
drop policy trip_members_insert       on public.trip_members;
drop policy trip_members_update       on public.trip_members;
drop policy trip_members_delete       on public.trip_members;
drop policy preferences_select        on public.preferences;
drop policy preferences_insert        on public.preferences;
drop policy preferences_update        on public.preferences;
drop policy preferences_delete        on public.preferences;
drop policy stays_select              on public.stays;
drop policy stays_insert              on public.stays;
drop policy stays_update              on public.stays;
drop policy stays_delete              on public.stays;
drop policy itinerary_items_all       on public.itinerary_items;
drop policy expenses_all              on public.expenses;
drop policy expense_splits_all        on public.expense_splits;
drop policy payments_all              on public.payments;
drop policy polls_select              on public.polls;
drop policy poll_options_select       on public.poll_options;
drop policy poll_votes_select         on public.poll_votes;
drop policy nudges_select             on public.nudges;

-- trips: you see trips you are on; you create trips you own; only the
-- organiser edits or deletes, and ownership cannot be handed over.
create policy trips_select on public.trips for select to authenticated
  using (owner_id = (select auth.uid()) or private.is_member(id));
create policy trips_insert on public.trips for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy trips_update on public.trips for update to authenticated
  using (private.can(id, 'edit_trip_dates'))
  with check (owner_id = (select auth.uid()) and private.can(id, 'edit_trip_dates'));
create policy trips_delete on public.trips for delete to authenticated
  using (private.can(id, 'delete_trip'));

-- trip_members: read fellow members. Nobody inserts directly (joining is
-- redeem_invite; the organiser row comes from the trip trigger). You may edit
-- only your own row and never your role. You may leave; the organiser may
-- remove people; the organiser's own row cannot be removed.
create policy trip_members_select on public.trip_members for select to authenticated
  using (private.is_member(trip_id));
create policy trip_members_update on public.trip_members for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and role = private.my_role(trip_id));
create policy trip_members_delete on public.trip_members for delete to authenticated
  using (user_id = (select auth.uid()) or private.can(trip_id, 'remove_member'));

-- preferences: private to their author, only on trips they are on.
create policy preferences_select on public.preferences for select to authenticated
  using (user_id = (select auth.uid()));
create policy preferences_insert on public.preferences for insert to authenticated
  with check (user_id = (select auth.uid()) and private.can(trip_id, 'edit_own_preferences'));
create policy preferences_update on public.preferences for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and private.can(trip_id, 'edit_own_preferences'));
create policy preferences_delete on public.preferences for delete to authenticated
  using (user_id = (select auth.uid()));

-- stays: members read and add; you edit or remove only what you added.
create policy stays_select on public.stays for select to authenticated
  using (private.is_member(trip_id));
create policy stays_insert on public.stays for insert to authenticated
  with check (private.can(trip_id, 'add_stay') and added_by = (select auth.uid()));
create policy stays_update on public.stays for update to authenticated
  using (private.is_member(trip_id) and added_by = (select auth.uid()))
  with check (private.is_member(trip_id) and added_by = (select auth.uid()));
create policy stays_delete on public.stays for delete to authenticated
  using (private.is_member(trip_id) and added_by = (select auth.uid()));

create policy itinerary_items_all on public.itinerary_items for all to authenticated
  using (private.is_member(trip_id))
  with check (private.is_member(trip_id));

create policy expenses_all on public.expenses for all to authenticated
  using (private.is_member(trip_id))
  with check (private.is_member(trip_id) and private.is_co_member(trip_id, paid_by));

create policy expense_splits_all on public.expense_splits for all to authenticated
  using (private.is_member(private.expense_trip(expense_id)))
  with check (private.is_co_member(private.expense_trip(expense_id), user_id));

create policy payments_all on public.payments for all to authenticated
  using (private.is_member(trip_id))
  with check (private.is_co_member(trip_id, from_user) and private.is_co_member(trip_id, to_user));

create policy polls_select on public.polls for select to authenticated
  using (private.is_member(trip_id));
create policy poll_options_select on public.poll_options for select to authenticated
  using (private.is_member(trip_id));
create policy poll_votes_select on public.poll_votes for select to authenticated
  using (private.is_member(trip_id));
create policy nudges_select on public.nudges for select to authenticated
  using ((to_user = (select auth.uid()) or from_user = (select auth.uid()))
         and private.is_member(trip_id));

-- profiles: yours, and people you share a trip with. You edit your name only.
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.shares_trip_with(id));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- trip_invites: organiser and co-planners see the trip's links (never the
-- hash: see the column grants below).
create policy trip_invites_select on public.trip_invites for select to authenticated
  using (private.can(trip_id, 'manage_invites'));


-- -----------------------------------------------------------------------------
-- 9. Re-create the Decide functions (006) and the answered-status function
--    (002) on the permission matrix. Same names, arguments and messages.
-- -----------------------------------------------------------------------------

create or replace function public.trip_response_status(_trip_id uuid)
returns table (user_id uuid, display_name text, role text, has_answered boolean)
language sql stable security definer set search_path = ''
as $$
  select m.user_id, m.display_name, m.role,
         exists (select 1 from public.preferences p
                  where p.trip_id = m.trip_id and p.user_id = m.user_id
                    and p.submitted_at is not null)
  from public.trip_members m
  where m.trip_id = _trip_id and private.is_member(_trip_id)
  order by (m.role = 'owner') desc, m.display_name;
$$;

create or replace function public.rename_trip(_trip_id uuid, _name text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _uid   uuid := private.require(_trip_id, 'rename_trip');
  _clean text := btrim(coalesce(_name, ''));
begin
  if char_length(_clean) < 1 or char_length(_clean) > 80 then
    raise exception 'Trip names are 1 to 80 characters' using errcode = '22023';
  end if;
  update public.trips set name = _clean where id = _trip_id;
end;
$$;

create or replace function public.set_member_role(_trip_id uuid, _user_id uuid, _role text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := private.require(_trip_id, 'manage_roles');
begin
  if _role is null or _role not in ('co_planner', 'member') then
    raise exception 'Choose co-planner or traveller' using errcode = '22023';
  end if;
  if _user_id = _uid then
    raise exception 'You are the organiser of this trip' using errcode = '22023';
  end if;
  update public.trip_members set role = _role
   where trip_id = _trip_id and user_id = _user_id and role <> 'owner';
  if not found then
    raise exception 'That person is not on this trip' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.set_rsvp(_trip_id uuid, _rsvp text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := private.require(_trip_id, 'rsvp');
begin
  if _rsvp is null or _rsvp not in ('in', 'maybe', 'not_yet') then
    raise exception 'Choose In, Maybe or Not yet' using errcode = '22023';
  end if;
  update public.trip_members set rsvp = _rsvp
   where trip_id = _trip_id and user_id = _uid;
  if _rsvp <> 'not_yet' then
    delete from public.nudges
     where trip_id = _trip_id and to_user = _uid and topic = 'rsvp';
  end if;
end;
$$;

create or replace function public.add_poll_option(
  _trip_id    uuid,
  _kind       text,
  _label      text default null,
  _start_date date default null,
  _end_date   date default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  _uid    uuid := private.require(_trip_id, 'suggest_option');
  _poll   uuid;
  _status text;
  _clean  text;
  _id     uuid;
begin
  if _kind is null or _kind not in ('dates', 'destination') then
    raise exception 'Unknown vote' using errcode = '22023';
  end if;

  if _kind = 'dates' then
    if _start_date is null or _end_date is null then
      raise exception 'Enter a start date and an end date' using errcode = '22023';
    end if;
    if _end_date <= _start_date then
      raise exception 'The end date must be after the start date' using errcode = '22023';
    end if;
    if _end_date - _start_date > 60 then
      raise exception 'Trips can be at most 60 nights' using errcode = '22023';
    end if;
    if _start_date < current_date then
      raise exception 'Those dates are in the past' using errcode = '22023';
    end if;
    _clean := null;
  else
    _clean := btrim(coalesce(_label, ''));
    if char_length(_clean) < 1 or char_length(_clean) > 80 then
      raise exception 'Destinations are 1 to 80 characters' using errcode = '22023';
    end if;
    _start_date := null;
    _end_date := null;
  end if;

  insert into public.polls (trip_id, kind, created_by)
  values (_trip_id, _kind, _uid)
  on conflict (trip_id, kind) do nothing;

  select p.id, p.status into _poll, _status
    from public.polls p
   where p.trip_id = _trip_id and p.kind = _kind
   for update;

  if _status = 'settled' then
    raise exception 'This vote is settled. The organiser or a co-planner can reopen it.'
      using errcode = '22023';
  end if;

  select o.id into _id from public.poll_options o
   where o.poll_id = _poll
     and ((_kind = 'destination' and lower(o.label) = lower(_clean))
          or (_kind = 'dates' and o.start_date = _start_date and o.end_date = _end_date));
  if _id is not null then
    return _id;
  end if;

  if (select count(*) from public.poll_options o where o.poll_id = _poll) >= 12 then
    raise exception 'A vote can have at most 12 options' using errcode = '22023';
  end if;

  insert into public.poll_options (poll_id, trip_id, label, start_date, end_date, created_by)
  values (_poll, _trip_id, _clean, _start_date, _end_date, _uid)
  returning id into _id;
  return _id;
end;
$$;

create or replace function public.remove_poll_option(_option_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _trip   uuid;
  _poll   uuid;
  _author uuid;
  _status text;
  _uid    uuid;
begin
  select o.trip_id, o.poll_id, o.created_by into _trip, _poll, _author
    from public.poll_options o where o.id = _option_id;
  _uid := private.require(_trip, 'read');

  select p.status into _status from public.polls p where p.id = _poll for update;
  if _status <> 'open' then
    raise exception 'This vote is settled. Reopen it first.' using errcode = '22023';
  end if;
  if _author is distinct from _uid then
    perform private.require(_trip, 'remove_any_option');
  end if;
  delete from public.poll_options where id = _option_id;
end;
$$;

create or replace function public.cast_vote(_option_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _trip   uuid;
  _poll   uuid;
  _kind   text;
  _status text;
  _uid    uuid;
begin
  select o.trip_id, o.poll_id into _trip, _poll
    from public.poll_options o where o.id = _option_id;
  _uid := private.require(_trip, 'vote');

  select p.kind, p.status into _kind, _status
    from public.polls p where p.id = _poll for update;
  if _status <> 'open' then
    raise exception 'This vote is already settled' using errcode = '22023';
  end if;

  insert into public.poll_votes (poll_id, option_id, trip_id, user_id)
  values (_poll, _option_id, _trip, _uid)
  on conflict (poll_id, user_id)
    do update set option_id = excluded.option_id, voted_at = now();

  delete from public.nudges
   where trip_id = _trip and to_user = _uid and topic = _kind;
end;
$$;

create or replace function public.settle_poll(_poll_id uuid, _option_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _trip    uuid;
  _kind    text;
  _status  text;
  _settled uuid;
  _opt     public.poll_options%rowtype;
  _uid     uuid;
begin
  select p.trip_id, p.kind, p.status, p.settled_option_id
    into _trip, _kind, _status, _settled
    from public.polls p where p.id = _poll_id for update;
  _uid := private.require(_trip, 'settle_vote');

  select * into _opt from public.poll_options o
   where o.id = _option_id and o.poll_id = _poll_id;
  if _opt.id is null then
    raise exception 'That option is not part of this vote' using errcode = 'P0002';
  end if;

  if _status = 'settled' then
    if _settled = _option_id then
      return;
    end if;
    raise exception 'This vote is already settled. Reopen it first.' using errcode = '22023';
  end if;

  update public.polls
     set status = 'settled', settled_option_id = _option_id, settled_at = now()
   where id = _poll_id;

  if _kind = 'dates' then
    update public.trips set start_date = _opt.start_date, end_date = _opt.end_date where id = _trip;
  else
    update public.trips set destination = _opt.label where id = _trip;
  end if;

  delete from public.nudges where trip_id = _trip and topic = _kind;
end;
$$;

create or replace function public.reopen_poll(_poll_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _trip uuid;
begin
  select p.trip_id into _trip from public.polls p where p.id = _poll_id for update;
  perform private.require(_trip, 'reopen_vote');
  update public.polls
     set status = 'open', settled_option_id = null, settled_at = null
   where id = _poll_id;
end;
$$;

create or replace function public.nudge_member(_trip_id uuid, _to_user uuid, _topic text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  _uid     uuid := private.require(_trip_id, 'nudge');
  _pending boolean;
  _last    timestamptz;
begin
  if _topic is null or _topic not in ('rsvp', 'dates', 'destination') then
    raise exception 'Unknown reminder' using errcode = '22023';
  end if;
  if _to_user = _uid then
    raise exception 'You cannot nudge yourself' using errcode = '22023';
  end if;
  if not exists (select 1 from public.trip_members m
                  where m.trip_id = _trip_id and m.user_id = _to_user) then
    raise exception 'That person is not on this trip' using errcode = 'P0002';
  end if;

  if _topic = 'rsvp' then
    select m.rsvp = 'not_yet' into _pending
      from public.trip_members m
     where m.trip_id = _trip_id and m.user_id = _to_user;
  else
    select exists (
      select 1 from public.polls p
       where p.trip_id = _trip_id and p.kind = _topic and p.status = 'open'
         and exists (select 1 from public.poll_options o where o.poll_id = p.id)
         and not exists (select 1 from public.poll_votes v
                          where v.poll_id = p.id and v.user_id = _to_user)
    ) into _pending;
  end if;
  if not coalesce(_pending, false) then
    raise exception 'They have already answered' using errcode = '22023';
  end if;

  select n.created_at into _last from public.nudges n
   where n.trip_id = _trip_id and n.topic = _topic and n.to_user = _to_user;
  if _last is not null and _last > now() - interval '12 hours' then
    return 'recent';
  end if;

  insert into public.nudges (trip_id, topic, from_user, to_user)
  values (_trip_id, _topic, _uid, _to_user)
  on conflict (trip_id, topic, to_user)
    do update set from_user = excluded.from_user, created_at = now();
  return 'sent';
end;
$$;


-- -----------------------------------------------------------------------------
-- 10. Health check: says "ok" and nothing else
-- -----------------------------------------------------------------------------

create function public.health_check()
returns text
language sql stable set search_path = ''
as $$ select 'ok'::text; $$;


-- -----------------------------------------------------------------------------
-- 11. Explicit grants (everything else is denied)
-- -----------------------------------------------------------------------------

-- Functions: nothing is executable unless listed here.
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.health_check()                                   to anon, authenticated;
grant execute on function public.trip_response_status(uuid)                       to authenticated;
grant execute on function public.rename_trip(uuid, text)                          to authenticated;
grant execute on function public.set_member_role(uuid, uuid, text)                to authenticated;
grant execute on function public.set_rsvp(uuid, text)                             to authenticated;
grant execute on function public.add_poll_option(uuid, text, text, date, date)    to authenticated;
grant execute on function public.remove_poll_option(uuid)                         to authenticated;
grant execute on function public.cast_vote(uuid)                                  to authenticated;
grant execute on function public.settle_poll(uuid, uuid)                          to authenticated;
grant execute on function public.reopen_poll(uuid)                                to authenticated;
grant execute on function public.nudge_member(uuid, uuid, text)                   to authenticated;
grant execute on function public.create_invite(uuid, integer)                     to authenticated;
grant execute on function public.revoke_invite(uuid)                              to authenticated;
grant execute on function public.preview_invite(text)                             to authenticated;
grant execute on function public.redeem_invite(text, text)                        to authenticated;

-- Tables: signed-out visitors get nothing; signed-in users get only these.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select (id, name, destination, start_date, end_date, currency, owner_id, created_at),
      insert (name, destination, start_date, end_date, currency),
      update (name, destination, start_date, end_date, currency),
      delete
  on public.trips to authenticated;

grant select, delete on public.trip_members to authenticated;
grant update (display_name, rsvp, upi_vpa) on public.trip_members to authenticated;

grant select, insert, update, delete on public.preferences     to authenticated;
grant select, insert, update, delete on public.stays           to authenticated;
grant select, insert, update, delete on public.itinerary_items to authenticated;
grant select, insert, update, delete on public.expenses        to authenticated;
grant select, insert, update, delete on public.expense_splits  to authenticated;
grant select, insert, update, delete on public.payments        to authenticated;

grant select on public.polls, public.poll_options, public.poll_votes, public.nudges to authenticated;

grant select (id, display_name, avatar_url, created_at) on public.profiles to authenticated;
grant update (display_name)                             on public.profiles to authenticated;

grant select (id, trip_id, created_by, created_at, expires_at, revoked_at, max_uses, use_count)
  on public.trip_invites to authenticated;

-- schema_versions and invite_attempts: no grants (read by functions only).
