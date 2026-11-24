-- =============================================================================
-- Group Trip Planner: 008 trip timezone/currency + private budget (PRD 01-03)
-- (run AFTER schema.sql and 002 to 007)
--
-- HOW TO USE: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Run it once. It deletes no rows and drops no tables or columns.
--
-- Review list:
--   1. trips.timezone (IANA name, required, validated). Existing trips get
--      'Asia/Kolkata'. Trip dates stay date-only (start_date/end_date are
--      `date`); every instant in the schema is `timestamptz`.
--   2. trips.currency: required (default removed), one of a fixed list of
--      2-decimal currencies, and fixed after creation (budgets and prices
--      are stored in its minor units).
--   3. preferences budget: integer minor units of the trip currency, both or
--      neither, 0 <= min <= max <= cap, scope fixed to "total per person for
--      the whole trip, including flights" (budget_scope column).
--   4. Revisions allowed but throttled (6 per person per trip per 24 h), which
--      slows anyone trying to probe others' ranges by repeatedly editing
--      their own.
--   5. trip_budget_band(trip): the ONLY way to learn anything about other
--      people's budgets. Members only; no cohort filter; releases nothing
--      below 3 respondents; otherwise only a rounded band or "no overlap".
--   6. Planning bounds: explicit bounds the group agreed, recorded by the
--      organiser or a co-planner, used while there are fewer than 3 answers.
--   7. preference_progress(trip): counts only. trip_response_status (which
--      named who had answered) loses EXECUTE.
--   8. preferences is kept out of Supabase Realtime.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1-2. Trip timezone and currency
-- -----------------------------------------------------------------------------

alter table public.trips
  add column timezone text not null default 'Asia/Kolkata';
-- From now on every new trip must say its timezone and currency.
alter table public.trips alter column timezone drop default;
alter table public.trips alter column currency drop default;

alter table public.trips
  add constraint trips_currency_supported
    check (currency in ('INR', 'USD', 'EUR', 'GBP', 'SGD', 'AED', 'AUD', 'CAD', 'THB', 'MYR', 'LKR', 'NPR'));

create function private.check_trip_timezone()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  -- A region name like Asia/Kolkata (or UTC), never an abbreviation or offset.
  if new.timezone is null
     or new.timezone !~ '^([A-Za-z_]+(/[A-Za-z0-9_+-]+)+|UTC)$' then
    raise exception 'Choose a real time zone, like Asia/Kolkata' using errcode = '22023';
  end if;
  -- Postgres must know it (looks up just this one zone).
  begin
    perform now() at time zone new.timezone;
  exception when others then
    raise exception 'Choose a real time zone, like Asia/Kolkata' using errcode = '22023';
  end;
  return new;
end;
$$;
revoke all on function private.check_trip_timezone() from public, anon, authenticated;

create trigger trips_timezone_valid
  before insert or update of timezone on public.trips
  for each row execute function private.check_trip_timezone();

-- Budgets and prices are in the currency's minor units: it cannot change.
create trigger trips_currency_fixed
  before update on public.trips
  for each row execute function private.forbid_key_change('currency');


-- -----------------------------------------------------------------------------
-- 3. Budget ranges: minor units, explicit scope, validated
-- -----------------------------------------------------------------------------

comment on column public.preferences.budget_min_paise is
  'Minimum budget in MINOR units of the trip currency (paise for INR). Total per person for the whole trip, including flights. Private to its owner.';
comment on column public.preferences.budget_max_paise is
  'Maximum budget in MINOR units of the trip currency. Total per person for the whole trip, including flights. Private to its owner.';

alter table public.preferences
  add column budget_scope text not null default 'total_per_person_incl_flights'
    check (budget_scope = 'total_per_person_incl_flights'),
  add constraint preferences_budget_both_or_neither
    check ((budget_min_paise is null) = (budget_max_paise is null)),
  add constraint preferences_budget_cap
    check (budget_max_paise is null or budget_max_paise <= 100000000000);


-- -----------------------------------------------------------------------------
-- 4. Revision throttle (nobody can read this table)
-- -----------------------------------------------------------------------------

