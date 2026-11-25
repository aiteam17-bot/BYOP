// supabase/010_places_quotes.sql against the real SQL: permissions, same-trip
// links, optimistic versions (two users editing) and stay-quote rules.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RETRIED_BY_POSTGREST, STALE_CODE } from "@/lib/db-errors";
import { ALICE, BOB, CAROL, ERIN, asUser, createDb, inviteAndJoin } from "./helpers/db";

const BLOCKED = /row-level security|permission denied/;
const STALE = /Someone else changed this first/;
let db: PGlite;
let trip: string; // Alice organiser, Bob member, Erin co-planner
let bobTrip: string; // Bob's own trip

async function rows<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await asUser<T>(db, userId, sql, params)).rows;
}
async function one<T>(userId: string, sql: string, params: unknown[] = []): Promise<T> {
  return (await rows<T>(userId, sql, params))[0];
}
const version = async (table: string, id: string) =>
  (await db.query<{ v: number }>(`select version as v from ${table} where id = $1`, [id])).rows[0].v;

const quote = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "Villa Sol",
    source_url: "https://example.com/villa",
    pricing_basis: "per_room_per_night",
    currency: "INR",
    quoted_amount_minor: 600000,
    nights: 3,
    rooms: 2,
    taxes_minor: null,
    fees_minor: 150000,
    sharers: 5,
    checked_at: "2026-11-20T10:00:00+05:30",
    ...over,
  });

beforeAll(async () => {
  db = await createDb();
  trip = (
    await one<{ id: string }>(
      ALICE,
      `insert into trips (name, start_date, end_date, timezone, currency)
       values ('Goa', '2027-02-05', '2027-02-08', 'Asia/Kolkata', 'INR') returning id`,
    )
  ).id;
  bobTrip = (await one<{ id: string }>(BOB, `insert into trips (name, timezone, currency) values ('Coorg', 'Asia/Kolkata', 'INR') returning id`)).id;
  await inviteAndJoin(db, ALICE, trip, BOB, "Bob");
  await inviteAndJoin(db, ALICE, trip, ERIN, "Erin");
  await asUser(db, ALICE, `select set_member_role($1, $2, 'co_planner')`, [trip, ERIN]);
});

afterAll(async () => {
  await db.close();
});

