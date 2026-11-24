# Real build plan

How the Group Travel Planning Platform PRD (19 Nov 2026, 7 pages, 17 screens)
becomes a real application. Audit date: 2026-11-24. The audit was read-only:
no database change was made for it.

## 1. Which code is the application

| Location | What it is | Decision |
|---|---|---|
| `~/Desktop/BYOP` (this repo, GitHub `aiteam17-bot/BYOP`) | Next.js 16 App Router + TypeScript, Supabase Auth/Postgres with RLS, deployed at https://byop-iota.vercel.app | **The real application.** All work happens here. |
| `~/BYOP` (separate folder, not a git repo, never deployed) | Front-end-only Vite + React prototype with fixtures, a scripted "Simulated AI" and browser storage | **Legacy reference only.** Not shipped, not migrated. Its screens are a design reference. |

**Stack check:** the target stack (Next.js App Router, TypeScript, Supabase
Postgres/Auth/Storage, migrations, RLS) is the stack this repo already runs.
No framework migration decision is needed. The prototype's Vite stack could
not support server auth or RLS; it is retired, not converted.

## 2. Screen map: 17 PRD screens and Prepare

| # | PRD screen | Route today | Status |
|---|---|---|---|
| 01 | Trip home: stage tabs, one next-step card | `/trips/[id]` | **Built** (stage 1). Next step is rule-based, not AI. |
| 02 | Decide: invite, roles, RSVP, date poll, destination vote, nudges | `/trips/[id]/decide` | **Built** (stage 1). Multi-person live check pending. |
| 03 | Anonymous budget: private range, group sees rounded band | `/trips/[id]/preferences` (private range only) | **Partial.** Private per-person range stored with owner-only RLS. Group comfort band not built. |
| 04 | Trip options: AI generator (Tight / Balanced / Splurge) | none | **Not built.** Needs a model-provider decision (paid). |
| 05 | Itinerary day view: stops, times, travel, votes | none (`itinerary_items` table exists, no UI writes it) | **Not built.** |
| 06 | Itinerary map and comments: live editing marker | `/trips/[id]?tab=shape` (map only) | **Partial.** OSM map of stays and itinerary pins. No comments, no live presence. |
| 07 | Commitment ladder: Curious, Likely, Locked-in | none | **Not built.** |
| 08 | Stay comparison: per-person price, cancellation, votes | `/trips/[id]/stays` | **Partial.** True cost per person, cancellation type, staleness. No votes, no reservation import. |
| 09 | Booking order: flights → stay → docs → tickets → transport → meals | none | **Not built.** |
| 10 | Member requests: one-tap asks with a reminder | in-app nudges inside `/trips/[id]/decide` | **Partial.** RSVP/vote nudges only, in-app only. |
| 11 | Planner concierge: chat that edits the plan via proposals | none | **Not built.** Needs a model provider (paid). |
| 12 | Check in / shared trip wallet: tickets, confirmations, offline | none | **Not built.** Needs Supabase Storage. |
| 13 | Today view and auto re-plan | none | **Not built.** Needs weather / flight-status / opening-hours providers. |
| 14 | Quick expense log: amount, category, who paid, splits, currency | none (`expenses`, `expense_splits` tables exist, no UI) | **Not built.** Multi-currency needs an FX source. |
| 15 | Checkout-day planner: luggage, leave-by times, last activity | none | **Not built.** |
| 16 | Settle up: fewest transfers, UPI pay links | none (`payments` table and `trip_members.upi_vpa` exist, no UI) | **Not built.** |
| 17 | Trip story and travel map, places-been sync, next trip | none | **Not built.** Opt-in places-been is a privacy decision (PRD risk list). |
| — | Prepare tab: expense split setup, packing checklist, offline download | `/trips/[id]?tab=prepare` | **Not built.** Tab shows an honest "not built yet" state. |

Other routes: `/` landing, `/login` (GitHub OAuth + email link),
`/auth/callback`, `/account`, `/trips` (list), `/trips/new`, `/join/[token]`,
`/api/health`.

## 3. Demo-data audit

### Real app (this repo), runtime code

