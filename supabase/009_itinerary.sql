-- =============================================================================
-- Group Trip Planner: 009 itinerary (PRD 05) and comments (PRD 06)
-- (run AFTER schema.sql and 002 to 008)
--
-- HOW TO USE: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Run it once. It deletes no rows and drops no tables or columns.
--
-- Review list:
--   1. itinerary_items gains duration, indicative cost, notes, author,
--      timestamps, an idempotency key and starts_at. Days stay date-free
--      (day_number) and "time" is the local wall-clock start in the trip's
--      time zone; starts_at (timestamptz) is DERIVED from the trip's
--      start_date + day + time + timezone and recomputed when those change.
--   2. Votes per stop (for / against) and comments per stop.
--   3. Direct INSERT/UPDATE/DELETE on itinerary_items is revoked: every
--      change goes through a function that checks membership and role,
--      validates, and runs in one transaction. Editing or moving a stop
--      restarts its votes. Adding a stop or comment is retry-safe.
--   4. Permission matrix gains add_stop / comment (everyone), and
--      edit_any_stop / moderate_comments (organiser and co-planners).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Stops
-- -----------------------------------------------------------------------------

alter table public.itinerary_items
  add column duration_minutes integer not null default 60
    check (duration_minutes between 5 and 1440),
  add column cost_minor bigint
    check (cost_minor is null or (cost_minor >= 0 and cost_minor <= 100000000000)),
  add column notes text check (notes is null or char_length(notes) <= 1000),
  add column created_by uuid references auth.users (id) on delete set null,
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz,
  add column starts_at timestamptz,
  add column client_key uuid,
  add constraint itinerary_items_title_length check (char_length(title) between 1 and 120),
  add constraint itinerary_items_url_http check (place_url is null or place_url ~* '^https?://'),
  add constraint itinerary_items_day_cap check (day_number <= 61),
  add constraint itinerary_items_client_key unique (trip_id, client_key);

comment on column public.itinerary_items."time" is
  'Local wall-clock start time in the trip time zone. starts_at is the derived instant.';
comment on column public.itinerary_items.cost_minor is
  'Indicative cost per person in MINOR units of the trip currency, entered by a member.';

-- starts_at = (trip start date + day - 1) at "time", in the trip's time zone.
create function private.stop_instant(_trip_id uuid, _day integer, _time time)
returns timestamptz
language sql stable security definer set search_path = ''
as $$
  select case when t.start_date is null or _time is null then null
              else ((t.start_date + (_day - 1)) + _time) at time zone t.timezone end
  from public.trips t where t.id = _trip_id;
$$;
revoke all on function private.stop_instant(uuid, integer, time) from public, anon, authenticated;

create function private.set_stop_instant()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.starts_at := private.stop_instant(new.trip_id, new.day_number, new."time");
  return new;
end;
$$;
revoke all on function private.set_stop_instant() from public, anon, authenticated;

create trigger itinerary_items_instant
  before insert or update of day_number, "time" on public.itinerary_items
  for each row execute function private.set_stop_instant();

create function private.refresh_trip_stop_instants()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.itinerary_items i
     set starts_at = private.stop_instant(i.trip_id, i.day_number, i."time")
   where i.trip_id = new.id;
  return null;
end;
$$;
revoke all on function private.refresh_trip_stop_instants() from public, anon, authenticated;

create trigger trips_refresh_stop_instants
  after update of start_date, timezone on public.trips
  for each row execute function private.refresh_trip_stop_instants();

update public.itinerary_items i
   set starts_at = private.stop_instant(i.trip_id, i.day_number, i."time");


-- -----------------------------------------------------------------------------
-- 2. Votes and comments
-- -----------------------------------------------------------------------------

create table public.stop_votes (
  item_id  uuid not null references public.itinerary_items (id) on delete cascade,
  trip_id  uuid not null,
  user_id  uuid not null,
  vote     text not null check (vote in ('for', 'against')),
  voted_at timestamptz not null default now(),
  primary key (item_id, user_id),
  foreign key (trip_id, user_id)
    references public.trip_members (trip_id, user_id) on delete cascade
);
create index stop_votes_trip_idx on public.stop_votes (trip_id);
alter table public.stop_votes enable row level security;
create trigger stop_votes_keys before update on public.stop_votes
  for each row execute function private.forbid_key_change('item_id', 'trip_id', 'user_id');

create table public.stop_comments (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.itinerary_items (id) on delete cascade,
  trip_id    uuid not null,
  user_id    uuid not null,
  body       text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now(),
  client_key uuid,
  unique (user_id, client_key),
  foreign key (trip_id, user_id)
    references public.trip_members (trip_id, user_id) on delete cascade
);
create index stop_comments_trip_idx on public.stop_comments (trip_id, created_at);
alter table public.stop_comments enable row level security;
create trigger stop_comments_keys before update on public.stop_comments
  for each row execute function private.forbid_key_change('item_id', 'trip_id', 'user_id');

create policy stop_votes_select on public.stop_votes for select to authenticated
  using (private.is_member(trip_id));
