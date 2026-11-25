-- =============================================================================
-- Group Trip Planner: 013 plan shapes (Tight / Balanced / Splurge), limited
-- AI ideas, and the concierge as a proposal system (PRD 04, 11)
-- (run AFTER schema.sql and 002 to 012)
--
-- HOW TO USE: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Run it once. It deletes no rows and drops no tables or columns.
--
-- Review list:
--   1. trips.plan_version: goes up whenever any itinerary stop is added,
--      changed or removed. Concierge proposals record the version they were
--      made against; a proposal made against an older plan is stale and
--      cannot be applied (it must be made again). Members cannot write it.
--   2. plan_shapes: saved Tight / Balanced / Splurge proposals. They store
--      CHOICES (which stay quote) plus a snapshot of the inputs they were
--      built from (dates, planning bounds, quote and category versions).
--      The numbers are always recomputed in code from the current rows, and
--      a shape whose inputs changed is shown as out of date. No prices are
--      stored here, so none can be invented.
--   3. Limited AI ideas: per-trip opt-in by the organiser or a co-planner.
--      ai_requests is the rate-limit ledger (per account+trip, per account,
--      per trip) and caps request size. ai_suggestions holds returned
--      generic ideas, always "unverified" until a member confirms the place
--      link, opening hours, time needed and price themselves.
--   4. concierge_proposals: a bounded patch (1-10 operations from a fixed
--      list: add_stop, move_stop, remove_stop) shown before/after with
--      Accept / Not now. Accept re-checks permissions and the plan version
--      and applies everything once, atomically. Accepting twice is a no-op.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. Permissions
-- -----------------------------------------------------------------------------

create or replace function private.role_allows(_role text, _action text)
returns boolean
language sql immutable set search_path = ''
as $$
  select case
    when _role is null then false
    when _action in ('read', 'rsvp', 'suggest_option', 'vote', 'nudge',
                     'edit_own_preferences', 'add_stay', 'leave', 'add_stop', 'comment',
                     'add_place', 'add_quote', 'request_ai_ideas', 'confirm_idea', 'propose_change')
      then _role in ('owner', 'co_planner', 'member')
    when _action in ('rename_trip', 'settle_vote', 'reopen_vote', 'remove_any_option',
                     'manage_invites', 'set_planning_bounds', 'edit_any_stop', 'moderate_comments',
                     'edit_any_place', 'edit_any_quote', 'manage_variants', 'manage_budget',
                     'manage_plan_shapes', 'manage_ai', 'dismiss_any_proposal', 'dismiss_any_idea')
      then _role in ('owner', 'co_planner')
    when _action in ('manage_roles', 'remove_member', 'edit_trip_dates', 'delete_trip')
      then _role = 'owner'
    else false
  end;
$$;


-- -----------------------------------------------------------------------------
-- 1. Plan version
-- -----------------------------------------------------------------------------

alter table public.trips add column plan_version integer not null default 1;

create function private.bump_plan_version()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.trips set plan_version = plan_version + 1
   where id = coalesce(new.trip_id, old.trip_id);
  return null;
end;
$$;
revoke all on function private.bump_plan_version() from public, anon, authenticated;

create trigger itinerary_items_bump_plan
  after insert or update or delete on public.itinerary_items
  for each row execute function private.bump_plan_version();


-- -----------------------------------------------------------------------------
-- 2. Plan shapes (Tight / Balanced / Splurge)
-- -----------------------------------------------------------------------------

