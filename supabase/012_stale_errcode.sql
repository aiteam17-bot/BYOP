-- =============================================================================
-- Group Trip Planner: 012 stale-edit error code fix
-- (run AFTER schema.sql and 002 to 011)
--
-- HOW TO USE: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Run it once. It deletes no rows and changes no tables. It replaces one
-- private helper.
--
-- Why: 010 reported "someone else changed this first" with SQLSTATE 40001
-- (serialization_failure). PostgREST treats 40001 as a transient conflict and
-- retries the whole transaction automatically. A stale version never becomes
-- fresh, so a stale save retried indefinitely and the request never returned.
-- It now uses the application code 'VS409' (version stale). That is outside
-- every standard SQLSTATE class, so nothing retries it, and PostgREST returns
-- it to the app as HTTP 400 with code VS409.
-- =============================================================================

create or replace function private.stale()
returns void
language plpgsql set search_path = ''
as $$
begin
  raise exception 'Someone else changed this first. Reload to see the latest version, then try again.'
    using errcode = 'VS409';
end;
$$;

revoke all on function private.stale() from public, anon, authenticated;

insert into public.schema_versions (version, name, applied_at)
values (12, '012_stale_errcode.sql', now());
