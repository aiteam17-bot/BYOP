// supabase/013_plans_ai_concierge.sql against the real SQL: plan shapes,
// AI opt-in and rate limits, unverified ideas, and concierge proposals
// (permissions, bounded patches, stale plans, idempotent accept).
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STALE_CODE } from "@/lib/db-errors";
import { ALICE, BOB, CAROL, ERIN, asUser, createDb, inviteAndJoin } from "./helpers/db";

const BLOCKED = /row-level security|permission denied|not a member|not allowed|Only/;
let db: PGlite;
let idea: string; // a confirmed AI idea, used by the concierge tests
let trip: string; // Alice organiser, Bob member, Erin co-planner; Carol outsider

async function rows<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await asUser<T>(db, userId, sql, params)).rows;
}
async function one<T>(userId: string, sql: string, params: unknown[] = []): Promise<T> {
  return (await rows<T>(userId, sql, params))[0];
}
async function errOf(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  return p.then(
    () => ({ message: "no error" }),
    (e: { code?: string; message: string }) => e,
  );
}
const planVersion = async () =>
  (await db.query<{ v: number }>(`select plan_version as v from trips where id = $1`, [trip])).rows[0].v;

const quote = (name: string, amount: number) =>
  JSON.stringify({
    name, source_url: "https://example.com/" + name, pricing_basis: "entire_stay_total", currency: "INR",
    quoted_amount_minor: amount, nights: 3, rooms: 1, taxes_minor: 0, fees_minor: 0, sharers: 3,
    checked_at: "2026-11-20T10:00:00+05:30",
  });

beforeAll(async () => {
  db = await createDb();
  trip = (
    await one<{ id: string }>(
      ALICE,
      `insert into trips (name, destination, start_date, end_date, timezone, currency)
       values ('Goa', 'Goa', '2027-02-05', '2027-02-08', 'Asia/Kolkata', 'INR') returning id`,
    )
  ).id;
  await inviteAndJoin(db, ALICE, trip, BOB, "Bob");
  await inviteAndJoin(db, ALICE, trip, ERIN, "Erin");
  await asUser(db, ALICE, `select set_member_role($1, $2, 'co_planner')`, [trip, ERIN]);
});

afterAll(async () => {
  await db.close();
});

describe("plan shapes", () => {
  it("only planners save shapes; the snapshot comes from the database", async () => {
    const q1 = (await one<{ id: string }>(BOB, `select create_quote($1, $2::jsonb) as id`, [trip, quote("cheap", 900000)])).id;
    const q2 = (await one<{ id: string }>(BOB, `select create_quote($1, $2::jsonb) as id`, [trip, quote("dear", 2700000)])).id;
    await asUser(db, ALICE, `select set_planning_bounds($1, 2000000, 4000000, true)`, [trip]);
    const choices = JSON.stringify({ tight: q1, balanced: q1, splurge: q2 });

    expect((await errOf(rows(BOB, `select save_plan_shapes($1, $2::jsonb)`, [trip, choices]))).message).toMatch(BLOCKED);
    expect((await errOf(rows(CAROL, `select save_plan_shapes($1, $2::jsonb)`, [trip, choices]))).message).toMatch(BLOCKED);
    const gen = (await one<{ g: number }>(ERIN, `select save_plan_shapes($1, $2::jsonb) as g`, [trip, choices])).g;
    expect(gen).toBe(1);
    const saved = await rows<{ tier: string; stay_quote_id: string; bounds_min_minor: string; start_date: string }>(
      BOB,
      `select tier, stay_quote_id, bounds_min_minor::text, start_date::text from plan_shapes where trip_id = $1 order by tier`,
      [trip],
    );
    expect(saved).toEqual([
      { tier: "balanced", stay_quote_id: q1, bounds_min_minor: "2000000", start_date: "2027-02-05" },
      { tier: "splurge", stay_quote_id: q2, bounds_min_minor: "2000000", start_date: "2027-02-05" },
      { tier: "tight", stay_quote_id: q1, bounds_min_minor: "2000000", start_date: "2027-02-05" },
    ]);
    expect(await rows(CAROL, `select * from plan_shapes where trip_id = $1`, [trip])).toEqual([]);
  });

  it("refuses bad choices and quotes from another trip", async () => {
    const other = (await one<{ id: string }>(CAROL, `insert into trips (name, timezone, currency) values ('X', 'UTC', 'INR') returning id`)).id;
    const foreign = (await one<{ id: string }>(CAROL, `select create_quote($1, $2::jsonb) as id`, [other, quote("x", 100)])).id;
    const bad = [
      JSON.stringify({ tight: null, balanced: null }),
      JSON.stringify({ tight: null, balanced: null, splurge: null, extra: null }),
      JSON.stringify({ tight: 5, balanced: null, splurge: null }),
      JSON.stringify({ tight: "not-a-uuid", balanced: null, splurge: null }),
      JSON.stringify({ tight: foreign, balanced: null, splurge: null }),
    ];
    for (const b of bad) {
      expect((await errOf(rows(ALICE, `select save_plan_shapes($1, $2::jsonb)`, [trip, b]))).code).toMatch(/22023|P0002/);
    }
  });

  it("choosing a shape keeps exactly one chosen", async () => {
    const ids = await rows<{ id: string }>(ALICE, `select id from plan_shapes where trip_id = $1 order by tier`, [trip]);
    await asUser(db, ALICE, `select choose_plan_shape($1)`, [ids[0].id]);
    await asUser(db, ERIN, `select choose_plan_shape($1)`, [ids[1].id]);
    const chosen = await rows<{ id: string }>(BOB, `select id from plan_shapes where trip_id = $1 and chosen_at is not null`, [trip]);
    expect(chosen).toEqual([{ id: ids[1].id }]);
    expect((await errOf(rows(BOB, `select choose_plan_shape($1)`, [ids[0].id]))).message).toMatch(BLOCKED);
  });

  it("nobody writes the tables directly", async () => {
    expect((await errOf(rows(ALICE, `insert into plan_shapes (trip_id, generation, tier) values ($1, 99, 'tight')`, [trip]))).message).toMatch(BLOCKED);
    expect((await errOf(rows(ALICE, `update trips set plan_version = 1 where id = $1`, [trip]))).message).toMatch(BLOCKED);
  });
});

