-- =============================================================================
-- TEST PROJECT ONLY. Never run this in production.
--
-- Lets the authenticated API tests make an invite link expire without waiting
-- a day. It only works in a database that has the test_project_marker table,
-- which this same file creates, so running it by mistake in production would
-- still need someone to paste it there.
-- =============================================================================

create table public.test_project_marker (id integer primary key check (id = 1));
insert into public.test_project_marker values (1);
alter table public.test_project_marker enable row level security;

create function public.test_expire_invite(_invite_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.test_project_marker) then
    raise exception 'test-only function' using errcode = '42501';
  end if;
  -- Only the trip's organiser or a co-planner may expire it, like revoke.
  perform private.require((select i.trip_id from public.trip_invites i where i.id = _invite_id), 'manage_invites');
  update public.trip_invites
     set created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
   where id = _invite_id;
end;
$$;
revoke all on function public.test_expire_invite(uuid) from public, anon;
grant execute on function public.test_expire_invite(uuid) to authenticated;