describe("saved lists and places", () => {
  let list: string;
  let place: string;

  it("members save places into lists; retries add one row", async () => {
    list = (await one<{ id: string }>(BOB, `select create_saved_list($1, 'Beaches') as id`, [trip])).id;
    const key = "33333333-3333-4333-8333-333333333333";
    place = (
      await one<{ id: string }>(
        BOB,
        `select create_place($1, $2, 'Butterfly Beach', 15.01, 73.95, 'https://example.com/b', null, now(), $3) as id`,
        [trip, list, key],
      )
    ).id;
    const again = (await one<{ id: string }>(BOB, `select create_place($1, $2, 'Butterfly Beach', null, null, null, null, null, $3) as id`, [trip, list, key])).id;
    expect(again).toBe(place);
    expect(await rows(ALICE, `select id from saved_places where trip_id = $1`, [trip])).toHaveLength(1);
  });

  it("a place cannot use another trip's list, even one you own", async () => {
    const otherList = (await one<{ id: string }>(BOB, `select create_saved_list($1, 'Hills') as id`, [bobTrip])).id;
    await expect(
      rows(BOB, `select create_place($1, $2, 'Wrong list')`, [trip, otherList]),
    ).rejects.toThrow(/not part of this trip/);
    // The constraint itself also refuses it.
    await expect(
      db.query(`insert into saved_places (trip_id, list_id, name) values ($1, $2, 'x')`, [trip, otherList]),
    ).rejects.toThrow(/foreign key/);
  });

  it("validates links, locations and dates", async () => {
    await expect(rows(BOB, `select create_place($1, null, 'x', null, null, 'javascript:alert(1)')`, [trip])).rejects.toThrow(/http/);
    await expect(rows(BOB, `select create_place($1, null, 'x', 15.0, null)`, [trip])).rejects.toThrow(/latitude and longitude/);
    await expect(rows(BOB, `select create_place($1, null, 'x', null, null, null, null, now() + interval '1 day')`, [trip])).rejects.toThrow(/future/);
  });

  it("only the author or a planner edits; a stale version is refused, not overwritten", async () => {
    const v = await version("saved_places", place);
    await expect(
      rows(ALICE, `select update_place($1, $2, 'Alice edit', null, null, null, null, null, $3)`, [place, list, v]),
    ).resolves.toBeDefined(); // organiser may edit
    // Bob still holds the old version: his edit must not silently win.
    await expect(
      rows(BOB, `select update_place($1, $2, 'Bob edit', null, null, null, null, null, $3)`, [place, list, v]),
    ).rejects.toThrow(STALE);
    expect((await one<{ name: string }>(BOB, `select name from saved_places where id = $1`, [place])).name).toBe("Alice edit");

    const alicePlace = (await one<{ id: string }>(ALICE, `select create_place($1, null, 'Fort') as id`, [trip])).id;
    await expect(
      rows(BOB, `select update_place($1, null, 'Mine', null, null, null, null, null, 1)`, [alicePlace]),
    ).rejects.toThrow(/Only whoever saved this/);
  });

  it("outsiders see nothing and nobody writes directly", async () => {
    expect(await rows(CAROL, `select * from saved_places`)).toEqual([]);
    await expect(rows(CAROL, `select create_place($1, null, 'x')`, [trip])).rejects.toThrow(/not a member/);
    await expect(rows(BOB, `insert into saved_places (trip_id, name) values ($1, 'x')`, [trip])).rejects.toThrow(BLOCKED);
    await expect(rows(ALICE, `update saved_places set name = 'x'`)).rejects.toThrow(BLOCKED);
  });

  it("deleting a list keeps its places", async () => {
    await asUser(db, BOB, `select delete_saved_list($1, $2)`, [list, await version("saved_lists", list)]);
    const p = await one<{ list_id: string | null }>(BOB, `select list_id from saved_places where id = $1`, [place]);
    expect(p.list_id).toBeNull();
  });
});