create table public.plan_shapes (
  id                 uuid primary key default gen_random_uuid(),
  trip_id            uuid not null references public.trips (id) on delete cascade,
  generation         integer not null check (generation >= 1),
  tier               text not null check (tier in ('tight', 'balanced', 'splurge')),
  -- The stay this shape uses (null = no comparable quote yet). If the quote
  -- is deleted the link is cleared and the shape shows as out of date.
  stay_quote_id      uuid references public.stay_quotes (id) on delete set null,
  stay_quote_version integer,
  -- Snapshot of the inputs, so the page can say exactly what changed.
  start_date         date,
  end_date           date,
  bounds_min_minor   bigint,
  bounds_max_minor   bigint,
  bounds_set_at      timestamptz,
  categories         jsonb not null default '[]'::jsonb,  -- [{"id":..., "version":...}]
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  chosen_by          uuid references auth.users (id) on delete set null,
  chosen_at          timestamptz,
  unique (trip_id, generation, tier),
  unique (id, trip_id)
);
create index plan_shapes_trip_idx on public.plan_shapes (trip_id, generation desc);
-- At most one shape per trip is "the plan we are going with".
create unique index plan_shapes_one_chosen on public.plan_shapes (trip_id) where chosen_at is not null;

create trigger plan_shapes_key_fixed before update on public.plan_shapes
  for each row execute function private.forbid_key_change('trip_id');

-- Save a new set of shapes. The caller only says which quote each tier
-- uses; the inputs snapshot is read here, from the database.
create function public.save_plan_shapes(_trip_id uuid, _choices jsonb)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  _uid  uuid := private.require(_trip_id, 'manage_plan_shapes');
  _trip public.trips%rowtype;
  _gen  integer;
  _cats jsonb;
  _tier text;
  _qid  uuid;
  _qver integer;
begin
  if jsonb_typeof(_choices) is distinct from 'object'
     or (select count(*) from jsonb_object_keys(_choices)) <> 3
     or not (_choices ? 'tight' and _choices ? 'balanced' and _choices ? 'splurge') then
    raise exception 'Give a choice for tight, balanced and splurge' using errcode = '22023';
  end if;
  select * into _trip from public.trips t where t.id = _trip_id for update;
  select coalesce(max(s.generation), 0) + 1 into _gen from public.plan_shapes s where s.trip_id = _trip_id;
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'version', c.version) order by c.id), '[]'::jsonb)
    into _cats from public.budget_categories c where c.trip_id = _trip_id;

  foreach _tier in array array['tight', 'balanced', 'splurge'] loop
    _qid := null; _qver := null;
    if jsonb_typeof(_choices -> _tier) = 'string' then
      begin
        _qid := (_choices ->> _tier)::uuid;
      exception when others then
        raise exception 'That stay quote could not be found' using errcode = 'P0002';
      end;
      select q.version into _qver from public.stay_quotes q where q.id = _qid and q.trip_id = _trip_id;
      if _qver is null then
        raise exception 'That stay quote could not be found' using errcode = 'P0002';
      end if;
    elsif jsonb_typeof(_choices -> _tier) is distinct from 'null' then
      raise exception 'Each choice is a stay quote id or null' using errcode = '22023';
    end if;
    insert into public.plan_shapes
      (trip_id, generation, tier, stay_quote_id, stay_quote_version, start_date, end_date,
       bounds_min_minor, bounds_max_minor, bounds_set_at, categories, created_by)
    values
      (_trip_id, _gen, _tier, _qid, _qver, _trip.start_date, _trip.end_date,
       _trip.planning_budget_min_minor, _trip.planning_budget_max_minor, _trip.planning_bounds_set_at,
       _cats, _uid);
  end loop;
  -- Keep the latest 10 generations.
  delete from public.plan_shapes s
   where s.trip_id = _trip_id and s.generation <= _gen - 10 and s.chosen_at is null;
  return _gen;
end;
$$;