| Category | Finding | Action taken |
|---|---|---|
| Seed data | None. No SQL file inserts rows; every `insert` is inside a function or trigger. Production `trips` count was 0 before the stage-1 live check. | None needed. New installs start with zero trips. |
| Fixture imports | None in runtime code. Fixtures exist only in `tests/` (PGlite users ALICE…ERIN, in-memory storage stand-in). | Kept (tests only). |
| Fake / mock APIs | None. | — |
| Hardcoded users | None. Identity is always the Supabase session. | — |
| Simulated AI | None. Next-step card is labelled rules, not AI. | — |
| localStorage / browser stores | None written by the app (Supabase's own auth cookie only). | — |
| Silent fallbacks (failed read shown as data) | `/trips`: error → "no trips"; stays: member-count error → 1 person (wrong per-person cost), errors → empty list, trip error → 404; preferences: read error → blank form that could overwrite saved answers; join: lookup error → "invalid link". | **Fixed:** each now throws to an error screen with "Try again" (`components/load-error.tsx`, `error.tsx` for `/trips`, `/trips/[id]`, `/join/[token]`). |
| Invented values | Stays: missing nightly price → ₹0 (ranked cheapest); missing rooms/beds → 1; missing price-check date → "checked today". | **Fixed:** incomplete stays listed separately and never ranked; missing check date shown as "not recorded" and treated as stale. |
| Sample prices in UI | Placeholders `10000`, `25000` (budget), `12000`, `5760`, `1500` (stay), `3`/`6` rooms/beds, `2.5` km, Goa coordinates. | **Replaced** with format hints ("Amount in ₹", "latitude, longitude"). Text examples like "Goa with the gang" kept as name hints. |

### Legacy prototype (`~/BYOP`), for the record. Not changed.

| Category | Where |
|---|---|
| Seed / fixture | `src/data/fixture.ts` (one trip "Goa, finally", 5 members, polls, stops, stays, fares); imported at runtime by `src/state/store.tsx`, `src/state/reducer.ts`, `src/state/persistence.ts` |
| Hardcoded users | `src/data/fixture.ts:39-45` Friend A–E; `session.currentMemberId` = A; `src/components/DemoBar.tsx` "Viewing as" switcher |
| Sample prices | `src/data/fixture.ts` fares 5,500 / 7,000 / 10,500, stay and place prices; `src/data/templates.ts` per-day rates |
| Simulated AI | `src/lib/generator.ts` ("Simulated AI · local templates and rules · no model API"), `src/data/templates.ts`, scripted Planner proposals in the fixture |
| Browser storage | `src/state/persistence.ts`: `localStorage` key **`group-travel-demo`** (versioned envelope) and transient probe key **`__demo_probe__`** |

**Legacy storage cleanup:** `/account` now has "Old demo data in this
browser". It reads only those two keys, shows what it found and its size, warns
that removal cannot be undone, and deletes them only after a second confirm
click. It never runs automatically and touches no other key and no database
row. Browsers isolate storage per site, so on byop-iota.vercel.app (or
localhost:3000) it will normally report "None found": the prototype ran at
`127.0.0.1:5173`. To clear a prototype browser, use the prototype's own
"Reset demo" control at that address.

## 4. Provider dependencies

| Need | Provider (current or candidate) | Cost / limit | Status |
|---|---|---|---|
| Hosting | Vercel Hobby | Free, personal/non-commercial only | In use |
| Auth, Postgres, RLS | Supabase Free | Free tier; project pauses after a week idle; 500 MB DB | In use |
| Sign-in | GitHub OAuth (via Supabase) | Free; each friend needs a GitHub account | In use, verified live |
| Email sign-in links | Supabase built-in SMTP | Very low hourly limit; custom SMTP for real use | In use (fallback) |
| Map tiles | OpenStreetMap tile servers | Free, light use only (policy in `lib/map-config.ts`) | In use |
| File storage (tickets, photos) | Supabase Storage | 1 GB free | Needed for 12, 17 |
| Realtime (live editing marker, comments) | Supabase Realtime | Free tier limits | Needed for 06 |
| AI trip options, concierge, re-plan | LLM API (e.g. Anthropic Claude) | **Paid.** Stop and ask before adding. | Needed for 04, 11, 13 AI layer |
| Geocoding / place search | Nominatim (1 req/s, attribution) or paid | Free with strict policy / paid | Needed for 05, 06 |
| Travel times | Routing API (OSRM demo is not for production) | Usually paid | Needed for 05, 15 |
| Weather | Open-Meteo | Free for non-commercial | Needed for 13 |
| Flight status | Commercial API | Paid | Needed for 13 (optional) |
| FX rates | ECB-based free API | Free | Needed for 14 |
| Reminders beyond the app | Email (Resend etc.) or web push | Free tiers / paid | Needed for 10 |
| UPI pay links | `upi://pay` deep links | No provider | Needed for 16 |
| Booking | Affiliate deep links | PRD open question | Undecided |

Rule: no paid provider is added without an explicit decision. Every AI
feature ships first as a labelled rule-based baseline with real data.

## 5. Migration plan

Current process: numbered SQL files in `supabase/`, pasted into the Supabase
SQL Editor once each, in order. Applied on `bbqsuwsloegyjutbefjd`: `schema.sql`,
`002`–`006`. Every migration is additive, comes with PGlite tests that run the
real SQL, and is checked read-only before and after applying.

Planned (one per stage, numbers indicative):

| File | Stage | Adds |
|---|---|---|
| `007_budget_band.sql` | 2 | `trip_budget_band(trip)` security-definer function: returns only count + rounded band, and only when ≥ 3 answered; no per-person rows exposed |
| `008_member_requests.sql` | 2 | `member_requests` (ask, target, due, status), generalising nudges |
| `009_itinerary.sql` | 3 | itinerary stop fields (duration, cost, status), `stop_votes`, `comments`, RPCs |
| `010_trip_options.sql` | 3 | `trip_options` + `plan_proposals` (from rules first, model later) |
| `011_commitment_bookings.sql` | 4 | `commitments` (ladder), `stay_votes`, `bookings` (order, status, who booked) |
| `012_prepare.sql` | 5 | packing items, document checklist, split setup |
| `013_wallet_storage.sql` | 6 | Storage bucket + RLS for tickets; wallet entries |
| `014_expenses_v2.sql` | 6 | currency, category, FX snapshot on `expenses`; RPC to add expense + splits atomically |
| `015_settle_up.sql` | 7 | settlement plan function; payment confirmations |
| `016_trip_story.sql` | 7 | opt-in `places_visited`, trip archive/share |

Decision for later (not taken now): move to Supabase CLI migrations
(`supabase/migrations/<timestamp>_*.sql`) with a migration history table, so
applied state is tracked by the database rather than by BUILD_STATUS.md.

## 6. Seven-stage feature checklist

Each stage: migration + RLS + tests, real-data forms, loading/empty/error
states, lint/typecheck/build/tests, live end-to-end check, BUILD_STATUS.md.

**Stage 1. Decide (01, 02)** ✅ built and live
- [x] Trip home hub, stage tabs, rule-based next step
- [x] Roles, RSVP, invite link, dates vote, destination vote, in-app nudges
- [ ] Live check with two real accounts (join, co-planner, nudge)

**Stage 2. Budget and requests (03, 10 baseline)**
- [ ] Group comfort band from private ranges (≥ 3 answers, rounded), DB-enforced
- [ ] "No shared range" state with what to revisit
- [ ] Member requests: ask a person, due date, auto-close when done

**Stage 3. Shape the plan (05, 06, 04 baseline)**
- [ ] Itinerary day view: add/edit/move stops, times, cost, votes, clash warnings
- [ ] Map with comments; live "who is editing" marker
- [ ] Trip options from real inputs (rules, clearly labelled); AI only after a provider decision

**Stage 4. Commitment gate and Book (07, 08, 09)**
- [ ] Commitment ladder (Curious, Likely, Locked-in), gate opens booking
- [ ] Stay votes and reservation record
- [ ] Booking order checklist with who booked what

**Stage 5. Prepare and AI layer (Prepare, 11, 10 full)**
- [ ] Packing checklist, documents, expense-split setup, offline download
- [ ] Planner concierge (paid provider decision first); every change is a proposal
- [ ] Reminders outside the app (email/push decision)

**Stage 6. Travel (12, 13, 14, 15)**
- [ ] Shared wallet with stored tickets and access control
- [ ] Today view (timeline, offline), re-plan proposals
- [ ] Quick expense log, multi-currency, splits
- [ ] Checkout-day planner

**Stage 7. Coming back (16, 17)**
- [ ] Settle up: fewest transfers, UPI links, polite reminders
- [ ] Archive and share; trip story; opt-in places-been sync; next trip from this one

## 7. Known gaps found in the audit (not demo data)
- The `removeStay` server action ignores database errors, so a failed remove
  shows no message. `setTripDates` reports any failure as "Only the organiser
  can change the trip dates", even for network errors. Fix both when stays get
  votes (stage 4).
- The organiser can still set dates directly on the stays page while a dates
  vote is open; settling the vote later overwrites them. Route date changes
  through the Decide vote in stage 2.
- No UI writes `itinerary_items` yet, so the map's itinerary pins only appear
  for rows added outside the app (stage 3).
