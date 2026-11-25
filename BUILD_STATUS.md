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

## Latest: Shape stage, PRD 05 itinerary + 06 map/comments (2026-11-25)

Branch `feat/shape-itinerary` (built on `feat/budget-privacy`). Not merged,
not deployed. **Migrations 008 and 009 are not applied to production**, so
nothing from PRD 03, 05 or 06 is live, and none of it has been seen in a
browser against a real database yet.

### Built
- **009_itinerary.sql** (additive; no rows, tables or columns dropped):
  - Stops: day number + local start time in the trip time zone (date-only
    days); `starts_at timestamptz` derived by trigger from trip start date +
    day + time + timezone and recomputed when those change; duration,
    indicative cost per person (minor units), notes, author, timestamps.
  - `stop_votes` (for/against, one per person) and `stop_comments`.
  - Direct writes to itinerary_items revoked. Functions: `add_stop`,
    `update_stop`, `delete_stop`, `vote_stop`, `add_comment`,
    `delete_comment`. Each checks membership and role, validates and runs in
    one transaction. Add stop / add comment are retry-safe (client key).
    Changing a stop's day, time, length, place or cost restarts its votes.
  - Permissions: anyone on the trip adds stops, votes and comments; only
    the author or the organiser/co-planners edit, move or delete a stop or
    delete a comment.
- **Itinerary screen** `/trips/[id]/itinerary?day=N` in PRD order: day tabs
  (dated when the trip has dates), stops by time with status (proposed /
  agreed by everyone / needs a decision) and who voted, For / Against /
  Withdraw, comments, edit-or-move and delete (inline confirm), add-a-stop
  form, timing-clash warnings in words (overlaps, past midnight), and the
  day's map (stays + that day's stops).
- **Honest limits shown on screen:** distances are "straight line, not a
  route or travel time"; costs say "entered by a member".
- Shape tab summary (stops / agreed / waiting for your vote); Next step asks
  you to vote on unvoted stops once Decide is done.

### Verified (exact commands, real results)
```
$ npx tsc --noEmit        -> exit 0
$ npm run lint            -> exit 0
$ npm test                -> Test Files 15 passed (15), Tests 204 passed (204)
                             (new: tests/itinerary-rls.test.ts, tests/itinerary.test.ts)
$ npm run build           -> Compiled successfully; /trips/[id]/itinerary built (partial prerender)
$ npm run scan:secrets    -> 102 tracked files, 15 commits: no findings; PASS
```
Database tests (real SQL in PGlite) cover: instants from date + time +
time zone (6 Feb 10:00 IST = 04:30 UTC) and recomputation after date or
time-zone changes; validation (days beyond the trip, missing time,
duration, blank names, `javascript:` links, half locations, negative cost);
retry-safe adds; direct writes refused; outsiders see and add nothing;
non-authors cannot edit or delete; planners can; moving restarts votes;
one vote per person, replace and withdraw; comments idempotent, outsider
blocked, author/planner delete; leaving the trip removes your votes and
comments.

### Not done / known limits
- **Live "who is editing" marker (PRD 06) is not built.** It needs Supabase
  Realtime presence on private channels with RLS on `realtime.messages`;
  left for a later checkpoint rather than shipped untested.
- No travel times: needs a routing provider (free OSRM demo is not for
  production; others are paid). Stop for a provider decision.
- No arrival/departure-day checks: there are no flight/arrival records yet.
- Not verified in a browser or against Supabase (008 and 009 not applied).

### Setup still needed (your dashboard)
1. Apply `supabase/008_budget_privacy.sql`, then `supabase/009_itinerary.sql`,
   in Supabase → SQL Editor (I can do this with your go-ahead).
2. Merge `feat/shape-itinerary` to `main` to deploy.
3. Authenticated API tests (`npm run test:api`) still need a separate test
   project and a sign-in route that keeps "Confirm email" on.
4. Email provider is still Enabled in production.

### Next checkpoint
Apply 008 + 009, deploy, and check PRD 01–06 live with two real accounts.
Then PRD 07 commitment ladder.

## Earlier: fix for "Date.now() while prerendering" (2026-11-24)

Branch `feat/budget-privacy` (not merged, not deployed; migration 008 is not
applied to production yet).

**Failing checkpoint.** The known issue recorded under the audit: Next.js dev
server log `.next/dev/logs/next-development.log` lines 13–19:
`Route "/trips" | "/account" | "/trips/[id]/stays": Next.js encountered the
unstable value Date.now() while prerendering`. Vercel production runtime logs
had no matching entries (dev-time validation).

**Smallest cause.** `lib/supabase/server.ts` `createClient()` awaited only
`cookies()`. With `partialPrefetching` on, Next pre-renders at request time
with cookies available, so supabase-js's own `Date.now()` (session-expiry
check in `auth.getUser()`) ran inside that pre-render on every route using
the server client.

**Fix (one file).** `createClient()` now awaits `connection()` after
`cookies()`, so Supabase work runs only for the real request. No data, RLS,
auth or schema change; no existing user record touched.

**Regression test.** `tests/supabase-server.test.ts` asserts the call order
cookies → connection → createServerClient. Without the fix it failed
(`- "connection"` missing); with it, it passes.

**Results (exact):**
```
$ npx vitest run tests/supabase-server.test.ts -> Tests 1 passed (1)
$ npx tsc --noEmit                              -> exit 0
$ npm run lint                                  -> exit 0
$ npm test                                      -> Test Files 13 passed (13), Tests 181 passed (181)
$ npm run build                                 -> Compiled successfully, exit 0
```
Rerun of the original failure on the running dev server (localhost:3000,
signed in with GitHub): `/trips/<id>/stays`, `/trips` and `/account` rendered
with real data; new log lines contain 0 `Date.now()` errors.

