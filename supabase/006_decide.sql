-- =============================================================================
-- Group Trip Planner: 01 Trip home + 02 Decide
-- (run AFTER schema.sql, 002, 003, 004 and 005)
--
-- HOW TO USE: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Run it once. It only ADDS things: no table, column or row is dropped. The
-- one constraint it replaces (trip_members.role) is widened, so every
-- existing row stays valid.
--
-- What it adds
--   * Roles: organiser ('owner'), co-planner ('co_planner'), traveller ('member').
--   * RSVP per member: 'in', 'maybe' or 'not_yet'.
--   * Two group votes per trip: dates and destination, with options and votes.
--   * In-app nudges for people who have not answered yet.
--
-- Security model
--   * Members can READ the new tables for their own trips (RLS).
--   * Nobody can write to the new tables directly: there are no insert/update/
--     delete grants. Every change goes through the functions below, which
--     check who you are, that you belong to the trip, your role, and the input,
--     and run as one transaction.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Roles and RSVP on trip_members
-- -----------------------------------------------------------------------------

alter table public.trip_members
  drop constraint trip_members_role_check;

alter table public.trip_members
  add constraint trip_members_role_check
    check (role in ('owner', 'co_planner', 'member')),
  add column rsvp text not null default 'not_yet'
    check (rsvp in ('in', 'maybe', 'not_yet')),
  add column rsvp_updated_at timestamptz;

-- Organiser or co-planner?
create function public.can_plan(_trip_id uuid, _user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.trip_members m
    where m.trip_id = _trip_id
      and m.user_id = _user_id
      and m.role in ('owner', 'co_planner')
  );
$$;

-- Guard rails for direct updates to trip_members (the existing RLS policy lets
-- you edit your own row and lets the organiser edit any row):
--   * only you can change your own RSVP, never the organiser on your behalf;
--   * the 'owner' role always belongs to exactly the trip's creator;
--   * a member row cannot be moved to another trip or person.
create function public.trip_members_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  _owner uuid;
begin
  if new.trip_id <> old.trip_id or new.user_id <> old.user_id then
    raise exception 'A member cannot be moved to another trip or person'
      using errcode = '42501';
  end if;

  if new.rsvp is distinct from old.rsvp then
    if new.user_id is distinct from auth.uid() then
      raise exception 'Only you can change your RSVP' using errcode = '42501';
    end if;
    new.rsvp_updated_at := now();
  end if;

  if new.role is distinct from old.role then
    select t.owner_id into _owner from public.trips t where t.id = new.trip_id;
    if (new.role = 'owner') <> (new.user_id = _owner) then
      raise exception 'The organiser role belongs to whoever created the trip'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.trip_members_guard() from public, anon, authenticated;

create trigger trip_members_guard
  before update on public.trip_members
  for each row execute function public.trip_members_guard();


-- -----------------------------------------------------------------------------
-- 2. Group votes: dates and destination
-- -----------------------------------------------------------------------------

create table public.polls (
  id                uuid primary key default gen_random_uuid(),
  trip_id           uuid not null references public.trips (id) on delete cascade,
  kind              text not null check (kind in ('dates', 'destination')),
  status            text not null default 'open' check (status in ('open', 'settled')),
  settled_option_id uuid,
  settled_at        timestamptz,
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  -- One dates vote and one destination vote per trip.
  unique (trip_id, kind),
  unique (id, trip_id),
  constraint polls_settled_consistent
    check ((status = 'settled') = (settled_option_id is not null))
);

create table public.poll_options (
  id         uuid primary key default gen_random_uuid(),
  poll_id    uuid not null,
  trip_id    uuid not null,
  label      text,       -- destination options
  start_date date,       -- dates options
  end_date   date,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (poll_id, trip_id)
    references public.polls (id, trip_id) on delete cascade,
  unique (id, poll_id),
  constraint poll_options_one_shape check (
    (label is not null and start_date is null and end_date is null)
    or (label is null and start_date is not null and end_date is not null
        and end_date > start_date)
  ),
  constraint poll_options_label_length
    check (label is null or char_length(label) between 1 and 80)
);

-- The same suggestion twice (e.g. a double-tapped button) is one option.
create unique index poll_options_label_unique
  on public.poll_options (poll_id, lower(label)) where label is not null;
create unique index poll_options_dates_unique
  on public.poll_options (poll_id, start_date, end_date) where start_date is not null;

-- The settled option must belong to the same poll.
alter table public.polls
  add constraint polls_settled_option_fk
    foreign key (settled_option_id, id)
    references public.poll_options (id, poll_id)
    on delete set null (settled_option_id);

create table public.poll_votes (
  poll_id   uuid not null,
  option_id uuid not null,
  trip_id   uuid not null,
  user_id   uuid not null,
  voted_at  timestamptz not null default now(),
  -- One vote per person per poll; voting again replaces your choice.
  primary key (poll_id, user_id),
  foreign key (option_id, poll_id)
    references public.poll_options (id, poll_id) on delete cascade,
  foreign key (poll_id, trip_id)
    references public.polls (id, trip_id) on delete cascade,
  -- Only members vote; leaving the trip removes your votes.
  foreign key (trip_id, user_id)
    references public.trip_members (trip_id, user_id) on delete cascade
);