describe("plan variants and stops", () => {
  let variant: string;
  it("only planners manage variants", async () => {
    await expect(rows(BOB, `select create_variant($1, 'Splurge')`, [trip])).rejects.toThrow(/Only the organiser or a co-planner can manage plan variants/);
    variant = (await one<{ id: string }>(ERIN, `select create_variant($1, 'Splurge', 'Nicer stays') as id`, [trip])).id;
  });

  it("stops can belong to a variant and a saved place of the same trip only", async () => {
    const otherVariant = (await one<{ id: string }>(BOB, `select create_variant($1, 'Mine') as id`, [bobTrip])).id;
    await expect(
      rows(BOB, `select add_stop($1, 1, '10:00', 60, 'Spa', null, null, null, null, null, null, $2)`, [trip, otherVariant]),
    ).rejects.toThrow(/plan variant is not part of this trip/);
    const stop = (
      await one<{ id: string }>(BOB, `select add_stop($1, 1, '10:00', 60, 'Spa', null, null, null, null, null, null, $2, null, 25) as id`, [trip, variant])
    ).id;
    const s = await one<{ variant_id: string; travel_minutes_from_previous: number }>(
      ALICE,
      `select variant_id, travel_minutes_from_previous from itinerary_items where id = $1`,
      [stop],
    );
    expect(s).toEqual({ variant_id: variant, travel_minutes_from_previous: 25 });
    // The constraint refuses a vote pointing at another trip.
    await expect(
      db.query(`insert into stop_votes (item_id, trip_id, user_id, vote) values ($1, $2, $3, 'for')`, [stop, bobTrip, BOB]),
    ).rejects.toThrow(/foreign key/);
  });

  it("two people editing the same stop: the second, stale edit is refused", async () => {
    const stop = (await one<{ id: string }>(BOB, `select add_stop($1, 2, '09:00', 60, 'Market') as id`, [trip])).id;
    const seen = await version("itinerary_items", stop); // both Bob and Erin loaded this
    const v2 = (await one<{ v: number }>(BOB, `select update_stop($1, 2, '09:30', 60, 'Market', null, null, null, null, null, $2) as v`, [stop, seen])).v;
    expect(v2).toBe(seen + 1);
    await expect(
      rows(ERIN, `select update_stop($1, 2, '11:00', 60, 'Market', null, null, null, null, null, $2)`, [stop, seen]),
    ).rejects.toThrow(STALE);
    expect((await one<{ time: string }>(ALICE, `select "time"::text as time from itinerary_items where id = $1`, [stop])).time).toBe("09:30:00");
    // After reloading, Erin's edit goes through.
    await asUser(db, ERIN, `select update_stop($1, 2, '11:00', 60, 'Market', null, null, null, null, null, $2)`, [stop, v2]);
    await expect(rows(BOB, `select delete_stop_checked($1, $2)`, [stop, v2])).rejects.toThrow(STALE);
    await expect(rows(BOB, `select delete_stop($1)`, [stop])).rejects.toThrow(BLOCKED);
  });

  // Regression: 010 raised 40001 for a stale version. PostgREST retries 40001
  // automatically, so in production a stale save retried forever and the
  // request never returned. The code must be one nothing retries.
  it("a stale edit fails with the app's own code, never one PostgREST retries", async () => {
    const stop = (await one<{ id: string }>(BOB, `select add_stop($1, 2, '15:00', 60, 'Cafe') as id`, [trip])).id;
    const err = await rows(ERIN, `select update_stop($1, 2, '16:00', 60, 'Cafe', null, null, null, null, null, 99)`, [stop]).then(
      () => null,
      (e: { code?: string; message: string }) => e,
    );
    expect(err?.message).toMatch(STALE);
    expect(err?.code).toBe(STALE_CODE);
    expect(RETRIED_BY_POSTGREST).not.toContain(err?.code);
    // No function in the final schema raises a code PostgREST would retry.
    const offenders = await db.query<{ name: string }>(
      `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private') and p.prosrc ~* $1`,
      [`errcode\\s*=\\s*'(${RETRIED_BY_POSTGREST.join("|")})'`],
    );
    expect(offenders.rows).toEqual([]);
  });

  it("deleting a variant removes its stops", async () => {
    await asUser(db, ALICE, `select delete_variant($1, $2)`, [variant, await version("plan_variants", variant)]);
    expect(await rows(ALICE, `select id from itinerary_items where variant_id = $1`, [variant])).toEqual([]);
  });
});

describe("budget categories", () => {
  it("planners manage them, with versions; members read them", async () => {
    await expect(rows(BOB, `select create_budget_category($1, 'flights', 'Flights', 800000)`, [trip])).rejects.toThrow(/Only the organiser or a co-planner can change budget categories/);
    const id = (await one<{ id: string }>(ERIN, `select create_budget_category($1, 'flights', 'Flights', 800000) as id`, [trip])).id;
    expect(await rows(BOB, `select label from budget_categories where trip_id = $1`, [trip])).toEqual([{ label: "Flights" }]);
    await asUser(db, ALICE, `select update_budget_category($1, 'flights', 'Flights', 750000, null, 1)`, [id]);
    await expect(rows(ERIN, `select update_budget_category($1, 'flights', 'Flights', 900000, null, 1)`, [id])).rejects.toThrow(STALE);
    await expect(rows(ERIN, `select create_budget_category($1, 'spa', 'Spa')`, [trip])).rejects.toThrow(/Choose a category/);
  });
});