create function public.choose_plan_shape(_shape_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _trip uuid;
  _uid  uuid;
begin
  select s.trip_id into _trip from public.plan_shapes s where s.id = _shape_id;
  _uid := private.require(_trip, 'manage_plan_shapes');
  update public.plan_shapes set chosen_at = null, chosen_by = null
   where trip_id = _trip and chosen_at is not null and id <> _shape_id;
  update public.plan_shapes set chosen_at = coalesce(chosen_at, now()), chosen_by = coalesce(chosen_by, _uid)
   where id = _shape_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- 3. Limited AI ideas: opt-in, rate limits, unverified suggestions
-- -----------------------------------------------------------------------------

alter table public.trips
  add column ai_ideas_opt_in_at timestamptz,
  add column ai_ideas_opt_in_by uuid references auth.users (id) on delete set null;

create function public.set_ai_ideas_opt_in(_trip_id uuid, _on boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := private.require(_trip_id, 'manage_ai');
begin
  update public.trips
     set ai_ideas_opt_in_at = case when _on then coalesce(ai_ideas_opt_in_at, now()) end,
         ai_ideas_opt_in_by = case when _on then coalesce(ai_ideas_opt_in_by, _uid) end
   where id = _trip_id;
end;
$$;

-- One row per request: the rate-limit ledger. No prompt or response text is
-- stored here.
create table public.ai_requests (
  id             uuid primary key default gen_random_uuid(),
  trip_id        uuid not null references public.trips (id) on delete cascade,
  user_id        uuid not null references auth.users (id) on delete cascade,
  created_at     timestamptz not null default now(),
  status         text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
  error_code     text check (error_code is null or error_code ~ '^[a-z_]{1,40}$'),
  request_bytes  integer not null check (request_bytes between 1 and 2048),
  response_bytes integer check (response_bytes is null or response_bytes between 0 and 65536),
  finished_at    timestamptz,
  unique (id, trip_id)
);
create index ai_requests_user_time on public.ai_requests (user_id, created_at desc);
create index ai_requests_trip_time on public.ai_requests (trip_id, created_at desc);

-- Limits (also shown on the page): 5 per hour per person per trip, 20 per
-- day per person, 30 per day per trip, one at a time per person.
create function public.begin_ai_request(_trip_id uuid, _request_bytes integer)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := private.require(_trip_id, 'request_ai_ideas');
  _id  uuid;
begin
  if (select t.ai_ideas_opt_in_at from public.trips t where t.id = _trip_id) is null then
    raise exception 'The organiser has not turned on AI ideas for this trip' using errcode = '42501';
  end if;
  if _request_bytes is null or _request_bytes < 1 or _request_bytes > 2048 then
    raise exception 'That request is too large' using errcode = '22023';
  end if;
  -- Serialise this person's requests so two tabs cannot both pass the check.
  perform pg_advisory_xact_lock(hashtextextended('ai:' || _uid::text, 0));
  if exists (select 1 from public.ai_requests r
              where r.user_id = _uid and r.status = 'pending' and r.created_at > now() - interval '2 minutes') then
    raise exception 'Your last request is still running. Wait for it to finish.' using errcode = 'RL429';
  end if;
  if (select count(*) from public.ai_requests r
       where r.user_id = _uid and r.trip_id = _trip_id and r.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'Limit reached: 5 idea requests per hour on this trip. Try again later.' using errcode = 'RL429';
  end if;
  if (select count(*) from public.ai_requests r
       where r.user_id = _uid and r.created_at > now() - interval '1 day') >= 20 then
    raise exception 'Limit reached: 20 idea requests per day. Try again tomorrow.' using errcode = 'RL429';
  end if;
  if (select count(*) from public.ai_requests r
       where r.trip_id = _trip_id and r.created_at > now() - interval '1 day') >= 30 then
    raise exception 'This trip has reached 30 idea requests today. Try again tomorrow.' using errcode = 'RL429';
  end if;
  insert into public.ai_requests (trip_id, user_id, request_bytes) values (_trip_id, _uid, _request_bytes)
  returning id into _id;
  return _id;
end;
$$;

create table public.ai_suggestions (
  id                     uuid primary key default gen_random_uuid(),
  trip_id                uuid not null references public.trips (id) on delete cascade,
  request_id             uuid not null,
  name                   text not null check (char_length(name) between 1 and 80),
  category               text not null check (category in ('sight', 'food', 'nature', 'activity', 'culture', 'nightlife', 'shopping', 'relax')),
  area                   text check (area is null or char_length(area) <= 80),
  why                    text check (why is null or char_length(why) <= 300),
  source_url             text check (source_url is null or (source_url ~* '^https://[^\s]+$' and char_length(source_url) <= 500)),
  status                 text not null default 'unverified' check (status in ('unverified', 'confirmed', 'dismissed')),
  -- What a member checked themselves. All four are required to confirm.
  confirmed_place_url    text check (confirmed_place_url is null or confirmed_place_url ~* '^https?://[^\s]+$'),
  confirmed_hours        text check (confirmed_hours is null or char_length(confirmed_hours) between 1 and 120),
  confirmed_minutes      integer check (confirmed_minutes is null or confirmed_minutes between 5 and 1440),
  confirmed_price_minor  bigint check (confirmed_price_minor is null or confirmed_price_minor between 0 and 100000000000),
  confirmed_by           uuid references auth.users (id) on delete set null,
  confirmed_at           timestamptz,
  created_by             uuid references auth.users (id) on delete set null,
  created_at             timestamptz not null default now(),
  version                integer not null default 1,
  unique (id, trip_id),
  foreign key (request_id, trip_id) references public.ai_requests (id, trip_id) on delete cascade,
  constraint ai_suggestions_confirmed_complete check (
    status <> 'confirmed' or (confirmed_place_url is not null and confirmed_hours is not null
      and confirmed_minutes is not null and confirmed_price_minor is not null
      and confirmed_by is not null and confirmed_at is not null)
  )
);
create index ai_suggestions_trip_idx on public.ai_suggestions (trip_id, created_at desc);
create trigger ai_suggestions_key_fixed before update on public.ai_suggestions
  for each row execute function private.forbid_key_change('trip_id');

-- Finish one of your own pending requests, storing validated ideas with it.
-- Runs once: a finished request cannot be finished again.
create function public.finish_ai_request(
  _request_id uuid, _ok boolean, _error_code text, _response_bytes integer, _ideas jsonb
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  _req  public.ai_requests%rowtype;
  _idea jsonb;
  _n    integer := 0;
begin
  select * into _req from public.ai_requests r where r.id = _request_id for update;
  if _req.id is null or _req.user_id is distinct from auth.uid() then
    raise exception 'That request could not be found' using errcode = 'P0002';
  end if;
  perform private.require(_req.trip_id, 'request_ai_ideas');
  if _req.status <> 'pending' then
    raise exception 'That request has already finished' using errcode = '22023';
  end if;
  if _response_bytes is not null and (_response_bytes < 0 or _response_bytes > 65536) then
    raise exception 'That response is too large' using errcode = '22023';
  end if;
  if not _ok then
    update public.ai_requests
       set status = 'failed', error_code = coalesce(_error_code, 'unknown'),
           response_bytes = _response_bytes, finished_at = now()
     where id = _request_id;
    return 0;
  end if;
  if jsonb_typeof(_ideas) is distinct from 'array' or jsonb_array_length(_ideas) > 8 then
    raise exception 'Ideas must be a list of at most 8' using errcode = '22023';
  end if;
  for _idea in select * from jsonb_array_elements(_ideas) loop
    if jsonb_typeof(_idea) <> 'object'
       or exists (select 1 from jsonb_object_keys(_idea) k
                   where k not in ('name', 'category', 'area', 'why', 'source_url')) then
      raise exception 'Unexpected fields in an idea' using errcode = '22023';
    end if;
    insert into public.ai_suggestions (trip_id, request_id, name, category, area, why, source_url, created_by)
    values (_req.trip_id, _request_id, btrim(_idea ->> 'name'), _idea ->> 'category',
            nullif(btrim(_idea ->> 'area'), ''), nullif(btrim(_idea ->> 'why'), ''),
            nullif(btrim(_idea ->> 'source_url'), ''), _req.user_id);
    _n := _n + 1;
  end loop;
  update public.ai_requests
     set status = 'succeeded', response_bytes = _response_bytes, finished_at = now()
   where id = _request_id;
  return _n;
end;
$$;

create function public.confirm_ai_suggestion(
  _id uuid, _place_url text, _hours text, _minutes integer, _price_minor bigint, _expected_version integer
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  _s   public.ai_suggestions%rowtype;
  _uid uuid;
begin
  select * into _s from public.ai_suggestions a where a.id = _id for update;
  _uid := private.require(_s.trip_id, 'confirm_idea');
  if _expected_version is distinct from _s.version then perform private.stale(); end if;
  if _s.status = 'dismissed' then
    raise exception 'This idea was set aside' using errcode = '22023';
  end if;
  perform private.check_url(_place_url, true);
  if _hours is null or char_length(btrim(_hours)) not between 1 and 120 then
    raise exception 'Write the opening hours you checked (up to 120 characters)' using errcode = '22023';
  end if;
  if _minutes is null or _minutes not between 5 and 1440 then
    raise exception 'Time needed is 5 minutes to 24 hours' using errcode = '22023';
  end if;
  if _price_minor is null or _price_minor < 0 or _price_minor > 100000000000 then
    raise exception 'Enter the price you checked (0 if free)' using errcode = '22023';
  end if;
  update public.ai_suggestions
     set status = 'confirmed', confirmed_place_url = btrim(_place_url), confirmed_hours = btrim(_hours),
         confirmed_minutes = _minutes, confirmed_price_minor = _price_minor,
         confirmed_by = _uid, confirmed_at = now(), version = version + 1
   where id = _id;
  return _s.version + 1;
end;
$$;

create function public.dismiss_ai_suggestion(_id uuid, _expected_version integer)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _s public.ai_suggestions%rowtype;
begin
  select * into _s from public.ai_suggestions a where a.id = _id for update;
  perform private.require_author_or(_s.trip_id, _s.created_by, 'dismiss_any_idea');
  if _expected_version is distinct from _s.version then perform private.stale(); end if;
  update public.ai_suggestions set status = 'dismissed', version = version + 1 where id = _id;
end;
$$;


-- -----------------------------------------------------------------------------
-- 4. Concierge proposals
-- -----------------------------------------------------------------------------

create table public.concierge_proposals (
  id                uuid primary key default gen_random_uuid(),
  trip_id           uuid not null references public.trips (id) on delete cascade,
  ops               jsonb not null check (jsonb_typeof(ops) = 'array' and jsonb_array_length(ops) between 1 and 10),
  base_plan_version integer not null,
  status            text not null default 'pending' check (status in ('pending', 'accepted', 'dismissed', 'stale')),
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  decided_by        uuid references auth.users (id) on delete set null,
  decided_at        timestamptz,
  client_key        uuid,
  unique (id, trip_id),
  unique (trip_id, client_key)
);
create index concierge_proposals_trip_idx on public.concierge_proposals (trip_id, created_at desc);
create trigger concierge_proposals_key_fixed before update on public.concierge_proposals
  for each row execute function private.forbid_key_change('trip_id');

-- Strict shape check for one operation. Unknown operations or fields fail.
create function private.check_concierge_op(_trip_id uuid, _op jsonb)
returns void
language plpgsql stable set search_path = ''
as $$
declare
  _kind    text := _op ->> 'op';
  _allowed text[];
  _sugg    public.ai_suggestions%rowtype;
begin
  if jsonb_typeof(_op) is distinct from 'object' then
    raise exception 'Each change must be an object' using errcode = '22023';
  end if;
  _allowed := case _kind
    when 'add_stop'    then array['op', 'day', 'time', 'duration', 'title', 'suggestion_id']
    when 'move_stop'   then array['op', 'item_id', 'expected_version', 'day', 'time']
    when 'remove_stop' then array['op', 'item_id', 'expected_version']
  end;
  if _allowed is null then
    raise exception 'Unknown change type' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(_op) k where k <> all (_allowed)) then
    raise exception 'Unexpected fields in a change' using errcode = '22023';
  end if;
  -- Types and formats, before anything is cast.
  if _kind in ('add_stop', 'move_stop') and not (
       jsonb_typeof(_op -> 'day') = 'number' and (_op ->> 'day') ~ '^[0-9]{1,2}$'
       and jsonb_typeof(_op -> 'time') = 'string' and (_op ->> 'time') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
    raise exception 'Each change needs a day and a time like 09:30' using errcode = '22023';
  end if;
  if _kind in ('move_stop', 'remove_stop') and not (
       jsonb_typeof(_op -> 'item_id') = 'string'
       and (_op ->> 'item_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and jsonb_typeof(_op -> 'expected_version') = 'number' and (_op ->> 'expected_version') ~ '^[0-9]{1,9}$') then
    raise exception 'That stop could not be found' using errcode = 'P0002';
  end if;
  if _kind = 'add_stop' then
    if _op ? 'suggestion_id' then
      if _op ? 'title' or not (jsonb_typeof(_op -> 'suggestion_id') = 'string'
           and (_op ->> 'suggestion_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
        raise exception 'That idea could not be found' using errcode = 'P0002';
      end if;
    elsif not (jsonb_typeof(_op -> 'title') = 'string' and char_length(btrim(_op ->> 'title')) between 1 and 120) then
      raise exception 'Give the stop a name (up to 120 characters)' using errcode = '22023';
    end if;
    if _op ? 'duration' and not (jsonb_typeof(_op -> 'duration') = 'number' and (_op ->> 'duration') ~ '^[0-9]{1,4}$') then
      raise exception 'Duration must be between 5 minutes and 24 hours' using errcode = '22023';
    end if;
    if not _op ? 'suggestion_id' and not _op ? 'duration' then
      raise exception 'Duration must be between 5 minutes and 24 hours' using errcode = '22023';
    end if;
  end if;
  if _kind = 'add_stop' and _op ? 'suggestion_id' then
    select * into _sugg from public.ai_suggestions a
     where a.id = (_op ->> 'suggestion_id')::uuid and a.trip_id = _trip_id;
    if _sugg.id is null then
      raise exception 'That idea could not be found' using errcode = 'P0002';
    end if;
    if _sugg.status <> 'confirmed' then
      raise exception 'Only ideas a member has confirmed can go into the plan' using errcode = '22023';
    end if;
  end if;
  if _kind in ('move_stop', 'remove_stop') and not exists (
       select 1 from public.itinerary_items i
        where i.id = (_op ->> 'item_id')::uuid and i.trip_id = _trip_id) then
    raise exception 'That stop could not be found' using errcode = 'P0002';
  end if;
end;
$$;

create function public.propose_change(_trip_id uuid, _ops jsonb, _client_key uuid default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := private.require(_trip_id, 'propose_change');
  _id  uuid;
  _op  jsonb;
begin
  if _client_key is not null then
    select p.id into _id from public.concierge_proposals p where p.trip_id = _trip_id and p.client_key = _client_key;
    if _id is not null then return _id; end if;
  end if;
  if jsonb_typeof(_ops) is distinct from 'array' or jsonb_array_length(_ops) not between 1 and 10 then
    raise exception 'A proposal has 1 to 10 changes' using errcode = '22023';
  end if;
  if octet_length(_ops::text) > 8192 then
    raise exception 'That proposal is too large' using errcode = '22023';
  end if;
  for _op in select * from jsonb_array_elements(_ops) loop
    perform private.check_concierge_op(_trip_id, _op);
  end loop;
  if (select count(*) from public.concierge_proposals p where p.trip_id = _trip_id and p.status = 'pending') >= 50 then
    raise exception 'This trip has 50 open proposals. Decide on some first.' using errcode = '22023';
  end if;
  insert into public.concierge_proposals (trip_id, ops, base_plan_version, created_by, client_key)
  values (_trip_id, _ops, (select t.plan_version from public.trips t where t.id = _trip_id), _uid, _client_key)
  returning id into _id;
  return _id;
end;
$$;

-- Accept: re-check everything and apply all changes once, atomically.
-- Returns 'applied', 'already_applied' or 'stale' (the plan changed since the
-- proposal was made; nothing was applied and it must be made again).
create function public.accept_proposal(_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  _p      public.concierge_proposals%rowtype;
  _uid    uuid;
  _op     jsonb;
  _item   public.itinerary_items%rowtype;
  _sugg   public.ai_suggestions%rowtype;
  _day    integer;
  _time   time;
  _dur    integer;
  _title  text;
begin
  select * into _p from public.concierge_proposals p where p.id = _id for update;
  _uid := private.require(_p.trip_id, 'propose_change');
  if _p.status = 'accepted' then return 'already_applied'; end if;
  if _p.status = 'dismissed' then
    raise exception 'This proposal was set aside' using errcode = '22023';
  end if;
  -- Lock the trip row: plan changes for this trip happen one at a time.
  if _p.status = 'stale' or (select t.plan_version from public.trips t where t.id = _p.trip_id for update)
                            is distinct from _p.base_plan_version then
    update public.concierge_proposals set status = 'stale' where id = _id;
    return 'stale';
  end if;

  for _op in select * from jsonb_array_elements(_p.ops) loop
    perform private.check_concierge_op(_p.trip_id, _op);
    if _op ->> 'op' = 'add_stop' then
      perform private.require(_p.trip_id, 'add_stop');
      _day := (_op ->> 'day')::integer;
      _time := (_op ->> 'time')::time;
      _sugg := null;
      if _op ? 'suggestion_id' then
        select * into _sugg from public.ai_suggestions a where a.id = (_op ->> 'suggestion_id')::uuid;
        _title := _sugg.name;
        _dur := coalesce((_op ->> 'duration')::integer, _sugg.confirmed_minutes);
      else
        _title := _op ->> 'title';
        _dur := (_op ->> 'duration')::integer;
      end if;
      perform private.check_stop(_p.trip_id, _day, _time, _dur, _title,
                                 _sugg.confirmed_place_url, null, null, _sugg.confirmed_price_minor, null);
      insert into public.itinerary_items
        (trip_id, day_number, "time", duration_minutes, title, place_url, cost_minor, notes, created_by)
      values
        (_p.trip_id, _day, _time, _dur, btrim(_title), _sugg.confirmed_place_url, _sugg.confirmed_price_minor,
         case when _sugg.id is not null
              then 'From an AI idea confirmed by a member. Hours checked: ' || _sugg.confirmed_hours end,
         _uid);
    else
      select * into _item from public.itinerary_items i where i.id = (_op ->> 'item_id')::uuid for update;
      perform private.require_author_or(_p.trip_id, _item.created_by, 'edit_any_stop');
      if (_op ->> 'expected_version')::integer is distinct from _item.version then
        perform private.stale();
      end if;
      if _op ->> 'op' = 'remove_stop' then
        delete from public.itinerary_items where id = _item.id;
      else
        _day := (_op ->> 'day')::integer;
        _time := (_op ->> 'time')::time;
        perform private.check_stop(_p.trip_id, _day, _time, _item.duration_minutes, _item.title,
                                   _item.place_url, _item.latitude, _item.longitude, _item.cost_minor, _item.notes);
        update public.itinerary_items
           set day_number = _day, "time" = _time, updated_at = now(), updated_by = _uid, version = version + 1
         where id = _item.id;
        if _item.day_number <> _day or _item."time" is distinct from _time then
          delete from public.stop_votes where item_id = _item.id;
        end if;
      end if;
    end if;
  end loop;

  update public.concierge_proposals set status = 'accepted', decided_by = _uid, decided_at = now() where id = _id;
  return 'applied';
end;
$$;

create function public.dismiss_proposal(_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _p   public.concierge_proposals%rowtype;
  _uid uuid;
begin
  select * into _p from public.concierge_proposals p where p.id = _id for update;
  _uid := private.require_author_or(_p.trip_id, _p.created_by, 'dismiss_any_proposal');
  if _p.status = 'accepted' then
    raise exception 'This proposal was already applied' using errcode = '22023';
  end if;
  update public.concierge_proposals set status = 'dismissed', decided_by = _uid, decided_at = now()
   where id = _id and status <> 'dismissed';
end;
$$;


-- -----------------------------------------------------------------------------
-- 5. Row-level security and grants (default deny; reads for members only;
--    every write goes through the functions above)
-- -----------------------------------------------------------------------------

alter table public.plan_shapes         enable row level security;
alter table public.ai_requests         enable row level security;
alter table public.ai_suggestions      enable row level security;
alter table public.concierge_proposals enable row level security;

create policy plan_shapes_members_read on public.plan_shapes
  for select to authenticated using (private.is_member(trip_id));
-- People see only their own request ledger rows.
create policy ai_requests_own_read on public.ai_requests
  for select to authenticated using (user_id = (select auth.uid()) and private.is_member(trip_id));
create policy ai_suggestions_members_read on public.ai_suggestions
  for select to authenticated using (private.is_member(trip_id));
create policy concierge_members_read on public.concierge_proposals
  for select to authenticated using (private.is_member(trip_id));

revoke all on public.plan_shapes, public.ai_requests, public.ai_suggestions, public.concierge_proposals
  from public, anon, authenticated;
grant select on public.plan_shapes, public.ai_requests, public.ai_suggestions, public.concierge_proposals
  to authenticated;

revoke all on function public.save_plan_shapes(uuid, jsonb)                                   from public, anon;
revoke all on function public.choose_plan_shape(uuid)                                         from public, anon;
revoke all on function public.set_ai_ideas_opt_in(uuid, boolean)                              from public, anon;
revoke all on function public.begin_ai_request(uuid, integer)                                 from public, anon;
revoke all on function public.finish_ai_request(uuid, boolean, text, integer, jsonb)          from public, anon;
revoke all on function public.confirm_ai_suggestion(uuid, text, text, integer, bigint, integer) from public, anon;
revoke all on function public.dismiss_ai_suggestion(uuid, integer)                            from public, anon;
revoke all on function public.propose_change(uuid, jsonb, uuid)                               from public, anon;
revoke all on function public.accept_proposal(uuid)                                           from public, anon;
revoke all on function public.dismiss_proposal(uuid)                                          from public, anon;
revoke all on function private.check_concierge_op(uuid, jsonb)                                from public, anon, authenticated;

grant execute on function public.save_plan_shapes(uuid, jsonb)                                   to authenticated;
grant execute on function public.choose_plan_shape(uuid)                                         to authenticated;
grant execute on function public.set_ai_ideas_opt_in(uuid, boolean)                              to authenticated;
grant execute on function public.begin_ai_request(uuid, integer)                                 to authenticated;
grant execute on function public.finish_ai_request(uuid, boolean, text, integer, jsonb)          to authenticated;
grant execute on function public.confirm_ai_suggestion(uuid, text, text, integer, bigint, integer) to authenticated;
grant execute on function public.dismiss_ai_suggestion(uuid, integer)                            to authenticated;
grant execute on function public.propose_change(uuid, jsonb, uuid)                               to authenticated;
grant execute on function public.accept_proposal(uuid)                                           to authenticated;
grant execute on function public.dismiss_proposal(uuid)                                          to authenticated;

insert into public.schema_versions (version, name, applied_at)
values (13, '013_plans_ai_concierge.sql', now());
