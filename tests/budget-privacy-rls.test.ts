// PRD 03 anonymous budget, against the real SQL (supabase/008_budget_privacy.sql).
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, CAROL, ERIN, asUser, createDb, inviteAndJoin } from "./helpers/db";

const BLOCKED = /row-level security|permission denied/;
const DEV = "00000000-0000-0000-0000-0000000000d1"; // fourth member
const RS = (rupees: number) => rupees * 100; // rupees -> paise (minor units)

let db: PGlite;
let tripId: string;

async function rows<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await asUser<T>(db, userId, sql, params)).rows;
}
async function band(userId: string): Promise<Record<string, unknown>> {
  return (await rows<{ b: Record<string, unknown> }>(userId, `select trip_budget_band($1) as b`, [tripId]))[0].b;
}
async function setBudget(userId: string, min: number | null, max: number | null) {
  await asUser(
    db,
    userId,
    `insert into preferences (trip_id, user_id, budget_min_paise, budget_max_paise)
     values ($1, $2, $3, $4)
     on conflict (trip_id, user_id)
       do update set budget_min_paise = excluded.budget_min_paise,
                     budget_max_paise = excluded.budget_max_paise`,
    [tripId, userId, min, max],
  );
}

beforeAll(async () => {
  db = await createDb();
  await db.query(`insert into auth.users (id, email) values ($1, 'dev@example.com')`, [DEV]);
  tripId = (
    await rows<{ id: string }>(
      ALICE,
      `insert into trips (name, timezone, currency) values ('Goa', 'Asia/Kolkata', 'INR') returning id`,
    )
  )[0].id;
  await inviteAndJoin(db, ALICE, tripId, BOB, "Bob");
  await inviteAndJoin(db, ALICE, tripId, DEV, "Dev");
  await inviteAndJoin(db, ALICE, tripId, ERIN, "Erin");
});

afterAll(async () => {
  await db.close();
});