describe("stay quotes", () => {
  let q1: string;
  it("stores the quote as quoted; the generated total multiplies per-room-night only", async () => {
    q1 = (await one<{ id: string }>(BOB, `select create_quote($1, $2::jsonb) as id`, [trip, quote()])).id;
    const total = (await one<{ id: string }>(BOB, `select create_quote($1, $2::jsonb) as id`, [trip, quote({ name: "Whole villa", pricing_basis: "entire_stay_total", quoted_amount_minor: 3600000 })])).id;
    const r = await rows<{ name: string; quoted_total_minor: string; taxes_minor: string | null }>(
      ALICE,
      `select name, quoted_total_minor::text, taxes_minor::text from stay_quotes where id in ($1, $2) order by name`,
      [q1, total],
    );
    expect(r).toEqual([
      { name: "Villa Sol", quoted_total_minor: "3600000", taxes_minor: null },
      { name: "Whole villa", quoted_total_minor: "3600000", taxes_minor: null },
    ]);
  });

  it("refuses quotes missing basis, source or check date, half conversions and deadlines without a time zone", async () => {
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ pricing_basis: "per_person" }, /per room per night or the total/],
      [{ source_url: null }, /link where this came from/],
      [{ checked_at: null }, /when the price was checked/],
      [{ currency: "USD", fx_rate_micros: 83000000 }, /rate, the date of the rate and its source/],
      [{ fx_rate_micros: 1000000, fx_rate_date: "2026-11-20", fx_source: "x" }, /trip's own currency/],
      [{ cancellation_deadline: "2027-02-01T12:00:00Z" }, /needs its time zone/],
      [{ cancellation_deadline: "2027-02-01T12:00:00Z", cancellation_tz: "IST" }, /real time zone/],
      [{ nights: 0 }, /whole positive numbers/],
      [{ quoted_amount_minor: "12.5" }, /whole positive numbers/],
    ];
    for (const [over, err] of bad) {
      await expect(rows(BOB, `select create_quote($1, $2::jsonb)`, [trip, quote(over)]), JSON.stringify(over)).rejects.toThrow(err);
    }
  });

  it("accepts another currency with an explicit rate, date and source", async () => {
    const id = (
      await one<{ id: string }>(BOB, `select create_quote($1, $2::jsonb) as id`, [
        trip,
        quote({ name: "Dollar villa", currency: "USD", fx_rate_micros: 83125000, fx_rate_date: "2026-11-20", fx_source: "RBI reference" }),
      ])
    ).id;
    expect(id).toBeTruthy();
  });

  it("votes are opinions; editing restarts them; a stale edit is refused", async () => {
    await asUser(db, ALICE, `select vote_quote($1, 'for')`, [q1]);
    const v = await version("stay_quotes", q1);
    await asUser(db, BOB, `select update_quote($1, $2::jsonb, $3)`, [q1, quote({ taxes_minor: 432000 }), v]);
    expect(await rows(ALICE, `select * from stay_quote_votes where quote_id = $1`, [q1])).toEqual([]);
    await expect(rows(ERIN, `select update_quote($1, $2::jsonb, $3)`, [q1, quote({ fees_minor: 0 }), v])).rejects.toThrow(STALE);
  });

  it("members cannot edit others' quotes; outsiders get nothing", async () => {
    const alices = (await one<{ id: string }>(ALICE, `select create_quote($1, $2::jsonb) as id`, [trip, quote({ name: "Alice pick" })])).id;
    await expect(rows(BOB, `select update_quote($1, $2::jsonb, 1)`, [alices, quote()])).rejects.toThrow(/Only whoever added this quote/);
    await expect(rows(BOB, `select delete_quote($1, 1)`, [alices])).rejects.toThrow(/Only whoever added this quote/);
    expect(await rows(CAROL, `select * from stay_quotes`)).toEqual([]);
    await expect(rows(CAROL, `select vote_quote($1, 'for')`, [alices])).rejects.toThrow(/not a member/);
    await expect(rows(BOB, `insert into stay_quote_votes (quote_id, trip_id, user_id, vote) values ($1, $2, $3, 'for')`, [alices, trip, ALICE])).rejects.toThrow(BLOCKED);
  });
});
