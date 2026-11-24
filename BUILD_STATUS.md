# Build status

Real application, not a demo. Production starts empty: no seeded trips, members,
mock APIs, simulated AI or invented prices. Test fixtures exist only inside
`tests/` (in-memory Postgres).

- Live URL: https://byop-iota.vercel.app (Vercel Hobby, deploys `main`)
- Database/Auth: Supabase project `bbqsuwsloegyjutbefjd` (Free plan)
- Stack: Next.js 16 App Router + TypeScript, Supabase Postgres/Auth with RLS,
  Tailwind CSS 4, Vitest + PGlite for database tests
- Plan: [REAL_BUILD_PLAN.md](REAL_BUILD_PLAN.md) (screen map, provider
  dependencies, migration plan, seven-stage checklist)

## Latest: real-build audit and demo-fallback removal

Date: 2026-11-24. Branch: `chore/real-build-audit`. Backup taken first:
`backup/pre-real-build-audit-2026-11-24` (pushed, = `main` at `d9d8e17`).
No database change; no remote record or browser data deleted.

### Changed
- Failed reads now show an error screen with "Try again" instead of fake
  emptiness: `/trips` (was "no trips"), stays (was 1 person sharing / empty
  list / 404), preferences (was a blank form that could overwrite saved
  answers), join (was "invalid link"). Shared `components/load-error.tsx`;
  `error.tsx` added for `/trips` and `/join/[token]`.
- Stays never invent numbers: rows missing price, rooms or beds are listed
  under "Missing details" and not ranked (was ₹0 / 1 room / 1 bed); a missing
  price-check date reads "not recorded" and counts as stale (was "today").
- Sample-price and sample-location placeholders replaced with format hints.
- `/trips` empty state: "No trips yet" with what to do next.
- `/account`: "Old demo data in this browser". Reads only the legacy
  prototype keys `group-travel-demo` and `__demo_probe__`, warns, and
  deletes them only after a second confirming click.
- `.env.example` now holds variable names only.
- `npm run scan:secrets` (`scripts/scan-secrets.mjs`): redacted secret scan of
  tracked files, untracked files, full git history and ignored env files.

### Verified (exact commands, real results, 2026-11-24)
```
$ npx tsc --noEmit        -> exit 0
$ npm run lint            -> exit 0
$ npm test                -> Test Files 10 passed (10), Tests 132 passed (132)
$ npm run build           -> Compiled successfully, 15/15 pages generated
$ npm run scan:secrets    -> tracked files (82): no findings
                             untracked, not ignored (8): no findings
                             git history (9 commits, all branches): no findings
                             git-ignored env files (1): .env.local, variables
                               NEXT_PUBLIC_SUPABASE_URL,
                               NEXT_PUBLIC_SUPABASE_ANON_KEY;
                               supabase-publishable-key sb_p…(46 chars)
                             Result: PASS
$ node scripts/scan-secrets.mjs ~/BYOP   (legacy prototype) -> 42 files, no findings, PASS
```
Scanner self-test on planted fake values detected a 40-hex client secret,
an `sb_secret_` key, a `ghp_` token and a hard-coded `api_key` (then deleted).

Browser check on the local dev server (localhost:3000, real Supabase, signed in
with GitHub): Account showed "None found" (the prototype ran on another origin).
After planting a test `group-travel-demo` key: the warning listed it (67
bytes); the first click only opened the confirmation; confirming removed
`group-travel-demo` and left this origin's unrelated keys (`cart`,
`savedDishes`, `theme`) in place. The stays page loaded with "1 person
sharing" and the empty state.

Deployed 2026-11-24: `main` fast-forwarded to `6bf6725`; Vercel production
deploy Ready. Live checks on https://byop-iota.vercel.app (signed in):
- `/account`: "Old demo data in this browser · None found. Nothing to clean up."
- stays: nightly price placeholder "Amount in ₹"; summary "… · 1 person sharing".
- `/trips` lists the one existing trip; Trip home still shows
  "Goa · 5–8 Feb 2027" and the Decide summary from stage 1.
The error screens were not triggered live (that needs a database outage); they
are covered by the build and code review only.

### Known issues found, not fixed in this pass
- `/account` logs a Next.js dev warning: `Date.now()` during prerender inside
  `AccountDetails` (code from before this pass).
- See REAL_BUILD_PLAN.md §7 (stays error messages; organiser can set dates
  outside an open vote; no UI writes itinerary items).

## Stage 1: 01 Trip home + 02 Decide (PRD part 1, planning)

Date: 2026-11-24. Branch: `feat/decide-stage`.

### What was built

**01 Trip home** (`/trips/[id]`)
- Trip name, where/when (or "still to be decided"), member avatars.
- Stage tabs in PRD order: Decide, Shape, Book, Prepare (`?tab=`).
  - Decide: who's coming, dates, preference cards, destination, each linking
    into 02.
  - Shape: the existing map; itinerary builder marked "not built yet".
  - Book: the existing stay comparison.
  - Prepare: marked "not built yet"; nothing saved.
- One **Next step** card. Plain rules in `lib/decide.ts`, not AI, in Decide
  order: your RSVP, your dates vote, your private card, your destination vote,
  suggest dates/destination, (planners) settle a fully-voted poll, who the group
  is waiting on, then "Decide is done". Shows who nudged you.

**02 Decide** (`/trips/[id]/decide`), in PRD order
1. Trip name: editable by organiser or co-planner.
2. Invite link and roles: copy link; organiser sets Co-planner / Traveller.
3. Who's coming: your RSVP (In / Maybe / Not yet), group counts, everyone's
   status, Nudge for anyone "Not yet".