create policy stop_comments_select on public.stop_comments for select to authenticated
  using (private.is_member(trip_id));


-- -----------------------------------------------------------------------------
-- 4. Permission matrix
-- -----------------------------------------------------------------------------

create or replace function private.role_allows(_role text, _action text)
returns boolean
language sql immutable set search_path = ''
as $$
  select case
    when _role is null then false
    when _action in ('read', 'rsvp', 'suggest_option', 'vote', 'nudge',
                     'edit_own_preferences', 'add_stay', 'leave', 'add_stop', 'comment')
      then _role in ('owner', 'co_planner', 'member')
    when _action in ('rename_trip', 'settle_vote', 'reopen_vote', 'remove_any_option',
                     'manage_invites', 'set_planning_bounds', 'edit_any_stop', 'moderate_comments')
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


-- -----------------------------------------------------------------------------
-- 3. Functions: the only way to change stops, votes and comments
-- -----------------------------------------------------------------------------

-- Shared validation. Raises a readable 22023 error.
create function private.check_stop(
  _trip_id uuid, _day integer, _time time, _duration integer, _title text,
  _place_url text, _lat numeric, _lng numeric, _cost bigint, _notes text
)
returns void
language plpgsql stable security definer set search_path = ''
as $$
declare
  _start date;
  _end   date;
begin
  select t.start_date, t.end_date into _start, _end from public.trips t where t.id = _trip_id;
  if _day is null or _day < 1 then
    raise exception 'Choose a day' using errcode = '22023';
  end if;
  if _start is not null and _end is not null and _day > (_end - _start) + 1 then
    raise exception 'This trip has only % days', (_end - _start) + 1 using errcode = '22023';
  end if;
  if _day > 61 then
    raise exception 'Choose a day within the trip' using errcode = '22023';
  end if;
  if _time is null then
    raise exception 'Choose a start time' using errcode = '22023';
  end if;
  if _duration is null or _duration < 5 or _duration > 1440 then
    raise exception 'Duration must be between 5 minutes and 24 hours' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(_title, ''))) not between 1 and 120 then
    raise exception 'Stop names are 1 to 120 characters' using errcode = '22023';
  end if;
  if _place_url is not null and _place_url !~* '^https?://' then
    raise exception 'Links must start with http:// or https://' using errcode = '22023';
  end if;
  if (_lat is null) <> (_lng is null) or _lat not between -90 and 90 or _lng not between -180 and 180 then
    raise exception 'Enter the location as latitude and longitude, or leave it empty' using errcode = '22023';
  end if;
  if _cost is not null and (_cost < 0 or _cost > 100000000000) then
    raise exception 'Enter a cost of zero or more' using errcode = '22023';
  end if;
  if _notes is not null and char_length(_notes) > 1000 then
    raise exception 'Keep notes under 1000 characters' using errcode = '22023';
  end if;
end;
$$;
revoke all on function private.check_stop(uuid, integer, time, integer, text, text, numeric, numeric, bigint, text)
  from public, anon, authenticated;

