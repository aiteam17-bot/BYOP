-- =============================================================================
-- Group Trip Planner: database schema + row-level security
--
-- HOW TO USE: Supabase dashboard -> SQL Editor -> New query -> paste this whole
-- file -> Run. Run it ONCE on a fresh project (it is not re-runnable).
--
-- Conventions
--   * All money columns are integer paise (1 INR = 100 paise), stored as bigint.
--   * Every table has row-level security (RLS) enabled.
--   * Members read/write only rows of trips they belong to.
--   * A preferences row is readable only by the user who owns it.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Tables
-- -----------------------------------------------------------------------------

create table public.trips (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  destination text,
  start_date  date,
  end_date    date,
  currency    text not null default 'INR',
  owner_id    uuid not null default auth.uid()
                references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  constraint trips_dates_valid
    check (start_date is null or end_date is null or end_date >= start_date)
);

create table public.trip_members (
  trip_id      uuid not null references public.trips (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  display_name text not null,
  role         text not null default 'member' check (role in ('owner', 'member')),
  upi_vpa      text,
  primary key (trip_id, user_id)
);

create table public.preferences (
  trip_id          uuid not null,
  user_id          uuid not null,
  budget_min_paise bigint check (budget_min_paise >= 0),
  budget_max_paise bigint check (budget_max_paise >= 0),
  pace             text,
  interests        text[] not null default '{}',
  food_notes       text,
  must_see         text,
  avoid            text,
  submitted_at     timestamptz,
  primary key (trip_id, user_id),
  -- Only members of a trip can have preferences for it.
  foreign key (trip_id, user_id)
    references public.trip_members (trip_id, user_id) on delete cascade,
  constraint preferences_budget_valid
    check (budget_min_paise is null or budget_max_paise is null
           or budget_max_paise >= budget_min_paise)
);

create table public.stays (
  id                  uuid primary key default gen_random_uuid(),
  trip_id             uuid not null references public.trips (id) on delete cascade,
  name                text not null,
  url                 text,
  nightly_price_paise bigint check (nightly_price_paise >= 0),
  taxes_paise         bigint check (taxes_paise >= 0),
  fees_paise          bigint check (fees_paise >= 0),
  cancellation_terms  text,
  rooms               integer check (rooms >= 0),
  beds                integer check (beds >= 0),
  distance_km         numeric(7, 2) check (distance_km >= 0),
  price_checked_on    date,
  added_by            uuid default auth.uid()
                        references auth.users (id) on delete set null
);

create table public.itinerary_items (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.trips (id) on delete cascade,
  day_number integer not null check (day_number >= 1),
  "time"     time,
  title      text not null,
  place_url  text
);

create table public.expenses (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid not null references public.trips (id) on delete cascade,
  title        text not null,
  amount_paise bigint not null check (amount_paise > 0),
  paid_by      uuid not null,
  split_type   text not null default 'equal'
                 check (split_type in ('equal', 'exact', 'percentage', 'shares')),
  created_at   timestamptz not null default now(),
  -- The payer must be a member of the same trip.
  foreign key (trip_id, paid_by)
    references public.trip_members (trip_id, user_id)
);

create table public.expense_splits (
  expense_id   uuid not null references public.expenses (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  amount_paise bigint not null check (amount_paise >= 0),
  primary key (expense_id, user_id)
);

create table public.payments (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid not null references public.trips (id) on delete cascade,
  from_user    uuid not null,
  to_user      uuid not null,
  amount_paise bigint not null check (amount_paise > 0),
  settled_at   timestamptz,
  constraint payments_distinct_people check (from_user <> to_user),
  foreign key (trip_id, from_user)
    references public.trip_members (trip_id, user_id),
  foreign key (trip_id, to_user)
    references public.trip_members (trip_id, user_id)
);

-- Indexes for the columns RLS and the app filter on most.
create index trip_members_user_id_idx    on public.trip_members (user_id);
create index stays_trip_id_idx           on public.stays (trip_id);
create index itinerary_items_trip_day_idx on public.itinerary_items (trip_id, day_number);
create index expenses_trip_id_idx        on public.expenses (trip_id);
create index expense_splits_user_id_idx  on public.expense_splits (user_id);
create index payments_trip_id_idx        on public.payments (trip_id);


-- -----------------------------------------------------------------------------
-- 2. Helper functions used by the policies
--
-- These are SECURITY DEFINER so a policy can look up membership without
-- triggering the policies on trip_members itself (which would recurse forever).
-- They are executable only by signed-in users, never by anonymous visitors.
-- -----------------------------------------------------------------------------

create function public.is_trip_member(_trip_id uuid, _user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.trip_members m
    where m.trip_id = _trip_id and m.user_id = _user_id
  );
$$;

create function public.is_trip_owner(_trip_id uuid, _user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.trips t
    where t.id = _trip_id and t.owner_id = _user_id
  );
$$;

create function public.member_role(_trip_id uuid, _user_id uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select m.role from public.trip_members m
  where m.trip_id = _trip_id and m.user_id = _user_id;
$$;

create function public.expense_trip_id(_expense_id uuid)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select e.trip_id from public.expenses e where e.id = _expense_id;
$$;

revoke execute on function public.is_trip_member(uuid, uuid)  from public, anon;
revoke execute on function public.is_trip_owner(uuid, uuid)   from public, anon;
revoke execute on function public.member_role(uuid, uuid)     from public, anon;
revoke execute on function public.expense_trip_id(uuid)       from public, anon;
grant  execute on function public.is_trip_member(uuid, uuid)  to authenticated;
grant  execute on function public.is_trip_owner(uuid, uuid)   to authenticated;
grant  execute on function public.member_role(uuid, uuid)     to authenticated;
grant  execute on function public.expense_trip_id(uuid)       to authenticated;


-- -----------------------------------------------------------------------------
-- 3. Trigger: whoever creates a trip becomes its first member (role 'owner')
-- -----------------------------------------------------------------------------

create function public.add_owner_as_member()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.trip_members (trip_id, user_id, display_name, role)
  values (
    new.id,
    new.owner_id,
    coalesce(
      nullif(split_part((select u.email from auth.users u where u.id = new.owner_id), '@', 1), ''),
      'Trip owner'
    ),
    'owner'
  );
  return new;
end;
$$;

revoke execute on function public.add_owner_as_member() from public, anon, authenticated;

create trigger trips_add_owner
  after insert on public.trips
  for each row execute function public.add_owner_as_member();


-- -----------------------------------------------------------------------------
-- 4. Row-level security
-- -----------------------------------------------------------------------------

alter table public.trips           enable row level security;
alter table public.trip_members    enable row level security;
alter table public.preferences     enable row level security;
alter table public.stays           enable row level security;
alter table public.itinerary_items enable row level security;
alter table public.expenses        enable row level security;
alter table public.expense_splits  enable row level security;
alter table public.payments        enable row level security;

-- Signed-out visitors get no table access at all.
revoke all on public.trips, public.trip_members, public.preferences,
              public.stays, public.itinerary_items, public.expenses,
              public.expense_splits, public.payments
  from anon;

-- trips -----------------------------------------------------------------------
-- Read: members (and the owner, so a freshly inserted trip can be read back).
-- Create: you can only create trips you own. Edit/delete: owner only.
create policy trips_select on public.trips
  for select to authenticated
  using (owner_id = (select auth.uid())
         or public.is_trip_member(id, (select auth.uid())));

create policy trips_insert on public.trips
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy trips_update on public.trips
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy trips_delete on public.trips
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- trip_members ----------------------------------------------------------------
-- Read: fellow members. Add people: trip owner. Edit: your own row (but you
-- cannot change your own role) or, for the owner, any row. Remove: yourself
-- (leave the trip) or, for the owner, anyone.
create policy trip_members_select on public.trip_members
  for select to authenticated
  using (public.is_trip_member(trip_id, (select auth.uid())));

create policy trip_members_insert on public.trip_members
  for insert to authenticated
  with check (public.is_trip_owner(trip_id, (select auth.uid())));

create policy trip_members_update on public.trip_members
  for update to authenticated
  using (user_id = (select auth.uid())
         or public.is_trip_owner(trip_id, (select auth.uid())))
  with check (
    public.is_trip_owner(trip_id, (select auth.uid()))
    or (user_id = (select auth.uid())
        and role = public.member_role(trip_id, user_id))
  );

create policy trip_members_delete on public.trip_members
  for delete to authenticated
  using (user_id = (select auth.uid())
         or public.is_trip_owner(trip_id, (select auth.uid())));

-- preferences: private to the person who wrote them ----------------------------
create policy preferences_select on public.preferences
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy preferences_insert on public.preferences
  for insert to authenticated
  with check (user_id = (select auth.uid())
              and public.is_trip_member(trip_id, (select auth.uid())));

create policy preferences_update on public.preferences
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
              and public.is_trip_member(trip_id, (select auth.uid())));

create policy preferences_delete on public.preferences
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- stays -----------------------------------------------------------------------
create policy stays_select on public.stays
  for select to authenticated
  using (public.is_trip_member(trip_id, (select auth.uid())));

create policy stays_insert on public.stays
  for insert to authenticated
  with check (public.is_trip_member(trip_id, (select auth.uid()))
              and added_by = (select auth.uid()));

create policy stays_update on public.stays
  for update to authenticated
  using (public.is_trip_member(trip_id, (select auth.uid())))
  with check (public.is_trip_member(trip_id, (select auth.uid())));

create policy stays_delete on public.stays
  for delete to authenticated
  using (public.is_trip_member(trip_id, (select auth.uid())));

-- itinerary_items -------------------------------------------------------------
create policy itinerary_items_all on public.itinerary_items
  for all to authenticated
  using (public.is_trip_member(trip_id, (select auth.uid())))
  with check (public.is_trip_member(trip_id, (select auth.uid())));

-- expenses --------------------------------------------------------------------
create policy expenses_all on public.expenses
  for all to authenticated
  using (public.is_trip_member(trip_id, (select auth.uid())))
  with check (public.is_trip_member(trip_id, (select auth.uid())));

-- expense_splits: tied to the trip of their expense; the person being charged
-- must also be a member of that trip.
create policy expense_splits_all on public.expense_splits
  for all to authenticated
  using (public.is_trip_member(public.expense_trip_id(expense_id), (select auth.uid())))
  with check (
    public.is_trip_member(public.expense_trip_id(expense_id), (select auth.uid()))
    and public.is_trip_member(public.expense_trip_id(expense_id), user_id)
  );

-- payments --------------------------------------------------------------------
create policy payments_all on public.payments
  for all to authenticated
  using (public.is_trip_member(trip_id, (select auth.uid())))
  with check (public.is_trip_member(trip_id, (select auth.uid())));
