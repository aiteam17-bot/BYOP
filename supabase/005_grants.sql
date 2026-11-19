-- =============================================================================
-- Group Trip Planner: table permissions for signed-in users
-- (run AFTER schema.sql, 002, 003 and 004; run it LAST)
--
-- HOW TO USE: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Run it once. Safe to run again.
--
-- Why this file exists: new Supabase projects no longer give signed-in users
-- access to tables created in the SQL editor. Without these grants every query
-- from the app fails with "permission denied for table ...". The grants only
-- let signed-in users REACH the tables: what each person may actually read or
-- change is still decided by the row-level security policies in schema.sql.
-- Signed-out visitors (anon) get nothing.
-- =============================================================================

grant usage on schema public to authenticated;

grant select, insert, update, delete on
  public.trips,
  public.trip_members,
  public.preferences,
  public.stays,
  public.itinerary_items,
  public.expenses,
  public.expense_splits,
  public.payments
to authenticated;