-- Add a stop (any member). Same client key twice returns the same stop.
create function public.add_stop(
  _trip_id uuid, _day integer, _time time, _duration integer, _title text,
  _place_url text default null, _lat numeric default null, _lng numeric default null,
  _cost bigint default null, _notes text default null, _client_key uuid default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  _uid uuid := private.require(_trip_id, 'add_stop');
  _id  uuid;
begin
  if _client_key is not null then
    select i.id into _id from public.itinerary_items i
     where i.trip_id = _trip_id and i.client_key = _client_key;
    if _id is not null then
      return _id;
    end if;
  end if;
  perform private.check_stop(_trip_id, _day, _time, _duration, _title, _place_url, _lat, _lng, _cost, _notes);
  if (select count(*) from public.itinerary_items i where i.trip_id = _trip_id) >= 500 then
    raise exception 'A trip can have at most 500 stops' using errcode = '22023';
  end if;
  insert into public.itinerary_items
    (trip_id, day_number, "time", duration_minutes, title, place_url, latitude, longitude,
     cost_minor, notes, created_by, client_key)
  values
    (_trip_id, _day, _time, _duration, btrim(_title), nullif(btrim(_place_url), ''), _lat, _lng,
     _cost, nullif(btrim(_notes), ''), _uid, _client_key)
  on conflict (trip_id, client_key) do nothing
  returning id into _id;
  if _id is null then
    select i.id into _id from public.itinerary_items i
     where i.trip_id = _trip_id and i.client_key = _client_key;
  end if;
  return _id;
end;
$$;

-- Edit or move a stop (whoever added it, or a planner). Any change to when
-- or what it is restarts its votes, so nobody's "for" carries over silently.
create function public.update_stop(
  _item_id uuid, _day integer, _time time, _duration integer, _title text,
  _place_url text default null, _lat numeric default null, _lng numeric default null,
  _cost bigint default null, _notes text default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _old public.itinerary_items%rowtype;
  _uid uuid;
begin
  select * into _old from public.itinerary_items i where i.id = _item_id for update;
  _uid := private.require(_old.trip_id, 'read');
  if _old.created_by is distinct from _uid then
    perform private.require(_old.trip_id, 'edit_any_stop');
  end if;
  perform private.check_stop(_old.trip_id, _day, _time, _duration, _title, _place_url, _lat, _lng, _cost, _notes);

  update public.itinerary_items
     set day_number = _day, "time" = _time, duration_minutes = _duration,
         title = btrim(_title), place_url = nullif(btrim(_place_url), ''),
         latitude = _lat, longitude = _lng, cost_minor = _cost,
         notes = nullif(btrim(_notes), ''), updated_at = now()
   where id = _item_id;

  if _old.day_number <> _day or _old."time" is distinct from _time
     or _old.duration_minutes <> _duration or _old.title <> btrim(_title)
     or _old.place_url is distinct from nullif(btrim(_place_url), '')
     or _old.latitude is distinct from _lat or _old.longitude is distinct from _lng
     or _old.cost_minor is distinct from _cost then
    delete from public.stop_votes where item_id = _item_id;
  end if;
end;
$$;

create function public.delete_stop(_item_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _trip   uuid;
  _author uuid;
  _uid    uuid;
begin
  select i.trip_id, i.created_by into _trip, _author from public.itinerary_items i where i.id = _item_id;
  _uid := private.require(_trip, 'read');
  if _author is distinct from _uid then
    perform private.require(_trip, 'edit_any_stop');
  end if;
  delete from public.itinerary_items where id = _item_id;
end;
$$;

-- Your own vote on a stop: 'for', 'against', or null to withdraw.
create function public.vote_stop(_item_id uuid, _vote text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _trip uuid;
  _uid  uuid;
begin
  select i.trip_id into _trip from public.itinerary_items i where i.id = _item_id;
  _uid := private.require(_trip, 'vote');
  if _vote is null then
    delete from public.stop_votes where item_id = _item_id and user_id = _uid;
    return;
  end if;
  if _vote not in ('for', 'against') then
    raise exception 'Vote for or against' using errcode = '22023';
  end if;
  insert into public.stop_votes (item_id, trip_id, user_id, vote)
  values (_item_id, _trip, _uid, _vote)
  on conflict (item_id, user_id) do update set vote = excluded.vote, voted_at = now();
end;
$$;

-- Comment on a stop (any member). Same client key twice adds one comment.
create function public.add_comment(_item_id uuid, _body text, _client_key uuid default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  _trip  uuid;
  _uid   uuid;
  _clean text := btrim(coalesce(_body, ''));
  _id    uuid;
begin
  select i.trip_id into _trip from public.itinerary_items i where i.id = _item_id;
  _uid := private.require(_trip, 'comment');
  if char_length(_clean) not between 1 and 1000 then
    raise exception 'Comments are 1 to 1000 characters' using errcode = '22023';
  end if;
  insert into public.stop_comments (item_id, trip_id, user_id, body, client_key)
  values (_item_id, _trip, _uid, _clean, _client_key)
  on conflict (user_id, client_key) do nothing
  returning id into _id;
  if _id is null then
    select c.id into _id from public.stop_comments c
     where c.user_id = _uid and c.client_key = _client_key;
  end if;
  return _id;
end;
$$;

create function public.delete_comment(_comment_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  _trip   uuid;
  _author uuid;
  _uid    uuid;
begin
  select c.trip_id, c.user_id into _trip, _author from public.stop_comments c where c.id = _comment_id;
  _uid := private.require(_trip, 'read');
  if _author is distinct from _uid then
    perform private.require(_trip, 'moderate_comments');
  end if;
  delete from public.stop_comments where id = _comment_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

revoke all on public.itinerary_items, public.stop_votes, public.stop_comments from anon, authenticated;
grant select on public.itinerary_items, public.stop_votes, public.stop_comments to authenticated;

revoke execute on function public.add_stop(uuid, integer, time, integer, text, text, numeric, numeric, bigint, text, uuid) from public, anon;
revoke execute on function public.update_stop(uuid, integer, time, integer, text, text, numeric, numeric, bigint, text) from public, anon;
revoke execute on function public.delete_stop(uuid)               from public, anon;
revoke execute on function public.vote_stop(uuid, text)           from public, anon;
revoke execute on function public.add_comment(uuid, text, uuid)   from public, anon;
revoke execute on function public.delete_comment(uuid)            from public, anon;
grant execute on function public.add_stop(uuid, integer, time, integer, text, text, numeric, numeric, bigint, text, uuid) to authenticated;
grant execute on function public.update_stop(uuid, integer, time, integer, text, text, numeric, numeric, bigint, text) to authenticated;
grant execute on function public.delete_stop(uuid)               to authenticated;
grant execute on function public.vote_stop(uuid, text)           to authenticated;
grant execute on function public.add_comment(uuid, text, uuid)   to authenticated;
grant execute on function public.delete_comment(uuid)            to authenticated;

insert into public.schema_versions (version, name, applied_at)
values (9, '009_itinerary.sql', now());
