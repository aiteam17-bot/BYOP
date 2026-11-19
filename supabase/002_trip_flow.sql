-- =============================================================================
-- Group Trip Planner: invites + "who has answered" (run AFTER schema.sql)
--
-- HOW TO USE: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Run it once. It adds nothing that exposes anyone's preference answers.
-- =============================================================================


-- 1. Every trip gets an unguessable invite token (122 random bits).
--    Members can read it (so any member can invite friends); outsiders cannot.
alter table public.trips
  add column invite_token text not null
    default replace(gen_random_uuid()::text, '-', '')
    unique;


-- 2. Show the trip behind an invite link BEFORE joining.
--    Returns only the trip's name/destination and whether you already joined.
create function public.invite_preview(_token text)
returns table (trip_id uuid, name text, destination text, already_member boolean)
language sql stable security definer set search_path = ''
as $$
  select t.id,
         t.name,
         t.destination,
         public.is_trip_member(t.id, auth.uid())
  from public.trips t
  where t.invite_token = _token
    and auth.uid() is not null;
$$;


-- 3. Join a trip with its invite token. Safe to call twice.
create function public.join_trip(_token text, _display_name text default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  _uid  uuid := auth.uid();
  _trip uuid;
  _name text;
begin
  if _uid is null then
    raise exception 'You need to sign in first' using errcode = '28000';
  end if;

  select t.id into _trip from public.trips t where t.invite_token = _token;
  if _trip is null then
    raise exception 'This invite link is not valid' using errcode = 'P0002';
  end if;

  _name := coalesce(
    nullif(btrim(_display_name), ''),
    nullif(split_part((select u.email from auth.users u where u.id = _uid), '@', 1), ''),
    'Friend'
  );

  insert into public.trip_members (trip_id, user_id, display_name, role)
  values (_trip, _uid, left(_name, 60), 'member')
  on conflict (trip_id, user_id) do nothing;

  return _trip;
end;
$$;


-- 4. Who has answered? Returns names and a yes/no flag ONLY, never answers.
--    Works only for people who belong to the trip. This is how the trip page
--    can show progress while preferences rows stay private to their owners.
create function public.trip_response_status(_trip_id uuid)
returns table (user_id uuid, display_name text, role text, has_answered boolean)
language sql stable security definer set search_path = ''
as $$
  select m.user_id,
         m.display_name,
         m.role,
         exists (
           select 1 from public.preferences p
           where p.trip_id = m.trip_id
             and p.user_id = m.user_id
             and p.submitted_at is not null
         )
  from public.trip_members m
  where m.trip_id = _trip_id
    and public.is_trip_member(_trip_id, auth.uid())
  order by (m.role = 'owner') desc, m.display_name;
$$;


-- 5. Only signed-in users may call these.
revoke execute on function public.invite_preview(text)            from public, anon;
revoke execute on function public.join_trip(text, text)           from public, anon;
revoke execute on function public.trip_response_status(uuid)      from public, anon;
grant  execute on function public.invite_preview(text)            to authenticated;
grant  execute on function public.join_trip(text, text)           to authenticated;
grant  execute on function public.trip_response_status(uuid)      to authenticated;
