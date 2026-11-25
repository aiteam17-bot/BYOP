-- =============================================================================
-- Group Trip Planner: 010 saved places, plan variants, stay quotes, budget
-- categories, versioned itinerary edits (PRD 04-06, 08)
-- (run AFTER schema.sql and 002 to 009)
--
-- HOW TO USE: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Run it once. It deletes no rows and drops no tables or columns. It replaces
-- two functions (add_stop, update_stop) with versions that take more inputs.
--
-- Review list:
--   1. New tables, each belonging to one trip with creator/update metadata and
--      a version: saved_lists, saved_places, plan_variants,
--      budget_categories, stay_quotes, stay_quote_votes. Places and stays
--      start empty.
--   2. Links between rows must stay inside the same trip: composite foreign
--      keys (row_id, trip_id) everywhere a row points at another row.
--   3. Optimistic concurrency: every update/delete function takes the
--      version the caller saw. If someone else changed the row first, it
--      fails with SQLSTATE 40001 instead of overwriting their change.
--   4. Stay quotes store the price exactly as quoted (amount + basis: per
--      room per night, or total for the stay), nights, rooms, taxes and fees
--      in integer minor units (NULL = unknown, never 0), currency, sharers,
--      cancellation deadline + time zone, source and when it was checked.
--      quoted_total_minor is a generated column, so a total is never
--      multiplied again. A different currency is only compared with an
--      explicitly recorded rate, rate date and source.
--   5. Votes on quotes are opinions only: nothing books, nothing refreshes a
--      price.
--   6. Itinerary stops gain plan variant, saved place, member-entered travel
--      minutes, updated_by and version.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. Shared checks
-- -----------------------------------------------------------------------------

create function private.stale()
returns void
language plpgsql set search_path = ''
as $$
begin
  raise exception 'Someone else changed this first. Reload to see the latest version, then try again.'
    using errcode = '40001';
end;
$$;

create function private.check_url(_url text, _required boolean)
returns void
language plpgsql immutable set search_path = ''
as $$
begin
  if _url is null or btrim(_url) = '' then
    if _required then
      raise exception 'Add the link where this came from' using errcode = '22023';
    end if;
    return;
  end if;
  if _url !~* '^https?://[^\s]+$' or char_length(_url) > 2000 then
    raise exception 'Links must start with http:// or https://' using errcode = '22023';
  end if;
end;
$$;

create function private.check_coords(_lat numeric, _lng numeric)
returns void
language plpgsql immutable set search_path = ''
as $$
begin
  if (_lat is null) <> (_lng is null)
     or _lat not between -90 and 90 or _lng not between -180 and 180 then
    raise exception 'Enter the location as latitude and longitude, or leave it empty' using errcode = '22023';
  end if;
end;
$$;

create function private.check_tz(_tz text)
returns void
language plpgsql stable set search_path = ''
as $$
begin
  if _tz is null or _tz !~ '^([A-Za-z_]+(/[A-Za-z0-9_+-]+)+|UTC)$' then
    raise exception 'Choose a real time zone, like Asia/Kolkata' using errcode = '22023';
  end if;
  begin
    perform now() at time zone _tz;
  exception when others then
    raise exception 'Choose a real time zone, like Asia/Kolkata' using errcode = '22023';
  end;
end;
$$;

revoke all on function private.stale()                        from public, anon, authenticated;
revoke all on function private.check_url(text, boolean)       from public, anon, authenticated;
revoke all on function private.check_coords(numeric, numeric) from public, anon, authenticated;
revoke all on function private.check_tz(text)                 from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 1. Saved lists and places (PRD 05 Explore / saved list)
-- -----------------------------------------------------------------------------