describe("AI ideas: opt-in, limits, confirmation", () => {
  it("is off until a planner opts in; members cannot opt in", async () => {
    expect((await errOf(rows(BOB, `select begin_ai_request($1, 100)`, [trip]))).message).toMatch(/not turned on/);
    expect((await errOf(rows(BOB, `select set_ai_ideas_opt_in($1, true)`, [trip]))).message).toMatch(BLOCKED);
    await asUser(db, ALICE, `select set_ai_ideas_opt_in($1, true)`, [trip]);
    expect((await errOf(rows(CAROL, `select begin_ai_request($1, 100)`, [trip]))).message).toMatch(BLOCKED);
  });

  it("caps request size and rate limits per account and trip", async () => {
    expect((await errOf(rows(BOB, `select begin_ai_request($1, 5000)`, [trip]))).message).toMatch(/too large/);
    const first = (await one<{ id: string }>(BOB, `select begin_ai_request($1, 100) as id`, [trip])).id;
    // One at a time.
    expect((await errOf(rows(BOB, `select begin_ai_request($1, 100)`, [trip]))).code).toBe("RL429");
    await asUser(db, BOB, `select finish_ai_request($1, false, 'quota', 0, null)`, [first]);
    for (let i = 0; i < 4; i++) {
      const id = (await one<{ id: string }>(BOB, `select begin_ai_request($1, 100) as id`, [trip])).id;
      await asUser(db, BOB, `select finish_ai_request($1, false, 'malformed', 10, null)`, [id]);
    }
    const sixth = await errOf(rows(BOB, `select begin_ai_request($1, 100)`, [trip]));
    expect(sixth.code).toBe("RL429");
    expect(sixth.message).toMatch(/5 idea requests per hour/);
    // Bob sees only his own ledger rows; Erin sees none of Bob's.
    expect((await rows(BOB, `select id from ai_requests where trip_id = $1`, [trip])).length).toBe(5);
    expect(await rows(ERIN, `select id from ai_requests where trip_id = $1`, [trip])).toEqual([]);
  });

  it("stores only validated ideas, once, and only for your own request", async () => {
    const req = (await one<{ id: string }>(ERIN, `select begin_ai_request($1, 120) as id`, [trip])).id;
    const ideas = JSON.stringify([{ name: "Fort Aguada", category: "sight", area: "Candolim", why: "Views", source_url: "https://example.org/fort" }]);
    expect((await errOf(rows(BOB, `select finish_ai_request($1, true, null, 200, $2::jsonb)`, [req, ideas]))).code).toBe("P0002");
    const extra = JSON.stringify([{ name: "X", category: "sight", price: 100 }]);
    expect((await errOf(rows(ERIN, `select finish_ai_request($1, true, null, 200, $2::jsonb)`, [req, extra]))).message).toMatch(/Unexpected fields/);
    const badUrl = JSON.stringify([{ name: "X", category: "sight", source_url: "javascript:alert(1)" }]);
    expect((await errOf(rows(ERIN, `select finish_ai_request($1, true, null, 200, $2::jsonb)`, [req, badUrl]))).message).toMatch(/check constraint/);
    const tooMany = JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ name: `I${i}`, category: "food" })));
    expect((await errOf(rows(ERIN, `select finish_ai_request($1, true, null, 200, $2::jsonb)`, [req, tooMany]))).message).toMatch(/at most 8/);
    expect((await one<{ n: number }>(ERIN, `select finish_ai_request($1, true, null, 200, $2::jsonb) as n`, [req, ideas])).n).toBe(1);
    expect((await errOf(rows(ERIN, `select finish_ai_request($1, true, null, 200, $2::jsonb)`, [req, ideas]))).message).toMatch(/already finished/);
    idea = (await one<{ id: string; status: string }>(BOB, `select id, status from ai_suggestions where trip_id = $1`, [trip])).id;
    expect((await one<{ status: string }>(BOB, `select status from ai_suggestions where id = $1`, [idea])).status).toBe("unverified");
  });

  it("an idea is confirmed only with place, hours, time and price checked by a member", async () => {
    expect((await errOf(rows(BOB, `select confirm_ai_suggestion($1, null, '9-5', 60, 0, 1)`, [idea]))).code).toBe("22023");
    expect((await errOf(rows(BOB, `select confirm_ai_suggestion($1, 'https://x.org', '', 60, 0, 1)`, [idea]))).code).toBe("22023");
    expect((await errOf(rows(BOB, `select confirm_ai_suggestion($1, 'https://x.org', '9-5', null, 0, 1)`, [idea]))).code).toBe("22023");
    expect((await errOf(rows(BOB, `select confirm_ai_suggestion($1, 'https://x.org', '9-5', 60, null, 1)`, [idea]))).code).toBe("22023");
    expect((await errOf(rows(CAROL, `select confirm_ai_suggestion($1, 'https://x.org', '9-5', 60, 0, 1)`, [idea]))).message).toMatch(BLOCKED);
    expect((await errOf(rows(BOB, `select confirm_ai_suggestion($1, 'https://x.org', '9-5', 60, 5000, 7)`, [idea]))).code).toBe(STALE_CODE);
    expect((await one<{ v: number }>(BOB, `select confirm_ai_suggestion($1, 'https://maps.example.org/fort', '09:00-17:30', 90, 5000, 1) as v`, [idea])).v).toBe(2);
  });
});