create table public.budget_revisions (
  id         bigint generated always as identity primary key,
  trip_id    uuid not null references public.trips (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  changed_at timestamptz not null default now()
);
create index budget_revisions_lookup_idx on public.budget_revisions (trip_id, user_id, changed_at);
alter table public.budget_revisions enable row level security;

create function private.throttle_budget_changes()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.budget_min_paise is not distinct from old.budget_min_paise
     and new.budget_max_paise is not distinct from old.budget_max_paise then
    return null; -- budget unchanged (e.g. only pace edited)
  end if;
  if tg_op = 'INSERT' and new.budget_min_paise is null then
    return null;
  end if;
  delete from public.budget_revisions
   where trip_id = new.trip_id and user_id = new.user_id
     and changed_at < now() - interval '1 day';
  if (select count(*) from public.budget_revisions r
       where r.trip_id = new.trip_id and r.user_id = new.user_id) >= 6 then
    raise exception 'You can change your budget range up to 6 times a day. Try again tomorrow.'
      using errcode = '22023';
  end if;
  insert into public.budget_revisions (trip_id, user_id) values (new.trip_id, new.user_id);
  return null;
end;
$$;
revoke all on function private.throttle_budget_changes() from public, anon, authenticated;

-- AFTER, so an upsert counts once: BEFORE INSERT triggers also fire for an
-- upsert that ends up updating.
create trigger preferences_budget_throttle
  after insert or update on public.preferences
  for each row execute function private.throttle_budget_changes();


-- -----------------------------------------------------------------------------
-- 5-6. Planning bounds (explicit, group-agreed) and the permission for them
-- -----------------------------------------------------------------------------

alter table public.trips
  add column planning_budget_min_minor bigint,
  add column planning_budget_max_minor bigint,
  add column planning_bounds_set_by    uuid references auth.users (id) on delete set null,
  add column planning_bounds_set_at    timestamptz,
  add constraint trips_planning_bounds_valid check (
    (planning_budget_min_minor is null) = (planning_budget_max_minor is null)
    and (planning_budget_min_minor is null
         or (planning_budget_min_minor >= 0
             and planning_budget_max_minor >= planning_budget_min_minor
             and planning_budget_max_minor <= 100000000000))
  );

create or replace function private.role_allows(_role text, _action text)
returns boolean
language sql immutable set search_path = ''
as $$
  select case
    when _role is null then false
    when _action in ('read', 'rsvp', 'suggest_option', 'vote', 'nudge',
                     'edit_own_preferences', 'add_stay', 'leave')
      then _role in ('owner', 'co_planner', 'member')
    when _action in ('rename_trip', 'settle_vote', 'reopen_vote',
                     'remove_any_option', 'manage_invites', 'set_planning_bounds')
      then _role in ('owner', 'co_planner')
    when _action in ('manage_roles', 'remove_member', 'edit_trip_dates', 'delete_trip')
      then _role = 'owner'
    else false
  end;
$$;

create or replace function private.require(_trip_id uuid, _action text)
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
      when 'rename_trip'         then 'Only the organiser or a co-planner can rename the trip'
      when 'settle_vote'         then 'Only the organiser or a co-planner can settle a vote'
      when 'reopen_vote'         then 'Only the organiser or a co-planner can reopen a vote'
      when 'remove_any_option'   then 'Only whoever suggested it, the organiser or a co-planner can remove it'
      when 'manage_invites'      then 'Only the organiser or a co-planner can manage invite links'
      when 'set_planning_bounds' then 'Only the organiser or a co-planner can record planning bounds'
      when 'manage_roles'        then 'Only the organiser can change roles'
      when 'remove_member'       then 'Only the organiser can remove people'
      when 'edit_trip_dates'     then 'Only the organiser can change the trip dates'
      when 'delete_trip'         then 'Only the organiser can delete the trip'
      else 'You are not allowed to do that'
    end using errcode = '42501';
  end if;
  return _uid;
end;
$$;

-- Record (or clear, with nulls) the bounds the group agreed to plan within.
-- The caller must confirm the group agreed; the trip shows who set them.
create function public.set_planning_bounds(
  _trip_id      uuid,
  _min_minor    bigint,
  _max_minor    bigint,
  _group_agreed boolean
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := private.require(_trip_id, 'set_planning_bounds');
begin
  if (_min_minor is null) <> (_max_minor is null) then
    raise exception 'Enter both a minimum and a maximum, or clear both' using errcode = '22023';
  end if;
  if _min_minor is not null then
    if coalesce(_group_agreed, false) is false then
      raise exception 'Confirm the group agreed to these bounds' using errcode = '22023';
    end if;
    if _min_minor < 0 or _max_minor < _min_minor or _max_minor > 100000000000 then
      raise exception 'The minimum must be at most the maximum' using errcode = '22023';
    end if;
  end if;
  update public.trips
     set planning_budget_min_minor = _min_minor,
         planning_budget_max_minor = _max_minor,
         planning_bounds_set_by = case when _min_minor is null then null else _uid end,
         planning_bounds_set_at = case when _min_minor is null then null else now() end
   where id = _trip_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- 5. The group comfort band (reviewed: this is the only aggregate)
--
-- * Caller must be a member of the trip. The only argument is the trip, so
--   nobody can choose a sub-group or ask "everyone except X".
-- * Cohort: current members with a complete range. Leaving the trip removes
--   your range from the cohort (membership cascade).
-- * Fewer than 3 respondents: only the count is returned.
-- * Otherwise: "no_overlap", or the band [highest minimum, lowest maximum]
--   rounded OUTWARD to the step (INR 1,000; other currencies 50), so the
--   exact edge values are not released.
-- * Never returns user ids, names or individual values; never logs.
-- -----------------------------------------------------------------------------

create function public.trip_budget_band(_trip_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  _uid      uuid := private.require(_trip_id, 'read');
  _currency text;
  _n        integer;
  _low      bigint;
  _high     bigint;
  _step     bigint;
begin
  select t.currency into _currency from public.trips t where t.id = _trip_id;

  select count(*), max(p.budget_min_paise), min(p.budget_max_paise)
    into _n, _low, _high
    from public.preferences p
    join public.trip_members m on m.trip_id = p.trip_id and m.user_id = p.user_id
   where p.trip_id = _trip_id
     and p.budget_min_paise is not null
     and p.budget_max_paise is not null;

  if _n < 3 then
    return jsonb_build_object('status', 'insufficient', 'respondents', _n, 'needed', 3);
  end if;
  if _low > _high then
    return jsonb_build_object('status', 'no_overlap', 'respondents', _n);
  end if;

  _step := case when _currency = 'INR' then 100000 else 5000 end;
  return jsonb_build_object(
    'status', 'band',
    'respondents', _n,
    'low_minor', (_low / _step) * _step,
    'high_minor', ((_high + _step - 1) / _step) * _step,
    'step_minor', _step,
    'currency', _currency,
    'scope', 'total_per_person_incl_flights'
  );
end;
$$;


-- -----------------------------------------------------------------------------
-- 7. Progress as counts only
-- -----------------------------------------------------------------------------

create function public.preference_progress(_trip_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  _uid uuid := private.require(_trip_id, 'read');
begin
  return (
    select jsonb_build_object(
      'members', (select count(*) from public.trip_members m where m.trip_id = _trip_id),
      'cards_submitted', count(*) filter (where p.submitted_at is not null),
      'me_card_submitted', coalesce(bool_or(p.user_id = _uid and p.submitted_at is not null), false),
      'me_budget_submitted', coalesce(bool_or(p.user_id = _uid and p.budget_min_paise is not null), false)
    )
    from public.preferences p
    join public.trip_members m on m.trip_id = p.trip_id and m.user_id = p.user_id
    where p.trip_id = _trip_id
  );
end;
$$;


-- -----------------------------------------------------------------------------
-- 8. Keep private tables out of Supabase Realtime
-- -----------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if exists (select 1 from pg_publication_tables
                where pubname = 'supabase_realtime' and schemaname = 'public'
                  and tablename = 'preferences') then
      execute 'alter publication supabase_realtime drop table public.preferences';
    end if;
  end if;
end;
$$;


-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.health_check()                                   to anon, authenticated;
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
grant execute on function public.trip_budget_band(uuid)                           to authenticated;
grant execute on function public.preference_progress(uuid)                        to authenticated;
grant execute on function public.set_planning_bounds(uuid, bigint, bigint, boolean) to authenticated;
-- trip_response_status (named who had answered) is no longer granted.

revoke all on public.trips from anon, authenticated;
grant select (id, name, destination, start_date, end_date, currency, timezone, owner_id, created_at,
              planning_budget_min_minor, planning_budget_max_minor,
              planning_bounds_set_by, planning_bounds_set_at),
      insert (name, destination, start_date, end_date, currency, timezone),
      update (name, destination, start_date, end_date, timezone),
      delete
  on public.trips to authenticated;

insert into public.schema_versions (version, name, applied_at)
values (8, '008_budget_privacy.sql', now());
