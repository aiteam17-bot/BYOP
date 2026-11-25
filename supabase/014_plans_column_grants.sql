-- =============================================================================
-- Group Trip Planner: 014 let members read the columns 013 added to trips
-- (run AFTER schema.sql and 002 to 013)
--
-- HOW TO USE: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Run it once. It only adds read access to three columns; nothing else.
--
-- Why: trips uses column-level SELECT grants (007, 008). 013 added
-- plan_version, ai_ideas_opt_in_at and ai_ideas_opt_in_by without granting
-- them, so the Plans page's reads were denied. Row-level security still
-- limits rows to trips you are a member of. No write access is added: these
-- columns change only through the checked functions and the trigger.
-- =============================================================================

grant select (plan_version, ai_ideas_opt_in_at, ai_ideas_opt_in_by) on public.trips to authenticated;

insert into public.schema_versions (version, name, applied_at)
values (14, '014_plans_column_grants.sql', now());
