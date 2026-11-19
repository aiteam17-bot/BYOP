-- =============================================================================
-- Group Trip Planner: stay comparison (run AFTER schema.sql and 002_trip_flow.sql)
--
-- HOW TO USE: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Run it once.
-- =============================================================================

-- A structured cancellation type, so stays can be compared on flexibility.
-- The existing free-text `cancellation_terms` column keeps the details
-- ("free until 3 days before check-in", "50% refund", ...).
alter table public.stays
  add column cancellation_type text not null default 'unknown'
    check (cancellation_type in ('free', 'partial', 'non_refundable', 'unknown'));