create table public.saved_lists (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.trips (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz,
  version    integer not null default 1,
  client_key uuid,
  unique (id, trip_id),
  unique (trip_id, client_key)
);
create unique index saved_lists_name_unique on public.saved_lists (trip_id, lower(name));

create table public.saved_places (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.trips (id) on delete cascade,
  list_id     uuid,
  name        text not null check (char_length(name) between 1 and 120),
  latitude    numeric(9, 6) check (latitude between -90 and 90),
  longitude   numeric(9, 6) check (longitude between -180 and 180),
  source_url  text check (source_url is null or source_url ~* '^https?://'),
  notes       text check (notes is null or char_length(notes) <= 1000),
  checked_at  timestamptz,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz,
  version     integer not null default 1,
  client_key  uuid,
  unique (id, trip_id),
  unique (trip_id, client_key),
  constraint saved_places_location_pair check ((latitude is null) = (longitude is null)),
  -- The list must belong to the same trip. Deleting a list keeps its places.
  foreign key (list_id, trip_id) references public.saved_lists (id, trip_id)
    on delete set null (list_id)
);
create index saved_places_trip_idx on public.saved_places (trip_id);


-- -----------------------------------------------------------------------------
-- 2. Plan variants (PRD 04 shapes: e.g. Tight / Balanced / Splurge)
-- -----------------------------------------------------------------------------

create table public.plan_variants (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.trips (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 60),
  description text check (description is null or char_length(description) <= 1000),
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz,
  version     integer not null default 1,
  client_key  uuid,
  unique (id, trip_id),
  unique (trip_id, client_key)
);
create unique index plan_variants_name_unique on public.plan_variants (trip_id, lower(name));


-- -----------------------------------------------------------------------------
-- 3. Itinerary stops: variant, place, travel minutes, version
-- -----------------------------------------------------------------------------

alter table public.itinerary_items
  add column variant_id uuid,
  add column place_id uuid,
  add column travel_minutes_from_previous integer
    check (travel_minutes_from_previous is null or travel_minutes_from_previous between 0 and 1440),
  add column updated_by uuid references auth.users (id) on delete set null,
  add column version integer not null default 1,
  add constraint itinerary_items_id_trip unique (id, trip_id),
  add constraint itinerary_items_variant_same_trip
    foreign key (variant_id, trip_id) references public.plan_variants (id, trip_id) on delete cascade,
  add constraint itinerary_items_place_same_trip
    foreign key (place_id, trip_id) references public.saved_places (id, trip_id) on delete set null (place_id);

comment on column public.itinerary_items.travel_minutes_from_previous is
  'Travel time from the previous stop as entered by a member. NULL = unknown (no routing provider).';

-- Votes and comments must point at a stop of the same trip.
alter table public.stop_votes
  add constraint stop_votes_item_same_trip
    foreign key (item_id, trip_id) references public.itinerary_items (id, trip_id) on delete cascade;
alter table public.stop_comments
  add constraint stop_comments_item_same_trip
    foreign key (item_id, trip_id) references public.itinerary_items (id, trip_id) on delete cascade;


-- -----------------------------------------------------------------------------
-- 4. Budget categories (planned cost per person by category)
-- -----------------------------------------------------------------------------

create table public.budget_categories (
  id                       uuid primary key default gen_random_uuid(),
  trip_id                  uuid not null references public.trips (id) on delete cascade,
  kind                     text not null check (kind in ('flights', 'stay', 'local_transport', 'food', 'activities', 'shopping', 'other')),
  label                    text not null check (char_length(label) between 1 and 60),
  planned_per_person_minor bigint check (planned_per_person_minor is null or planned_per_person_minor between 0 and 100000000000),
  notes                    text check (notes is null or char_length(notes) <= 1000),
  created_by               uuid references auth.users (id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_by               uuid references auth.users (id) on delete set null,
  updated_at               timestamptz,
  version                  integer not null default 1,
  client_key               uuid,
  unique (id, trip_id),
  unique (trip_id, client_key)
);
create unique index budget_categories_label_unique on public.budget_categories (trip_id, lower(label));


-- -----------------------------------------------------------------------------
-- 5. Stay quotes (PRD 08)
-- -----------------------------------------------------------------------------

create table public.stay_quotes (
  id                   uuid primary key default gen_random_uuid(),
  trip_id              uuid not null references public.trips (id) on delete cascade,
  name                 text not null check (char_length(name) between 1 and 120),
  source_url           text not null check (source_url ~* '^https?://'),
  pricing_basis        text not null check (pricing_basis in ('per_room_per_night', 'entire_stay_total')),
  currency             text not null check (currency in ('INR', 'USD', 'EUR', 'GBP', 'SGD', 'AED', 'AUD', 'CAD', 'THB', 'MYR', 'LKR', 'NPR')),
  -- The number exactly as quoted, in minor units of `currency`.
  quoted_amount_minor  bigint not null check (quoted_amount_minor > 0 and quoted_amount_minor <= 100000000000),
  nights               integer not null check (nights between 1 and 60),
  rooms                integer not null check (rooms between 1 and 50),
  -- Never multiplied twice: a total quote is used as is.
  quoted_total_minor   bigint generated always as (
    case when pricing_basis = 'entire_stay_total' then quoted_amount_minor
         else quoted_amount_minor * rooms * nights end
  ) stored,
  taxes_minor          bigint check (taxes_minor is null or taxes_minor >= 0),  -- NULL = unknown
  fees_minor           bigint check (fees_minor is null or fees_minor >= 0),    -- NULL = unknown
  sharers              integer not null check (sharers between 1 and 100),
  beds                 integer check (beds is null or beds between 0 and 200),
  -- Explicit conversion into the trip currency, or none.
  fx_rate_micros       bigint check (fx_rate_micros is null or fx_rate_micros > 0),
  fx_rate_date         date,
  fx_source            text check (fx_source is null or char_length(fx_source) between 1 and 120),
  cancellation_deadline timestamptz,
  cancellation_tz      text,
  cancellation_terms   text check (cancellation_terms is null or char_length(cancellation_terms) <= 1000),
  latitude             numeric(9, 6) check (latitude between -90 and 90),
  longitude            numeric(9, 6) check (longitude between -180 and 180),
  -- A member's rough guess, kept separate from the quote and labelled estimate.
  transport_estimate_per_person_minor bigint
    check (transport_estimate_per_person_minor is null or transport_estimate_per_person_minor >= 0),
  checked_at           timestamptz not null,
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_by           uuid references auth.users (id) on delete set null,
  updated_at           timestamptz,
  version              integer not null default 1,
  client_key           uuid,
  unique (id, trip_id),
  unique (trip_id, client_key),
  constraint stay_quotes_fx_all_or_none check (
    (fx_rate_micros is null) = (fx_rate_date is null) and (fx_rate_date is null) = (fx_source is null)
  ),
  constraint stay_quotes_cancel_pair check ((cancellation_deadline is null) = (cancellation_tz is null)),
  constraint stay_quotes_location_pair check ((latitude is null) = (longitude is null))
);
create index stay_quotes_trip_idx on public.stay_quotes (trip_id);

create table public.stay_quote_votes (
  quote_id uuid not null,
  trip_id  uuid not null,
  user_id  uuid not null,
  vote     text not null check (vote in ('for', 'against')),
  voted_at timestamptz not null default now(),
  primary key (quote_id, user_id),
  foreign key (quote_id, trip_id) references public.stay_quotes (id, trip_id) on delete cascade,
  foreign key (trip_id, user_id) references public.trip_members (trip_id, user_id) on delete cascade
);


-- -----------------------------------------------------------------------------
-- Keys never change; RLS: members read; nobody writes directly
-- -----------------------------------------------------------------------------

create trigger saved_lists_keys       before update on public.saved_lists       for each row execute function private.forbid_key_change('trip_id');
create trigger saved_places_keys      before update on public.saved_places      for each row execute function private.forbid_key_change('trip_id');
create trigger plan_variants_keys     before update on public.plan_variants     for each row execute function private.forbid_key_change('trip_id');
create trigger budget_categories_keys before update on public.budget_categories for each row execute function private.forbid_key_change('trip_id');
create trigger stay_quotes_keys       before update on public.stay_quotes       for each row execute function private.forbid_key_change('trip_id');
create trigger stay_quote_votes_keys  before update on public.stay_quote_votes  for each row execute function private.forbid_key_change('quote_id', 'trip_id', 'user_id');

alter table public.saved_lists       enable row level security;
alter table public.saved_places      enable row level security;
alter table public.plan_variants     enable row level security;
alter table public.budget_categories enable row level security;
alter table public.stay_quotes       enable row level security;
alter table public.stay_quote_votes  enable row level security;

create policy saved_lists_select       on public.saved_lists       for select to authenticated using (private.is_member(trip_id));
create policy saved_places_select      on public.saved_places      for select to authenticated using (private.is_member(trip_id));
create policy plan_variants_select     on public.plan_variants     for select to authenticated using (private.is_member(trip_id));
create policy budget_categories_select on public.budget_categories for select to authenticated using (private.is_member(trip_id));
create policy stay_quotes_select       on public.stay_quotes       for select to authenticated using (private.is_member(trip_id));
create policy stay_quote_votes_select  on public.stay_quote_votes  for select to authenticated using (private.is_member(trip_id));


-- -----------------------------------------------------------------------------
-- Permission matrix
-- -----------------------------------------------------------------------------

create or replace function private.role_allows(_role text, _action text)
returns boolean
language sql immutable set search_path = ''
as $$
  select case
    when _role is null then false
    when _action in ('read', 'rsvp', 'suggest_option', 'vote', 'nudge',
                     'edit_own_preferences', 'add_stay', 'leave', 'add_stop', 'comment',
                     'add_place', 'add_quote')
      then _role in ('owner', 'co_planner', 'member')
    when _action in ('rename_trip', 'settle_vote', 'reopen_vote', 'remove_any_option',
                     'manage_invites', 'set_planning_bounds', 'edit_any_stop', 'moderate_comments',
                     'edit_any_place', 'edit_any_quote', 'manage_variants', 'manage_budget')
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
      when 'edit_any_stop'       then 'Only whoever added this stop, the organiser or a co-planner can change it'
      when 'moderate_comments'   then 'Only the author, the organiser or a co-planner can delete this comment'
      when 'edit_any_place'      then 'Only whoever saved this, the organiser or a co-planner can change it'
      when 'edit_any_quote'      then 'Only whoever added this quote, the organiser or a co-planner can change it'
      when 'manage_variants'     then 'Only the organiser or a co-planner can manage plan variants'
      when 'manage_budget'       then 'Only the organiser or a co-planner can change budget categories'
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

-- Author or planner may edit; returns the caller.
create function private.require_author_or(_trip_id uuid, _author uuid, _action text)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  _uid uuid := private.require(_trip_id, 'read');
begin
  if _author is distinct from _uid then
    perform private.require(_trip_id, _action);
  end if;
  return _uid;
end;
$$;
revoke all on function private.require_author_or(uuid, uuid, text) from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- Functions: lists
-- -----------------------------------------------------------------------------

create function public.create_saved_list(_trip_id uuid, _name text, _client_key uuid default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := private.require(_trip_id, 'add_place');
  _id  uuid;
begin
  if char_length(btrim(coalesce(_name, ''))) not between 1 and 60 then
    raise exception 'List names are 1 to 60 characters' using errcode = '22023';
  end if;
  select l.id into _id from public.saved_lists l
   where l.trip_id = _trip_id and (l.client_key = _client_key or lower(l.name) = lower(btrim(_name)));
  if _id is not null then return _id; end if;
  insert into public.saved_lists (trip_id, name, created_by, client_key)
  values (_trip_id, btrim(_name), _uid, _client_key) returning id into _id;
  return _id;
end;
$$;

create function public.update_saved_list(_id uuid, _name text, _expected_version integer)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  _row public.saved_lists%rowtype;
  _uid uuid;
begin
  select * into _row from public.saved_lists where id = _id for update;
  _uid := private.require_author_or(_row.trip_id, _row.created_by, 'edit_any_place');
  if char_length(btrim(coalesce(_name, ''))) not between 1 and 60 then
    raise exception 'List names are 1 to 60 characters' using errcode = '22023';
  end if;
  if _expected_version is distinct from _row.version then perform private.stale(); end if;
  update public.saved_lists set name = btrim(_name), updated_by = _uid, updated_at = now(), version = version + 1
   where id = _id;
  return _row.version + 1;
end;
$$;

create function public.delete_saved_list(_id uuid, _expected_version integer)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _row public.saved_lists%rowtype;
begin
  select * into _row from public.saved_lists where id = _id for update;
  perform private.require_author_or(_row.trip_id, _row.created_by, 'edit_any_place');
  if _expected_version is distinct from _row.version then perform private.stale(); end if;
  delete from public.saved_lists where id = _id;
end;
$$;


-- -----------------------------------------------------------------------------
-- Functions: places
-- -----------------------------------------------------------------------------

create function private.check_place(_trip_id uuid, _list_id uuid, _name text, _lat numeric, _lng numeric,
                                    _url text, _notes text, _checked_at timestamptz)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if char_length(btrim(coalesce(_name, ''))) not between 1 and 120 then
    raise exception 'Place names are 1 to 120 characters' using errcode = '22023';
  end if;
  if _list_id is not null and not exists (select 1 from public.saved_lists l where l.id = _list_id and l.trip_id = _trip_id) then
    raise exception 'That list is not part of this trip' using errcode = 'P0002';
  end if;
  perform private.check_coords(_lat, _lng);
  perform private.check_url(_url, false);
  if _notes is not null and char_length(_notes) > 1000 then
    raise exception 'Keep notes under 1000 characters' using errcode = '22023';
  end if;
  if _checked_at is not null and _checked_at > now() + interval '5 minutes' then
    raise exception 'The checked date cannot be in the future' using errcode = '22023';
  end if;
end;
$$;
revoke all on function private.check_place(uuid, uuid, text, numeric, numeric, text, text, timestamptz) from public, anon, authenticated;

create function public.create_place(
  _trip_id uuid, _list_id uuid, _name text, _lat numeric default null, _lng numeric default null,
  _source_url text default null, _notes text default null, _checked_at timestamptz default null,
  _client_key uuid default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := private.require(_trip_id, 'add_place');
  _id  uuid;
begin
  if _client_key is not null then
    select p.id into _id from public.saved_places p where p.trip_id = _trip_id and p.client_key = _client_key;
    if _id is not null then return _id; end if;
  end if;
  perform private.check_place(_trip_id, _list_id, _name, _lat, _lng, _source_url, _notes, _checked_at);
  if (select count(*) from public.saved_places p where p.trip_id = _trip_id) >= 1000 then
    raise exception 'A trip can save at most 1000 places' using errcode = '22023';
  end if;
  insert into public.saved_places
    (trip_id, list_id, name, latitude, longitude, source_url, notes, checked_at, created_by, client_key)
  values
    (_trip_id, _list_id, btrim(_name), _lat, _lng, nullif(btrim(_source_url), ''), nullif(btrim(_notes), ''),
     _checked_at, _uid, _client_key)
  returning id into _id;
  return _id;
end;
$$;

create function public.update_place(
  _id uuid, _list_id uuid, _name text, _lat numeric, _lng numeric,
  _source_url text, _notes text, _checked_at timestamptz, _expected_version integer
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  _row public.saved_places%rowtype;
  _uid uuid;
begin
  select * into _row from public.saved_places where id = _id for update;
  _uid := private.require_author_or(_row.trip_id, _row.created_by, 'edit_any_place');
  perform private.check_place(_row.trip_id, _list_id, _name, _lat, _lng, _source_url, _notes, _checked_at);
  if _expected_version is distinct from _row.version then perform private.stale(); end if;
  update public.saved_places
     set list_id = _list_id, name = btrim(_name), latitude = _lat, longitude = _lng,
         source_url = nullif(btrim(_source_url), ''), notes = nullif(btrim(_notes), ''),
         checked_at = _checked_at, updated_by = _uid, updated_at = now(), version = version + 1
   where id = _id;
  return _row.version + 1;
end;
$$;

create function public.delete_place(_id uuid, _expected_version integer)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _row public.saved_places%rowtype;
begin
  select * into _row from public.saved_places where id = _id for update;
  perform private.require_author_or(_row.trip_id, _row.created_by, 'edit_any_place');
  if _expected_version is distinct from _row.version then perform private.stale(); end if;
  delete from public.saved_places where id = _id;
end;
$$;


-- -----------------------------------------------------------------------------
-- Functions: plan variants (organiser / co-planners)
-- -----------------------------------------------------------------------------

create function public.create_variant(_trip_id uuid, _name text, _description text default null, _client_key uuid default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := private.require(_trip_id, 'manage_variants');
  _id  uuid;
begin
  if char_length(btrim(coalesce(_name, ''))) not between 1 and 60 then
    raise exception 'Variant names are 1 to 60 characters' using errcode = '22023';
  end if;
  if _description is not null and char_length(_description) > 1000 then
    raise exception 'Keep the description under 1000 characters' using errcode = '22023';
  end if;
  select v.id into _id from public.plan_variants v
   where v.trip_id = _trip_id and (v.client_key = _client_key or lower(v.name) = lower(btrim(_name)));
  if _id is not null then return _id; end if;
  if (select count(*) from public.plan_variants v where v.trip_id = _trip_id) >= 10 then
    raise exception 'A trip can have at most 10 plan variants' using errcode = '22023';
  end if;
  insert into public.plan_variants (trip_id, name, description, created_by, client_key)
  values (_trip_id, btrim(_name), nullif(btrim(_description), ''), _uid, _client_key)
  returning id into _id;
  return _id;
end;
$$;

create function public.update_variant(_id uuid, _name text, _description text, _expected_version integer)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  _row public.plan_variants%rowtype;
  _uid uuid;
begin
  select * into _row from public.plan_variants where id = _id for update;
  _uid := private.require(_row.trip_id, 'manage_variants');
  if char_length(btrim(coalesce(_name, ''))) not between 1 and 60 then
    raise exception 'Variant names are 1 to 60 characters' using errcode = '22023';
  end if;
  if _expected_version is distinct from _row.version then perform private.stale(); end if;
  update public.plan_variants
     set name = btrim(_name), description = nullif(btrim(_description), ''),
         updated_by = _uid, updated_at = now(), version = version + 1
   where id = _id;
  return _row.version + 1;
end;
$$;

create function public.delete_variant(_id uuid, _expected_version integer)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _row public.plan_variants%rowtype;
begin
  select * into _row from public.plan_variants where id = _id for update;
  perform private.require(_row.trip_id, 'manage_variants');
  if _expected_version is distinct from _row.version then perform private.stale(); end if;
  delete from public.plan_variants where id = _id; -- its stops go with it
end;
$$;


-- -----------------------------------------------------------------------------
-- Functions: itinerary stops (replaces 009's add_stop / update_stop)
-- -----------------------------------------------------------------------------

drop function public.add_stop(uuid, integer, time, integer, text, text, numeric, numeric, bigint, text, uuid);
drop function public.update_stop(uuid, integer, time, integer, text, text, numeric, numeric, bigint, text);

create function private.check_stop_links(_trip_id uuid, _variant_id uuid, _place_id uuid, _travel integer)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if _variant_id is not null and not exists (select 1 from public.plan_variants v where v.id = _variant_id and v.trip_id = _trip_id) then
    raise exception 'That plan variant is not part of this trip' using errcode = 'P0002';
  end if;
  if _place_id is not null and not exists (select 1 from public.saved_places p where p.id = _place_id and p.trip_id = _trip_id) then
    raise exception 'That saved place is not part of this trip' using errcode = 'P0002';
  end if;
  if _travel is not null and (_travel < 0 or _travel > 1440) then
    raise exception 'Travel time must be between 0 and 1440 minutes' using errcode = '22023';
  end if;
end;
$$;
revoke all on function private.check_stop_links(uuid, uuid, uuid, integer) from public, anon, authenticated;

create function public.add_stop(
  _trip_id uuid, _day integer, _time time, _duration integer, _title text,
  _place_url text default null, _lat numeric default null, _lng numeric default null,
  _cost bigint default null, _notes text default null, _client_key uuid default null,
  _variant_id uuid default null, _place_id uuid default null, _travel_minutes integer default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := private.require(_trip_id, 'add_stop');
  _id  uuid;
begin
  if _client_key is not null then
    select i.id into _id from public.itinerary_items i where i.trip_id = _trip_id and i.client_key = _client_key;
    if _id is not null then return _id; end if;
  end if;
  perform private.check_stop(_trip_id, _day, _time, _duration, _title, _place_url, _lat, _lng, _cost, _notes);
  perform private.check_stop_links(_trip_id, _variant_id, _place_id, _travel_minutes);
  if (select count(*) from public.itinerary_items i where i.trip_id = _trip_id) >= 500 then
    raise exception 'A trip can have at most 500 stops' using errcode = '22023';
  end if;
  insert into public.itinerary_items
    (trip_id, day_number, "time", duration_minutes, title, place_url, latitude, longitude,
     cost_minor, notes, created_by, client_key, variant_id, place_id, travel_minutes_from_previous)
  values
    (_trip_id, _day, _time, _duration, btrim(_title), nullif(btrim(_place_url), ''), _lat, _lng,
     _cost, nullif(btrim(_notes), ''), _uid, _client_key, _variant_id, _place_id, _travel_minutes)
  returning id into _id;
  return _id;
end;
$$;

-- Edit or move a stop. _expected_version must match, or the edit is refused
-- (someone else changed it first). Returns the new version.
create function public.update_stop(
  _item_id uuid, _day integer, _time time, _duration integer, _title text,
  _place_url text, _lat numeric, _lng numeric, _cost bigint, _notes text,
  _expected_version integer,
  _variant_id uuid default null, _place_id uuid default null, _travel_minutes integer default null
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  _old public.itinerary_items%rowtype;
  _uid uuid;
begin
  select * into _old from public.itinerary_items i where i.id = _item_id for update;
  _uid := private.require_author_or(_old.trip_id, _old.created_by, 'edit_any_stop');
  perform private.check_stop(_old.trip_id, _day, _time, _duration, _title, _place_url, _lat, _lng, _cost, _notes);
  perform private.check_stop_links(_old.trip_id, _variant_id, _place_id, _travel_minutes);
  if _expected_version is distinct from _old.version then perform private.stale(); end if;

  update public.itinerary_items
     set day_number = _day, "time" = _time, duration_minutes = _duration,
         title = btrim(_title), place_url = nullif(btrim(_place_url), ''),
         latitude = _lat, longitude = _lng, cost_minor = _cost,
         notes = nullif(btrim(_notes), ''), variant_id = _variant_id, place_id = _place_id,
         travel_minutes_from_previous = _travel_minutes,
         updated_at = now(), updated_by = _uid, version = version + 1
   where id = _item_id;

  if _old.day_number <> _day or _old."time" is distinct from _time
     or _old.duration_minutes <> _duration or _old.title <> btrim(_title)
     or _old.place_url is distinct from nullif(btrim(_place_url), '')
     or _old.latitude is distinct from _lat or _old.longitude is distinct from _lng
     or _old.cost_minor is distinct from _cost or _old.variant_id is distinct from _variant_id then
    delete from public.stop_votes where item_id = _item_id;
  end if;
  return _old.version + 1;
end;
$$;

-- Old unversioned delete (009), kept only so nothing references a missing
-- function; its EXECUTE grant is revoked below. Use delete_stop_checked.
create or replace function public.delete_stop(_item_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _trip   uuid;
  _author uuid;
begin
  select i.trip_id, i.created_by into _trip, _author from public.itinerary_items i where i.id = _item_id;
  perform private.require_author_or(_trip, _author, 'edit_any_stop');
  delete from public.itinerary_items where id = _item_id;
end;
$$;

create function public.delete_stop_checked(_item_id uuid, _expected_version integer)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _row public.itinerary_items%rowtype;
begin
  select * into _row from public.itinerary_items i where i.id = _item_id for update;
  perform private.require_author_or(_row.trip_id, _row.created_by, 'edit_any_stop');
  if _expected_version is distinct from _row.version then perform private.stale(); end if;
  delete from public.itinerary_items where id = _item_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- Functions: budget categories (organiser / co-planners)
-- -----------------------------------------------------------------------------

create function private.check_budget_category(_kind text, _label text, _planned bigint, _notes text)
returns void
language plpgsql immutable set search_path = ''
as $$
begin
  if _kind is null or _kind not in ('flights', 'stay', 'local_transport', 'food', 'activities', 'shopping', 'other') then
    raise exception 'Choose a category' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(_label, ''))) not between 1 and 60 then
    raise exception 'Category names are 1 to 60 characters' using errcode = '22023';
  end if;
  if _planned is not null and (_planned < 0 or _planned > 100000000000) then
    raise exception 'Enter a planned amount of zero or more' using errcode = '22023';
  end if;
  if _notes is not null and char_length(_notes) > 1000 then
    raise exception 'Keep notes under 1000 characters' using errcode = '22023';
  end if;
end;
$$;
revoke all on function private.check_budget_category(text, text, bigint, text) from public, anon, authenticated;

create function public.create_budget_category(
  _trip_id uuid, _kind text, _label text, _planned_per_person_minor bigint default null,
  _notes text default null, _client_key uuid default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := private.require(_trip_id, 'manage_budget');
  _id  uuid;
begin
  perform private.check_budget_category(_kind, _label, _planned_per_person_minor, _notes);
  select c.id into _id from public.budget_categories c
   where c.trip_id = _trip_id and (c.client_key = _client_key or lower(c.label) = lower(btrim(_label)));
  if _id is not null then return _id; end if;
  insert into public.budget_categories (trip_id, kind, label, planned_per_person_minor, notes, created_by, client_key)
  values (_trip_id, _kind, btrim(_label), _planned_per_person_minor, nullif(btrim(_notes), ''), _uid, _client_key)
  returning id into _id;
  return _id;
end;
$$;

create function public.update_budget_category(
  _id uuid, _kind text, _label text, _planned_per_person_minor bigint, _notes text, _expected_version integer
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  _row public.budget_categories%rowtype;
  _uid uuid;
begin
  select * into _row from public.budget_categories where id = _id for update;
  _uid := private.require(_row.trip_id, 'manage_budget');
  perform private.check_budget_category(_kind, _label, _planned_per_person_minor, _notes);
  if _expected_version is distinct from _row.version then perform private.stale(); end if;
  update public.budget_categories
     set kind = _kind, label = btrim(_label), planned_per_person_minor = _planned_per_person_minor,
         notes = nullif(btrim(_notes), ''), updated_by = _uid, updated_at = now(), version = version + 1
   where id = _id;
  return _row.version + 1;
end;
$$;

create function public.delete_budget_category(_id uuid, _expected_version integer)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _row public.budget_categories%rowtype;
begin
  select * into _row from public.budget_categories where id = _id for update;
  perform private.require(_row.trip_id, 'manage_budget');
  if _expected_version is distinct from _row.version then perform private.stale(); end if;
  delete from public.budget_categories where id = _id;
end;
$$;


-- -----------------------------------------------------------------------------
-- Functions: stay quotes
-- -----------------------------------------------------------------------------

-- Validates a quote (as jsonb) against the trip. Raises 22023 with a reason.
create function private.check_quote(_trip_id uuid, _q jsonb)
returns void
language plpgsql stable security definer set search_path = ''
as $$
declare
  _trip_currency text;
  _currency text := _q ->> 'currency';
  _n bigint;
begin
  select t.currency into _trip_currency from public.trips t where t.id = _trip_id;
  if char_length(btrim(coalesce(_q ->> 'name', ''))) not between 1 and 120 then
    raise exception 'Name the stay (up to 120 characters)' using errcode = '22023';
  end if;
  perform private.check_url(_q ->> 'source_url', true);
  if coalesce(_q ->> 'pricing_basis', '') not in ('per_room_per_night', 'entire_stay_total') then
    raise exception 'Say whether the price is per room per night or the total for the stay' using errcode = '22023';
  end if;
  if _currency is null or _currency not in ('INR', 'USD', 'EUR', 'GBP', 'SGD', 'AED', 'AUD', 'CAD', 'THB', 'MYR', 'LKR', 'NPR') then
    raise exception 'Choose the currency of the quote' using errcode = '22023';
  end if;
  begin
    _n := (_q ->> 'quoted_amount_minor')::bigint;
    if _n is null or _n <= 0 or _n > 100000000000 then raise exception using errcode = '22023'; end if;
    _n := (_q ->> 'nights')::integer;
    if _n is null or _n not between 1 and 60 then raise exception using errcode = '22023'; end if;
    _n := (_q ->> 'rooms')::integer;
    if _n is null or _n not between 1 and 50 then raise exception using errcode = '22023'; end if;
    _n := (_q ->> 'sharers')::integer;
    if _n is null or _n not between 1 and 100 then raise exception using errcode = '22023'; end if;
    if (_q ->> 'taxes_minor')::bigint < 0 or (_q ->> 'fees_minor')::bigint < 0
       or (_q ->> 'transport_estimate_per_person_minor')::bigint < 0 then
      raise exception using errcode = '22023';
    end if;
    perform (_q ->> 'checked_at')::timestamptz, (_q ->> 'cancellation_deadline')::timestamptz,
            (_q ->> 'fx_rate_date')::date, (_q ->> 'fx_rate_micros')::bigint, (_q ->> 'beds')::integer,
            (_q ->> 'latitude')::numeric, (_q ->> 'longitude')::numeric;
  exception when others then
    raise exception 'Check the amounts, nights, rooms and sharers: whole positive numbers' using errcode = '22023';
  end;
  if _q ->> 'checked_at' is null or (_q ->> 'checked_at')::timestamptz > now() + interval '5 minutes' then
    raise exception 'Enter when the price was checked (not in the future)' using errcode = '22023';
  end if;
  -- Conversion: all three or none; never for the trip's own currency.
  if ((_q ->> 'fx_rate_micros') is null) <> ((_q ->> 'fx_rate_date') is null)
     or ((_q ->> 'fx_rate_date') is null) <> ((_q ->> 'fx_source') is null) then
    raise exception 'A conversion needs the rate, the date of the rate and its source' using errcode = '22023';
  end if;
  if (_q ->> 'fx_rate_micros') is not null then
    if _currency = _trip_currency then
      raise exception 'No conversion rate is needed for the trip''s own currency' using errcode = '22023';
    end if;
    if (_q ->> 'fx_rate_micros')::bigint <= 0 or (_q ->> 'fx_rate_date')::date > current_date then
      raise exception 'Enter a positive rate dated today or earlier' using errcode = '22023';
    end if;
  end if;
  if ((_q ->> 'cancellation_deadline') is null) <> ((_q ->> 'cancellation_tz') is null) then
    raise exception 'A cancellation deadline needs its time zone' using errcode = '22023';
  end if;
  if (_q ->> 'cancellation_tz') is not null then
    perform private.check_tz(_q ->> 'cancellation_tz');
  end if;
  perform private.check_coords((_q ->> 'latitude')::numeric, (_q ->> 'longitude')::numeric);
  if char_length(coalesce(_q ->> 'cancellation_terms', '')) > 1000 then
    raise exception 'Keep the cancellation terms under 1000 characters' using errcode = '22023';
  end if;
end;
$$;
revoke all on function private.check_quote(uuid, jsonb) from public, anon, authenticated;

create function public.create_quote(_trip_id uuid, _q jsonb, _client_key uuid default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := private.require(_trip_id, 'add_quote');
  _id  uuid;
begin
  if _client_key is not null then
    select s.id into _id from public.stay_quotes s where s.trip_id = _trip_id and s.client_key = _client_key;
    if _id is not null then return _id; end if;
  end if;
  perform private.check_quote(_trip_id, _q);
  if (select count(*) from public.stay_quotes s where s.trip_id = _trip_id) >= 200 then
    raise exception 'A trip can have at most 200 stay quotes' using errcode = '22023';
  end if;
  insert into public.stay_quotes (
    trip_id, name, source_url, pricing_basis, currency, quoted_amount_minor, nights, rooms,
    taxes_minor, fees_minor, sharers, beds, fx_rate_micros, fx_rate_date, fx_source,
    cancellation_deadline, cancellation_tz, cancellation_terms, latitude, longitude,
    transport_estimate_per_person_minor, checked_at, created_by, client_key)
  values (
    _trip_id, btrim(_q ->> 'name'), btrim(_q ->> 'source_url'), _q ->> 'pricing_basis', _q ->> 'currency',
    (_q ->> 'quoted_amount_minor')::bigint, (_q ->> 'nights')::integer, (_q ->> 'rooms')::integer,
    (_q ->> 'taxes_minor')::bigint, (_q ->> 'fees_minor')::bigint, (_q ->> 'sharers')::integer,
    (_q ->> 'beds')::integer, (_q ->> 'fx_rate_micros')::bigint, (_q ->> 'fx_rate_date')::date,
    nullif(btrim(_q ->> 'fx_source'), ''),
    (_q ->> 'cancellation_deadline')::timestamptz, _q ->> 'cancellation_tz',
    nullif(btrim(_q ->> 'cancellation_terms'), ''),
    (_q ->> 'latitude')::numeric, (_q ->> 'longitude')::numeric,
    (_q ->> 'transport_estimate_per_person_minor')::bigint, (_q ->> 'checked_at')::timestamptz,
    _uid, _client_key)
  returning id into _id;
  return _id;
end;
$$;

create function public.update_quote(_id uuid, _q jsonb, _expected_version integer)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  _row public.stay_quotes%rowtype;
  _uid uuid;
begin
  select * into _row from public.stay_quotes where id = _id for update;
  _uid := private.require_author_or(_row.trip_id, _row.created_by, 'edit_any_quote');
  perform private.check_quote(_row.trip_id, _q);
  if _expected_version is distinct from _row.version then perform private.stale(); end if;
  update public.stay_quotes set
    name = btrim(_q ->> 'name'), source_url = btrim(_q ->> 'source_url'),
    pricing_basis = _q ->> 'pricing_basis', currency = _q ->> 'currency',
    quoted_amount_minor = (_q ->> 'quoted_amount_minor')::bigint,
    nights = (_q ->> 'nights')::integer, rooms = (_q ->> 'rooms')::integer,
    taxes_minor = (_q ->> 'taxes_minor')::bigint, fees_minor = (_q ->> 'fees_minor')::bigint,
    sharers = (_q ->> 'sharers')::integer, beds = (_q ->> 'beds')::integer,
    fx_rate_micros = (_q ->> 'fx_rate_micros')::bigint, fx_rate_date = (_q ->> 'fx_rate_date')::date,
    fx_source = nullif(btrim(_q ->> 'fx_source'), ''),
    cancellation_deadline = (_q ->> 'cancellation_deadline')::timestamptz,
    cancellation_tz = _q ->> 'cancellation_tz',
    cancellation_terms = nullif(btrim(_q ->> 'cancellation_terms'), ''),
    latitude = (_q ->> 'latitude')::numeric, longitude = (_q ->> 'longitude')::numeric,
    transport_estimate_per_person_minor = (_q ->> 'transport_estimate_per_person_minor')::bigint,
    checked_at = (_q ->> 'checked_at')::timestamptz,
    updated_by = _uid, updated_at = now(), version = version + 1
  where id = _id;
  -- An edited quote is a different option: its votes start again.
  delete from public.stay_quote_votes where quote_id = _id;
  return _row.version + 1;
end;
$$;

create function public.delete_quote(_id uuid, _expected_version integer)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _row public.stay_quotes%rowtype;
begin
  select * into _row from public.stay_quotes where id = _id for update;
  perform private.require_author_or(_row.trip_id, _row.created_by, 'edit_any_quote');
  if _expected_version is distinct from _row.version then perform private.stale(); end if;
  delete from public.stay_quotes where id = _id;
end;
$$;

-- An opinion only: it books nothing and does not refresh the price.
create function public.vote_quote(_quote_id uuid, _vote text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _trip uuid;
  _uid  uuid;
begin
  select s.trip_id into _trip from public.stay_quotes s where s.id = _quote_id;
  _uid := private.require(_trip, 'vote');
  if _vote is null then
    delete from public.stay_quote_votes where quote_id = _quote_id and user_id = _uid;
    return;
  end if;
  if _vote not in ('for', 'against') then
    raise exception 'Vote for or against' using errcode = '22023';
  end if;
  insert into public.stay_quote_votes (quote_id, trip_id, user_id, vote)
  values (_quote_id, _trip, _uid, _vote)
  on conflict (quote_id, user_id) do update set vote = excluded.vote, voted_at = now();
end;
$$;


-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

revoke all on public.saved_lists, public.saved_places, public.plan_variants, public.budget_categories,
              public.stay_quotes, public.stay_quote_votes from anon, authenticated;
grant select on public.saved_lists, public.saved_places, public.plan_variants, public.budget_categories,
                public.stay_quotes, public.stay_quote_votes to authenticated;

revoke execute on all functions in schema public from public, anon;
revoke execute on all functions in schema private from public, anon;
grant execute on function public.health_check() to anon, authenticated;
-- Deletes must say which version they saw: the unversioned delete_stop is retired.
revoke execute on function public.delete_stop(uuid) from authenticated;

grant execute on function public.create_saved_list(uuid, text, uuid) to authenticated;
grant execute on function public.update_saved_list(uuid, text, integer) to authenticated;
grant execute on function public.delete_saved_list(uuid, integer) to authenticated;
grant execute on function public.create_place(uuid, uuid, text, numeric, numeric, text, text, timestamptz, uuid) to authenticated;
grant execute on function public.update_place(uuid, uuid, text, numeric, numeric, text, text, timestamptz, integer) to authenticated;
grant execute on function public.delete_place(uuid, integer) to authenticated;
grant execute on function public.create_variant(uuid, text, text, uuid) to authenticated;
grant execute on function public.update_variant(uuid, text, text, integer) to authenticated;
grant execute on function public.delete_variant(uuid, integer) to authenticated;
grant execute on function public.add_stop(uuid, integer, time, integer, text, text, numeric, numeric, bigint, text, uuid, uuid, uuid, integer) to authenticated;
grant execute on function public.update_stop(uuid, integer, time, integer, text, text, numeric, numeric, bigint, text, integer, uuid, uuid, integer) to authenticated;
grant execute on function public.delete_stop_checked(uuid, integer) to authenticated;
grant execute on function public.create_budget_category(uuid, text, text, bigint, text, uuid) to authenticated;
grant execute on function public.update_budget_category(uuid, text, text, bigint, text, integer) to authenticated;
grant execute on function public.delete_budget_category(uuid, integer) to authenticated;
grant execute on function public.create_quote(uuid, jsonb, uuid) to authenticated;
grant execute on function public.update_quote(uuid, jsonb, integer) to authenticated;
grant execute on function public.delete_quote(uuid, integer) to authenticated;
grant execute on function public.vote_quote(uuid, text) to authenticated;

insert into public.schema_versions (version, name, applied_at)
values (10, '010_places_quotes.sql', now());