create index poll_options_poll_id_idx on public.poll_options (poll_id);
create index poll_votes_trip_id_idx   on public.poll_votes (trip_id);


-- -----------------------------------------------------------------------------
-- 3. Nudges: an in-app reminder to someone who has not answered yet
-- -----------------------------------------------------------------------------

create table public.nudges (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.trips (id) on delete cascade,
  topic      text not null check (topic in ('rsvp', 'dates', 'destination')),
  from_user  uuid not null,
  to_user    uuid not null,
  created_at timestamptz not null default now(),
  constraint nudges_not_self check (from_user <> to_user),
  unique (trip_id, topic, to_user),
  foreign key (trip_id, from_user)
    references public.trip_members (trip_id, user_id) on delete cascade,
  foreign key (trip_id, to_user)
    references public.trip_members (trip_id, user_id) on delete cascade
);


-- -----------------------------------------------------------------------------
-- 4. Row-level security: members read; nobody writes directly
-- -----------------------------------------------------------------------------

alter table public.polls        enable row level security;
alter table public.poll_options enable row level security;
alter table public.poll_votes   enable row level security;
alter table public.nudges       enable row level security;

revoke all on public.polls, public.poll_options, public.poll_votes, public.nudges
  from anon, authenticated;
grant select on public.polls, public.poll_options, public.poll_votes, public.nudges
  to authenticated;

create policy polls_select on public.polls
  for select to authenticated
  using (public.is_trip_member(trip_id, (select auth.uid())));

create policy poll_options_select on public.poll_options
  for select to authenticated
  using (public.is_trip_member(trip_id, (select auth.uid())));

create policy poll_votes_select on public.poll_votes
  for select to authenticated
  using (public.is_trip_member(trip_id, (select auth.uid())));

-- You see nudges you sent or received, on trips you still belong to.
create policy nudges_select on public.nudges
  for select to authenticated
  using ((to_user = (select auth.uid()) or from_user = (select auth.uid()))
         and public.is_trip_member(trip_id, (select auth.uid())));


-- -----------------------------------------------------------------------------
-- 5. Functions: the only way to change Decide data
--
-- Errors use three codes the app turns into messages:
--   42501 not allowed, 22023 invalid input, P0002 not found.
-- -----------------------------------------------------------------------------

-- Internal: the signed-in user, who must belong to the trip.
create function public.require_trip_member(_trip_id uuid)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
begin
  if _uid is null then
    raise exception 'Please sign in first' using errcode = '42501';
  end if;
  if _trip_id is null or not public.is_trip_member(_trip_id, _uid) then
    raise exception 'You are not a member of this trip' using errcode = '42501';
  end if;
  return _uid;
end;
$$;

revoke execute on function public.require_trip_member(uuid) from public, anon, authenticated;


