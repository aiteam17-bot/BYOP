-- =============================================================================
-- Group Trip Planner: map locations (run AFTER schema.sql, 002 and 003)
--
-- HOW TO USE: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Run it once.
--
-- Adds an optional map location (latitude + longitude, in degrees) to stays
-- and itinerary items so they can be shown as pins on the trip map. Both
-- columns are filled in together or both left empty.
-- =============================================================================

alter table public.stays
  add column latitude  numeric(9, 6) check (latitude  between -90  and 90),
  add column longitude numeric(9, 6) check (longitude between -180 and 180),
  add constraint stays_location_pair
    check ((latitude is null) = (longitude is null));

alter table public.itinerary_items
  add column latitude  numeric(9, 6) check (latitude  between -90  and 90),
  add column longitude numeric(9, 6) check (longitude between -180 and 180),
  add constraint itinerary_items_location_pair
    check ((latitude is null) = (longitude is null));