describe("trip timezone and currency", () => {
  it("a trip needs both", async () => {
    await expect(
      rows(ALICE, `insert into trips (name, currency) values ('No tz', 'INR')`),
    ).rejects.toThrow(/null value in column "timezone"|real time zone/);
    await expect(
      rows(ALICE, `insert into trips (name, timezone) values ('No cur', 'Asia/Kolkata')`),
    ).rejects.toThrow(/null value in column "currency"|not-null/);
  });

  it("rejects made-up time zones, abbreviations and unsupported currencies", async () => {
    for (const tz of ["Mars/Olympus", "IST", "+05:30", "Asia/Kolkata; drop table trips"]) {
      await expect(
        rows(ALICE, `insert into trips (name, timezone, currency) values ('x', $1, 'INR')`, [tz]),
        tz,
      ).rejects.toThrow(/real time zone/);
    }
    await expect(
      rows(ALICE, `insert into trips (name, timezone, currency) values ('x', 'UTC', 'XYZ')`),
    ).rejects.toThrow(/trips_currency_supported/);
  });

  it("the organiser can change the time zone but nobody can change the currency", async () => {
    await asUser(db, ALICE, `update trips set timezone = 'Asia/Singapore' where id = $1`, [tripId]);
    await asUser(db, ALICE, `update trips set timezone = 'Asia/Kolkata' where id = $1`, [tripId]);
    await expect(
      rows(ALICE, `update trips set currency = 'USD' where id = $1`, [tripId]),
    ).rejects.toThrow(BLOCKED);
  });

  it("trip dates are date-only; instants are timestamptz", async () => {
    const types = await db.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'trips'
          and column_name in ('start_date', 'end_date', 'created_at', 'planning_bounds_set_at')
        order by column_name`,
    );
    expect(types.rows).toEqual([
      { column_name: "created_at", data_type: "timestamp with time zone" },
      { column_name: "end_date", data_type: "date" },
      { column_name: "planning_bounds_set_at", data_type: "timestamp with time zone" },
      { column_name: "start_date", data_type: "date" },
    ]);
  });
});

describe("budget ranges are validated", () => {
  it("rejects max below min, one-sided ranges, negatives, absurd amounts and other scopes", async () => {
    await expect(setBudget(BOB, RS(30000), RS(20000))).rejects.toThrow(/preferences_budget_valid/);
    await expect(setBudget(BOB, RS(20000), null)).rejects.toThrow(/both_or_neither/);
    await expect(setBudget(BOB, -1, RS(1000))).rejects.toThrow(/check constraint/);
    await expect(setBudget(BOB, 0, 100000000001)).rejects.toThrow(/budget_cap/);
    await expect(
      rows(BOB, `insert into preferences (trip_id, user_id, budget_scope) values ($1, $2, 'per_day')`, [tripId, BOB]),
    ).rejects.toThrow(/budget_scope/);
  });
});

describe("the group band is suppressed below three respondents", () => {
  it("0, 1 and 2 respondents: only the count, no numbers", async () => {
    expect(await band(BOB)).toEqual({ status: "insufficient", respondents: 0, needed: 3 });
    await setBudget(ALICE, RS(18500), RS(30000));
    expect(await band(BOB)).toEqual({ status: "insufficient", respondents: 1, needed: 3 });
    await setBudget(BOB, RS(20300), RS(26700));
    const two = await band(ALICE);
    expect(two).toEqual({ status: "insufficient", respondents: 2, needed: 3 });
    expect(JSON.stringify(two)).not.toMatch(/2030000|2670000|1850000|3000000/);
  });

  it("a one-sided or empty card does not count as a respondent", async () => {
    await asUser(db, ERIN, `insert into preferences (trip_id, user_id, pace) values ($1, $2, 'relaxed')`, [tripId, ERIN]);
    expect((await band(ERIN)).respondents).toBe(2);
  });

  it("the third respondent releases a band rounded outward to ₹1,000", async () => {
    await setBudget(DEV, RS(15000), RS(25200));
    // Highest minimum 20,300 -> 20,000; lowest maximum 25,200 -> 26,000.
    expect(await band(BOB)).toEqual({
      status: "band",
      respondents: 3,
      low_minor: RS(20000),
      high_minor: RS(26000),
      step_minor: RS(1000),
      currency: "INR",
      scope: "total_per_person_incl_flights",
    });
  });

  it("no overlap is reported honestly, with no numbers", async () => {
    await setBudget(ERIN, RS(40000), RS(50000));
    expect(await band(ALICE)).toEqual({ status: "no_overlap", respondents: 4 });
  });

  it("a private revision is allowed and changes the result", async () => {
    await setBudget(ERIN, RS(10000), RS(27000));
    expect((await band(ALICE)).status).toBe("band");
  });

  it("revisions are throttled to 6 a day, which slows probing", async () => {
    // Erin has changed her range twice so far today (2 revisions recorded).
    for (let i = 1; i <= 4; i++) await setBudget(ERIN, RS(10000 + i), RS(27000));
    await expect(setBudget(ERIN, RS(9000), RS(27000))).rejects.toThrow(/up to 6 times a day/);
    // Editing other parts of the card is not throttled.
    await asUser(db, ERIN, `update preferences set pace = 'packed' where trip_id = $1 and user_id = $2`, [tripId, ERIN]);
    await expect(rows(ERIN, `select * from budget_revisions`)).rejects.toThrow(BLOCKED);
  });
});

describe("nobody sees anyone else's range", () => {
  it("the organiser cannot read another member's row", async () => {
    expect(await rows(ALICE, `select * from preferences where user_id = $1`, [BOB])).toEqual([]);
    const all = await rows<{ user_id: string }>(ALICE, `select user_id from preferences where trip_id = $1`, [tripId]);
    expect(all.map((r) => r.user_id)).toEqual([ALICE]);
  });

  it("nobody can change someone else's range", async () => {
    const r = await asUser(db, ALICE, `update preferences set budget_max_paise = 1 where user_id = $1`, [BOB]);
    expect(r.affectedRows ?? 0).toBe(0);
    await expect(
      rows(ALICE, `insert into preferences (trip_id, user_id, budget_min_paise, budget_max_paise) values ($1, $2, 1, 2)`, [tripId, BOB]),
    ).rejects.toThrow(BLOCKED);
  });

  it("the band function takes only the trip: no cohort filter, no leave-one-out", async () => {
    const sig = await db.query<{ args: string }>(
      `select pg_get_function_arguments(p.oid) as args from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'trip_budget_band'`,
    );
    expect(sig.rows).toEqual([{ args: "_trip_id uuid" }]);
    await expect(rows(ALICE, `select trip_budget_band($1, $2)`, [tripId, BOB])).rejects.toThrow(/does not exist/);
  });

  it("someone not on the trip gets nothing at all", async () => {
    await expect(band(CAROL)).rejects.toThrow(/not a member/);
    await expect(rows(CAROL, `select preference_progress($1)`, [tripId])).rejects.toThrow(/not a member/);
    expect(await rows(CAROL, `select * from preferences`)).toEqual([]);
    await expect(
      rows(CAROL, `insert into preferences (trip_id, user_id, budget_min_paise, budget_max_paise) values ($1, $2, 1, 2)`, [tripId, CAROL]),
    ).rejects.toThrow(BLOCKED);
  });

  it("leaving the trip removes your range from the cohort", async () => {
    await asUser(db, DEV, `delete from trip_members where trip_id = $1 and user_id = $2`, [tripId, DEV]);
    expect((await band(ALICE)).respondents).toBe(3);
  });
});

describe("planning bounds for small groups", () => {
  it("only the organiser or a co-planner records them, and must confirm the group agreed", async () => {
    await expect(
      rows(BOB, `select set_planning_bounds($1, $2, $3, true)`, [tripId, RS(15000), RS(25000)]),
    ).rejects.toThrow(/Only the organiser or a co-planner can record planning bounds/);
    await expect(
      rows(ALICE, `select set_planning_bounds($1, $2, $3, false)`, [tripId, RS(15000), RS(25000)]),
    ).rejects.toThrow(/Confirm the group agreed/);
    await expect(
      rows(ALICE, `select set_planning_bounds($1, $2, $3, true)`, [tripId, RS(25000), RS(15000)]),
    ).rejects.toThrow(/at most the maximum/);

    await asUser(db, ALICE, `select set_planning_bounds($1, $2, $3, true)`, [tripId, RS(15000), RS(25000)]);
    const trip = await rows<{ min: string; max: string; planning_bounds_set_by: string }>(
      BOB,
      `select planning_budget_min_minor::text as min, planning_budget_max_minor::text as max,
              planning_bounds_set_by from trips where id = $1`,
      [tripId],
    );
    expect(trip).toEqual([{ min: String(RS(15000)), max: String(RS(25000)), planning_bounds_set_by: ALICE }]);
  });

  it("they cannot be written directly, and outsiders cannot see them", async () => {
    await expect(
      rows(ALICE, `update trips set planning_budget_min_minor = 1 where id = $1`, [tripId]),
    ).rejects.toThrow(BLOCKED);
    expect(await rows(CAROL, `select planning_budget_min_minor from trips where id = $1`, [tripId])).toEqual([]);
  });
});