Other evidence in the same log, not a code fault: lines 30–33
`AuthApiError: Invalid Refresh Token: Refresh Token Not Found` when opening
`/account` on localhost. That session had been revoked by signing out on the
live site (Supabase `signOut()` defaults to signing out every device); the app
correctly treated it as signed out.

**Still needs your dashboard action (unchanged by this fix):**
- `npm run test:api` fails before running: `.env.test.local` does not exist
  and Supabase shows only 1 project. It needs a separate test project, and a
  sign-in route that does not require switching "Confirm email" off.
- Supabase Email provider is still Enabled in production.
- Migration 008 is not applied to production (waiting on the above).

## Earlier: Supabase foundation (migration 007)

Date: 2026-11-24. Branch `feat/supabase-foundation`, merged to `main` at
`8a6668c`. Applied to Supabase project `bbqsuwsloegyjutbefjd` and deployed.

### What changed
- **007_foundation.sql** (additive: no rows, tables or columns deleted;
  policies and grants replaced):
  - `schema_versions` records migrations 1 to 7 in the database.
  - Default deny: future objects get no automatic grants; every table and
    function is granted explicitly; signed-out visitors can run only
    `health_check()`.
  - Helpers moved to a `private` schema (not reachable via the API) that
    answer only for the signed-in user. The old helpers that accepted any
    user id (`is_trip_member`, `is_trip_owner`, `member_role`,
    `expense_trip_id`, `can_plan`) and the old `invite_preview` / `join_trip`
    lost EXECUTE; they remain, unused.
  - Explicit permission matrix (`private.role_allows`) for owner,
    co-planner and member; every policy re-created on it with USING and
    WITH CHECK.
  - Triggers stop rows moving between trips/people and stop the organiser's
    membership being removed while the trip exists. No direct membership
    inserts: joining is by invite only; roles change only via
    `set_member_role`.
  - `profiles`, created on sign-up from GitHub details; backfilled for
    existing accounts.
  - Invites: `trip_invites` stores only a SHA-256 hash; links expire (1/7/30
    days) and can be revoked; `preview_invite` shows only the trip name and
    destination; `redeem_invite` is authenticated, transactional, idempotent
    and rate limited (10 wrong tokens per 15 minutes). The old plaintext
    `trips.invite_token` column is kept but no longer readable or writable;
    existing tokens were copied as hashed invites valid for 7 days.
- **App**: GitHub-only sign-in (no Supabase default SMTP); proxy verifies the
  session with `getClaims()`; join flow on `preview_invite` /
  `redeem_invite`; Decide has create-once / list / revoke for invite links;
  Account shows the profile name; `/api/health` checks the database.

### Verified (exact commands and real results)
```
$ npx tsc --noEmit        -> exit 0
$ npm run lint            -> exit 0
$ npm test                -> Test Files 11 passed (11), Tests 157 passed (157)
                             (25 new in tests/foundation-rls.test.ts)
$ npm run build           -> Compiled successfully, 15/15 pages
$ npm run scan:secrets    -> no findings in tracked files, untracked files or
                             11 commits; .env.local reported by names only; PASS
```
Supabase SQL Editor: 007 ran with "Success. No rows returned" (after the
expected "destructive operation" warning for the policy drops and revokes).
Read-only check afterwards: versions `1,2,3,4,5,6,7`; tables without RLS 0;
anon table grants 0; SECURITY DEFINER functions without a pinned
search_path 0; definer functions executable by anon 0; old
`is_trip_member` executable by authenticated: false; profiles 10 = users 10;
trip_invites 1 (the existing trip's link, hashed); trips 1 (kept).

Live on https://byop-iota.vercel.app (signed in with GitHub):
- `/api/health` → `200 {"status":"ok","database":"ok"}`.
- Created trip "Foundation check" → organiser membership present ("1 not
  yet"); after a hard reload it is still there and listed in `/trips`.
- Decide: "Create invite link" showed the link once (64-hex token) and the
  list "expires 1 Dec 2026 · 0 joined". Opening it as the organiser showed
  only the trip name and "You're already on this trip"; "Open the trip" kept
  "0 joined" and 1 member (idempotent). After "Revoke", the list showed "No
  active links" and the link showed "This invite link isn't valid".
- Account: "Signed in as aiteam17-bot" (backfilled profile).
- Sign out → opening `/trips/<id>/decide` redirected to `/login` (GitHub only);
  signing in again returned to that exact page.

### Not verified / still to do
- **Supabase Email provider is still Enabled** (checked 2026-11-24 after
  setup). The app no longer offers email sign-in, but the provider still
  accepts email sign-ups through the API. Switch it off: Authentication →
  Sign In / Providers → Email → disable → Save.
- A brand-new account seeing no trips is proven in the database tests, not
  live: it needs a second GitHub account.
- Between applying 007 and the new deploy (about 1 minute), trip pages on
  the old deploy could not read `invite_token` and showed the error screen.
- `npm run test:live` was not run (needs the Email provider on and "Confirm
  email" off while it runs).
- Production now holds two test trips by aiteam17-bot: "Decide live check
  (renamed)" and "Foundation check".

## Earlier: real-build audit and demo-fallback removal

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
| `supabase/007_foundation.sql` | applied 2026-11-24 via SQL Editor; recorded in `schema_versions` |

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