-- Rename the trip (organiser or co-planner).
create function public.rename_trip(_trip_id uuid, _name text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _uid   uuid := public.require_trip_member(_trip_id);
  _clean text := btrim(coalesce(_name, ''));
begin
  if not public.can_plan(_trip_id, _uid) then
    raise exception 'Only the organiser or a co-planner can rename the trip'
      using errcode = '42501';
  end if;
  if char_length(_clean) < 1 or char_length(_clean) > 80 then
    raise exception 'Trip names are 1 to 80 characters' using errcode = '22023';
  end if;
  update public.trips set name = _clean where id = _trip_id;
end;
$$;


-- Make someone a co-planner or a traveller (organiser only).
create function public.set_member_role(_trip_id uuid, _user_id uuid, _role text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := public.require_trip_member(_trip_id);
begin
  if not public.is_trip_owner(_trip_id, _uid) then
    raise exception 'Only the organiser can change roles' using errcode = '42501';
  end if;
  if _role is null or _role not in ('co_planner', 'member') then
    raise exception 'Choose co-planner or traveller' using errcode = '22023';
  end if;
  if _user_id = _uid then
    raise exception 'You are the organiser of this trip' using errcode = '22023';
  end if;
  update public.trip_members
     set role = _role
   where trip_id = _trip_id and user_id = _user_id and role <> 'owner';
  if not found then
    raise exception 'That person is not on this trip' using errcode = 'P0002';
  end if;
end;
$$;


-- Answer "Are you coming?" for yourself.
create function public.set_rsvp(_trip_id uuid, _rsvp text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := public.require_trip_member(_trip_id);
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


-- Suggest an option for the dates or destination vote (any member).
-- The vote itself is created with its first option. Safe to retry: the same
-- suggestion twice returns the existing option.
create function public.add_poll_option(
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
  _uid    uuid := public.require_trip_member(_trip_id);
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

  -- Same suggestion again? Return it instead of failing.
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


-- Remove an option (whoever suggested it, or the organiser / a co-planner),
-- only while the vote is open. Votes for it are removed with it.
create function public.remove_poll_option(_option_id uuid)
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
  _uid := public.require_trip_member(_trip);

  select p.status into _status from public.polls p where p.id = _poll for update;
  if _status <> 'open' then
    raise exception 'This vote is settled. Reopen it first.' using errcode = '22023';
  end if;
  if _author is distinct from _uid and not public.can_plan(_trip, _uid) then
    raise exception 'Only whoever suggested it, the organiser or a co-planner can remove it'
      using errcode = '42501';
  end if;
  delete from public.poll_options where id = _option_id;
end;
$$;


-- Vote for an option. Voting again replaces your choice. Safe to retry.
create function public.cast_vote(_option_id uuid)
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
  _uid := public.require_trip_member(_trip);

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


-- Settle a vote on one option (organiser or co-planner). Writes the result to
-- the trip (dates or destination) in the same transaction. Safe to retry.
create function public.settle_poll(_poll_id uuid, _option_id uuid)
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
  _uid := public.require_trip_member(_trip);

  if not public.can_plan(_trip, _uid) then
    raise exception 'Only the organiser or a co-planner can settle a vote'
      using errcode = '42501';
  end if;

  select * into _opt from public.poll_options o
   where o.id = _option_id and o.poll_id = _poll_id;
  if _opt.id is null then
    raise exception 'That option is not part of this vote' using errcode = 'P0002';
  end if;

  if _status = 'settled' then
    if _settled = _option_id then
      return; -- already settled on this option
    end if;
    raise exception 'This vote is already settled. Reopen it first.' using errcode = '22023';
  end if;

  update public.polls
     set status = 'settled', settled_option_id = _option_id, settled_at = now()
   where id = _poll_id;

  if _kind = 'dates' then
    update public.trips
       set start_date = _opt.start_date, end_date = _opt.end_date
     where id = _trip;
  else
    update public.trips set destination = _opt.label where id = _trip;
  end if;

  delete from public.nudges where trip_id = _trip and topic = _kind;
end;
$$;


-- Reopen a settled vote (organiser or co-planner). The trip keeps its current
-- dates/destination until the vote is settled again.
create function public.reopen_poll(_poll_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _trip uuid;
  _uid  uuid;
begin
  select p.trip_id into _trip from public.polls p where p.id = _poll_id for update;
  _uid := public.require_trip_member(_trip);
  if not public.can_plan(_trip, _uid) then
    raise exception 'Only the organiser or a co-planner can reopen a vote'
      using errcode = '42501';
  end if;
  update public.polls
     set status = 'open', settled_option_id = null, settled_at = null
   where id = _poll_id;
end;
$$;


-- Nudge someone who has not answered yet. In-app only: nothing is emailed or
-- messaged. At most one nudge per person per topic every 12 hours.
-- Returns 'sent', or 'recent' when they were nudged in the last 12 hours.
create function public.nudge_member(_trip_id uuid, _to_user uuid, _topic text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  _uid     uuid := public.require_trip_member(_trip_id);
  _pending boolean;
  _last    timestamptz;
begin
  if _topic is null or _topic not in ('rsvp', 'dates', 'destination') then
    raise exception 'Unknown reminder' using errcode = '22023';
  end if;
  if _to_user = _uid then
    raise exception 'You cannot nudge yourself' using errcode = '22023';
  end if;
  if not public.is_trip_member(_trip_id, _to_user) then
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


-- Only signed-in users may call these. Each one re-checks membership and role.
revoke execute on function public.can_plan(uuid, uuid)                           from public, anon;
revoke execute on function public.rename_trip(uuid, text)                        from public, anon;
revoke execute on function public.set_member_role(uuid, uuid, text)              from public, anon;
revoke execute on function public.set_rsvp(uuid, text)                           from public, anon;
revoke execute on function public.add_poll_option(uuid, text, text, date, date)  from public, anon;
revoke execute on function public.remove_poll_option(uuid)                       from public, anon;
revoke execute on function public.cast_vote(uuid)                                from public, anon;
revoke execute on function public.settle_poll(uuid, uuid)                        from public, anon;
revoke execute on function public.reopen_poll(uuid)                              from public, anon;
revoke execute on function public.nudge_member(uuid, uuid, text)                 from public, anon;
grant  execute on function public.can_plan(uuid, uuid)                           to authenticated;
grant  execute on function public.rename_trip(uuid, text)                        to authenticated;
grant  execute on function public.set_member_role(uuid, uuid, text)              to authenticated;
grant  execute on function public.set_rsvp(uuid, text)                           to authenticated;
grant  execute on function public.add_poll_option(uuid, text, text, date, date)  to authenticated;
grant  execute on function public.remove_poll_option(uuid)                       to authenticated;
grant  execute on function public.cast_vote(uuid)                                to authenticated;
grant  execute on function public.settle_poll(uuid, uuid)                        to authenticated;
grant  execute on function public.reopen_poll(uuid)                              to authenticated;
grant  execute on function public.nudge_member(uuid, uuid, text)                 to authenticated;
