-- =============================================================================
-- Group Trip Planner: 011 Supabase Realtime (notification layer only)
-- (run AFTER 010, in Supabase only: it needs Supabase's realtime schema)
--
-- HOW TO USE: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Run it once. It deletes nothing.
--
-- Review list:
--   1. Shared, member-readable trip tables are added to the
--      supabase_realtime publication, so members get "something changed"
--      events. Realtime checks each subscriber against the tables' RLS.
--      The database stays the source of truth: the app refetches from it on
--      every event and after every reconnect.
--      NOT added: preferences (private budgets), budget_revisions,
--      invite tables, profiles.
--   2. Private channel "trip:<trip id>" for presence ("who is editing"):
--      only members of that trip may read or join it, and clients may only
--      send presence (no broadcasts). Presence payloads carry a user id,
--      display name and the stop being edited, never preference values.
-- =============================================================================

do $$
declare
  _t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not found: skipping';
    return;
  end if;
  foreach _t in array array['itinerary_items', 'stop_comments', 'stop_votes', 'saved_lists', 'saved_places',
                            'plan_variants', 'stay_quotes', 'stay_quote_votes', 'budget_categories'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = _t) then
      execute format('alter publication supabase_realtime add table public.%I', _t);
    end if;
  end loop;
end;
$$;

-- "trip:<uuid>" -> the trip id, or null for any other topic.
create function private.trip_from_topic(_topic text)
returns uuid
language sql immutable set search_path = ''
as $$
  select case when _topic ~ '^trip:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then substr(_topic, 6)::uuid end;
$$;
revoke all on function private.trip_from_topic(text) from public, anon;
grant execute on function private.trip_from_topic(text) to authenticated;

do $$
begin
  if to_regclass('realtime.messages') is null then
    raise notice 'realtime.messages not found: skipping channel policies';
    return;
  end if;
  execute $p$
    create policy trip_channel_members_read on realtime.messages
      for select to authenticated
      using (private.is_member(private.trip_from_topic((select realtime.topic()))))
  $p$;
  execute $p$
    create policy trip_channel_members_presence on realtime.messages
      for insert to authenticated
      with check (
        realtime.messages.extension = 'presence'
        and private.is_member(private.trip_from_topic((select realtime.topic())))
      )
  $p$;
end;
$$;

insert into public.schema_versions (version, name, applied_at)
values (11, '011_realtime.sql', now());