4. Dates vote: anyone suggests date ranges; one vote per person (changing it
   replaces it); counts and voter names; who still has to vote, with Nudge;
   organiser/co-planner settles (writes the trip's dates) or reopens.
5. Private preference card link (existing; answers stay private).
6. Destination vote: same mechanics; settling writes the trip's destination.

Loading skeletons, empty states, an error screen with "Try again"
(`app/trips/[id]/error.tsx`), pending button states, error/success messages
announced to screen readers, 44px touch targets, mobile-first layouts.

### Security model
- Every mutation is a server action that checks the session, validates input,
  then calls ONE `security definer` Postgres function that re-checks
  membership and role, validates again, and runs as one transaction.
- New tables (`polls`, `poll_options`, `poll_votes`, `nudges`) are read-only to
  signed-in members via RLS; there are no insert/update/delete grants, so the
  public API cannot write them directly.
- A trigger on `trip_members` stops the organiser changing anyone else's RSVP
  and keeps the organiser role tied to the trip creator, even through direct
  table updates the older policy allows.
- No service-role key anywhere. Reads are per request, scoped by RLS to the
  signed-in user's trips; nothing is cached across users.
- Retry-safe: same suggestion twice returns the same option; re-voting is an
  upsert; settling the same option twice is a no-op; nudges are limited to one
  per person per topic per 12 hours.

### Migrations

Apply in Supabase → SQL Editor, in order, once each:

| File | Status on `bbqsuwsloegyjutbefjd` |
|---|---|
| `supabase/schema.sql` | applied (checked 2026-11-24) |
| `supabase/002_trip_flow.sql` | applied (checked) |
| `supabase/003_stay_comparison.sql` | applied (checked) |
| `supabase/004_map_locations.sql` | applied (checked) |
| `supabase/005_grants.sql` | applied (checked) |
| `supabase/006_decide.sql` | applied 2026-11-24 via SQL Editor ("Success. No rows returned") |

006 is additive: new tables, functions, a trigger and two `trip_members`
columns. It widens the `trip_members.role` check (adds `co_planner`); no data
is dropped or rewritten. Supabase's "destructive operation" warning on it is
triggered by that `drop constraint` / re-add and the `revoke` lines.

Read-only check before applying (2026-11-24): 002–005 present, 006 absent,
`trips` = 0 rows. Read-only check after applying: 4 new tables, RLS on for
all 4, 9 functions present, `authenticated` has no INSERT on `polls`, `anon`
has no SELECT on `polls`, `trip_members.rsvp` exists, `trips` = 0 rows.

### Verified (exact commands, real results, 2026-11-24)

```
$ npx tsc --noEmit        -> exit 0
$ npm run lint            -> exit 0, no warnings
$ npm test                -> Test Files 9 passed (9), Tests 128 passed (128)
$ npm run build           -> Compiled successfully; /trips/[id] and
                             /trips/[id]/decide built as partial prerender
```

New tests:
- `tests/decide-rls.test.ts` (28 tests): runs the real migrations in PGlite
  and checks roles, RSVP, votes, settle/reopen, nudges, direct-write blocking,
  outsider and signed-out access.
- `tests/decide.test.ts` (18 tests): next-step rules, poll tallies, decision
  states, formatting, input parsing.

**Live end-to-end on https://byop-iota.vercel.app** (2026-11-24, deploy of
`044d69c`, Vercel status Ready, signed in with GitHub as one real user):
- Created trip "Decide live check"; Trip home showed "Where and when are still
  to be decided" and next step "Are you coming?".
- RSVP In → counts "1 in · 0 maybe · 0 not yet".
- Suggested 22–25 Jan 2027 and 5–8 Feb 2027; voted 5–8 Feb ("1 vote ·
  leading", "Your vote").
- Suggested 1–4 Mar 2025 → database message "Those dates are in the past".
- Settled dates on 5–8 Feb → "Settled: 5–8 Feb 2027" with Reopen.
- Suggested Goa, voted, settled → "Settled: Goa".
- Renamed trip → "Decide live check (renamed)".
- Trip home then showed "Goa · 5–8 Feb 2027", Decide rows updated, and next
  step "Fill in your private preference card". Shape tab showed the map;
  Prepare showed its "not built yet" state.

**Not verified live (multi-person):** joining by invite, a second member's
RSVP/votes, co-planner role change, and nudges between people. These are
covered only by the database tests so far; they need a second real account.

### Setup still needed
1. Done: 006 applied; `feat/decide-stage` merged to `main` and deployed.
2. Multi-person live check with a second GitHub account: join via invite,
   RSVP, vote, nudge, make them co-planner, let them settle.
3. The live check left one trip in production: "Decide live check
   (renamed)", owned by aiteam17-bot. Delete it or keep it as your first trip.
4. Optional: `npm run test:live` needs Supabase "Confirm email" switched off
   while it runs. It has not been run for this stage.

### Known limits
- Nudges are in-app only (shown on the recipient's next-step card). No email,
  push or chat messages are sent.
- Any member can suggest options and nudge; only the organiser or a co-planner
  settles. There is no fixed approval threshold.
- Reopening a vote keeps the trip's current dates/destination until it is
  settled again.
- No way yet to remove a member or transfer the organiser role.
- The PRD's "AI best window" for dates and the anonymous budget band (03) are
  not part of this stage; the next-step card is rule-based, not AI.
- Display names come from the join form or the email's first part.
- Not yet tested with a screen reader.
- Trip home's browser tab title is the generic "Group Trip Planner".

### Next checkpoint
03 Anonymous budget: private per-member range, group sees only a rounded
comfort zone once at least 3 have answered, enforced in the database.