describe("concierge proposals", () => {
  let stop: string;
  it("rejects malformed and unbounded patches", async () => {
    stop = (await one<{ id: string }>(BOB, `select add_stop($1, 1, '10:00', 60, 'Beach') as id`, [trip])).id;
    const bad = [
      `[]`,
      JSON.stringify(Array.from({ length: 11 }, () => ({ op: "add_stop", day: 1, time: "09:00", duration: 30, title: "x" }))),
      JSON.stringify([{ op: "drop_table", day: 1 }]),
      JSON.stringify([{ op: "add_stop", day: 1, time: "09:00", duration: 30, title: "x", sql: "drop table trips" }]),
      JSON.stringify([{ op: "add_stop", day: "1", time: "09:00", duration: 30, title: "x" }]),
      JSON.stringify([{ op: "add_stop", day: 1, time: "9am", duration: 30, title: "x" }]),
      JSON.stringify([{ op: "move_stop", item_id: "nope", expected_version: 1, day: 1, time: "09:00" }]),
      JSON.stringify([{ op: "add_stop", day: 1, time: "09:00", suggestion_id: stop }]),
      `{"op":"add_stop"}`,
    ];
    for (const b of bad) {
      const e = await errOf(rows(BOB, `select propose_change($1, $2::jsonb)`, [trip, b]));
      expect(e.code, b).toMatch(/22023|P0002/);
    }
    expect((await errOf(rows(CAROL, `select propose_change($1, $2::jsonb)`, [trip, `[{"op":"remove_stop","item_id":"${stop}","expected_version":1}]`]))).message).toMatch(BLOCKED);
  });

  it("Accept applies all changes once; repeated Accept does not duplicate", async () => {
    const v = (await one<{ version: number }>(BOB, `select version from itinerary_items where id = $1`, [stop])).version;
    const ops = JSON.stringify([
      { op: "add_stop", day: 2, time: "11:00", suggestion_id: idea },
      { op: "move_stop", item_id: stop, expected_version: v, day: 1, time: "15:00" },
    ]);
    const key = "8d8b6c0e-7d0e-4b8e-9d55-2b1f0c3a9e11";
    const p = (await one<{ id: string }>(BOB, `select propose_change($1, $2::jsonb, $3) as id`, [trip, ops, key])).id;
    // Same client key: the same proposal, not a second one.
    expect((await one<{ id: string }>(BOB, `select propose_change($1, $2::jsonb, $3) as id`, [trip, ops, key])).id).toBe(p);
    const before = await planVersion();
    expect((await one<{ r: string }>(BOB, `select accept_proposal($1) as r`, [p])).r).toBe("applied");
    expect((await one<{ r: string }>(BOB, `select accept_proposal($1) as r`, [p])).r).toBe("already_applied");
    expect((await one<{ r: string }>(ERIN, `select accept_proposal($1) as r`, [p])).r).toBe("already_applied");
    const added = await rows<{ title: string; cost: string; place_url: string }>(
      BOB, `select title, cost_minor::text as cost, place_url from itinerary_items where trip_id = $1 and title = 'Fort Aguada'`, [trip],
    );
    expect(added).toEqual([{ title: "Fort Aguada", cost: "5000", place_url: "https://maps.example.org/fort" }]);
    expect((await one<{ time: string }>(BOB, `select "time"::text as time from itinerary_items where id = $1`, [stop])).time).toBe("15:00:00");
    expect(await planVersion()).toBe(before + 2);
  });

  it("a proposal made against an older plan is stale and changes nothing", async () => {
    const v = (await one<{ version: number }>(BOB, `select version from itinerary_items where id = $1`, [stop])).version;
    const p = (await one<{ id: string }>(BOB, `select propose_change($1, $2::jsonb) as id`, [trip, JSON.stringify([{ op: "remove_stop", item_id: stop, expected_version: v }])])).id;
    await asUser(db, ERIN, `select add_stop($1, 3, '09:00', 30, 'Market')`, [trip]); // the plan moves on
    expect((await one<{ r: string }>(BOB, `select accept_proposal($1) as r`, [p])).r).toBe("stale");
    expect((await one<{ status: string }>(BOB, `select status from concierge_proposals where id = $1`, [p])).status).toBe("stale");
    expect((await rows(BOB, `select id from itinerary_items where id = $1`, [stop])).length).toBe(1);
    expect((await one<{ r: string }>(BOB, `select accept_proposal($1) as r`, [p])).r).toBe("stale");
  });

  it("Accept re-checks the accepter's permissions; failures roll everything back", async () => {
    const alices = (await one<{ id: string }>(ALICE, `select add_stop($1, 2, '18:00', 60, 'Dinner') as id`, [trip])).id;
    const av = (await one<{ version: number }>(BOB, `select version from itinerary_items where id = $1`, [alices])).version;
    const ops = JSON.stringify([
      { op: "add_stop", day: 3, time: "12:00", duration: 30, title: "Lunch" },
      { op: "remove_stop", item_id: alices, expected_version: av },
    ]);
    const p = (await one<{ id: string }>(BOB, `select propose_change($1, $2::jsonb) as id`, [trip, ops])).id;
    // Bob may not remove Alice's stop: nothing applies, not even the add.
    expect((await errOf(rows(BOB, `select accept_proposal($1)`, [p]))).message).toMatch(/Only whoever added/);
    expect(await rows(BOB, `select id from itinerary_items where trip_id = $1 and title = 'Lunch'`, [trip])).toEqual([]);
    expect((await one<{ status: string }>(BOB, `select status from concierge_proposals where id = $1`, [p])).status).toBe("pending");
    // A co-planner may.
    expect((await one<{ r: string }>(ERIN, `select accept_proposal($1) as r`, [p])).r).toBe("applied");
    expect((await rows(BOB, `select id from itinerary_items where trip_id = $1 and title = 'Lunch'`, [trip])).length).toBe(1);
  });

  it("Not now sets a proposal aside; it cannot then be accepted", async () => {
    const p = (await one<{ id: string }>(BOB, `select propose_change($1, $2::jsonb) as id`, [trip, JSON.stringify([{ op: "add_stop", day: 1, time: "08:00", duration: 30, title: "Run" }])])).id;
    expect((await errOf(rows(CAROL, `select dismiss_proposal($1)`, [p]))).message).toMatch(BLOCKED);
    await asUser(db, BOB, `select dismiss_proposal($1)`, [p]);
    expect((await errOf(rows(BOB, `select accept_proposal($1)`, [p]))).message).toMatch(/set aside/);
    expect(await rows(CAROL, `select id from concierge_proposals where trip_id = $1`, [trip])).toEqual([]);
  });
});
