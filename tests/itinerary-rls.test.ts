// PRD 05 itinerary + 06 comments, against the real SQL (supabase/009_itinerary.sql).
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, CAROL, ERIN, asUser, createDb, inviteAndJoin } from "./helpers/db";

const BLOCKED = /row-level security|permission denied/;
let db: PGlite;
let tripId: string;

async function rows<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await asUser<T>(db, userId, sql, params)).rows;
}
async function addStop(userId: string, day: number, time: string | null, title: string, extra = "", params: unknown[] = []) {
  return (
    await rows<{ id: string }>(userId, `select add_stop($1, $2, $3::time, 60, $4${extra}) as id`, [tripId, day, time, title, ...params])
  )[0].id;
}

beforeAll(async () => {
  db = await createDb();
  tripId = (
    await rows<{ id: string }>(
      ALICE,
      `insert into trips (name, start_date, end_date, timezone, currency)
       values ('Goa', '2027-02-05', '2027-02-08', 'Asia/Kolkata', 'INR') returning id`,
    )
  )[0].id;
  await inviteAndJoin(db, ALICE, tripId, BOB, "Bob");
  await inviteAndJoin(db, ALICE, tripId, ERIN, "Erin");
  await asUser(db, ALICE, `select set_member_role($1, $2, 'co_planner')`, [tripId, ERIN]);
});

afterAll(async () => {
  await db.close();
});

describe("adding stops", () => {
  it("any member adds a stop; its instant comes from the trip date, day, time and time zone", async () => {
    const id = await addStop(BOB, 2, "10:00", "Fort Aguada");
    const stop = await rows<{ starts_at: string; created_by: string }>(
      ALICE,
      `select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as starts_at, created_by
         from itinerary_items where id = $1`,
      [id],
    );
    // 6 Feb 2027 10:00 in Asia/Kolkata (UTC+5:30) is 04:30 UTC.
    expect(stop).toEqual([{ starts_at: "2027-02-06 04:30", created_by: BOB }]);
  });

  it("validates day, time, duration, name, link, location and cost", async () => {
    await expect(addStop(BOB, 5, "10:00", "Too late")).rejects.toThrow(/only 4 days/);
    await expect(addStop(BOB, 1, null, "No time")).rejects.toThrow(/start time/);
    await expect(
      rows(BOB, `select add_stop($1, 1, '10:00', 2, 'Blink')`, [tripId]),
    ).rejects.toThrow(/between 5 minutes and 24 hours/);
    await expect(addStop(BOB, 1, "10:00", "   ")).rejects.toThrow(/1 to 120/);
    await expect(addStop(BOB, 1, "10:00", "Bad link", ", $5", ["javascript:alert(1)"])).rejects.toThrow(/http/);
    await expect(addStop(BOB, 1, "10:00", "Half pin", ", null, $5", [15.2])).rejects.toThrow(/latitude and longitude/);
    await expect(addStop(BOB, 1, "10:00", "Negative", ", null, null, null, $5", [-1])).rejects.toThrow(/zero or more/);
  });

  it("is retry-safe: the same client key adds one stop", async () => {
    const key = "11111111-1111-4111-8111-111111111111";
    const a = await addStop(BOB, 3, "09:00", "Breakfast", ", null, null, null, null, null, $5", [key]);
    const b = await addStop(BOB, 3, "09:00", "Breakfast", ", null, null, null, null, null, $5", [key]);
    expect(b).toBe(a);
    const n = await rows<{ n: number }>(ALICE, `select count(*)::int as n from itinerary_items where client_key = $1`, [key]);
    expect(n[0].n).toBe(1);
  });

  it("nobody writes stops directly", async () => {
    await expect(
      rows(BOB, `insert into itinerary_items (trip_id, day_number, title) values ($1, 1, 'x')`, [tripId]),
    ).rejects.toThrow(BLOCKED);
    await expect(rows(ALICE, `update itinerary_items set title = 'x' where trip_id = $1`, [tripId])).rejects.toThrow(BLOCKED);
    await expect(rows(ALICE, `delete from itinerary_items where trip_id = $1`, [tripId])).rejects.toThrow(BLOCKED);
  });

  it("someone not on the trip can neither see nor add stops", async () => {
    expect(await rows(CAROL, `select * from itinerary_items`)).toEqual([]);
    await expect(addStop(CAROL, 1, "10:00", "Intruder")).rejects.toThrow(/not a member/);
  });
});

describe("editing, moving and deleting", () => {
  let aliceStop: string;

  it("a member cannot edit or delete someone else's stop; planners can", async () => {
    aliceStop = await addStop(ALICE, 1, "18:00", "Sunset");
    await expect(
      rows(BOB, `select update_stop($1, 1, '19:00', 60, 'Mine now', null, null, null, null, null, (select version from itinerary_items where id = $1))`, [aliceStop]),
    ).rejects.toThrow(/Only whoever added this stop/);
    await expect(rows(BOB, `select delete_stop_checked($1, (select version from itinerary_items where id = $1))`, [aliceStop])).rejects.toThrow(/Only whoever added this stop/);
    await asUser(db, ERIN, `select update_stop($1, 1, '18:30', 60, 'Sunset at Chapora', null, null, null, null, null, (select version from itinerary_items where id = $1))`, [aliceStop]);
    const t = await rows<{ title: string }>(BOB, `select title from itinerary_items where id = $1`, [aliceStop]);
    expect(t[0].title).toBe("Sunset at Chapora");
  });

  it("moving a stop restarts its votes; editing only notes keeps them", async () => {
    await asUser(db, BOB, `select vote_stop($1, 'for')`, [aliceStop]);
    await asUser(db, ALICE, `select update_stop($1, 1, '18:30', 60, 'Sunset at Chapora', null, null, null, null, 'Bring water', (select version from itinerary_items where id = $1))`, [aliceStop]);
    expect(await rows(ALICE, `select user_id from stop_votes where item_id = $1`, [aliceStop])).toHaveLength(1);
    await asUser(db, ALICE, `select update_stop($1, 2, '18:30', 60, 'Sunset at Chapora', null, null, null, null, null, (select version from itinerary_items where id = $1))`, [aliceStop]);
    expect(await rows(ALICE, `select user_id from stop_votes where item_id = $1`, [aliceStop])).toEqual([]);
  });

  it("changing the trip's dates or time zone recomputes every stop's instant", async () => {
    await asUser(db, ALICE, `update trips set start_date = '2027-03-01', end_date = '2027-03-04' where id = $1`, [tripId]);
    const s1 = await rows<{ at: string }>(ALICE, `select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as at from itinerary_items where id = $1`, [aliceStop]);
    expect(s1[0].at).toBe("2027-03-02 13:00"); // day 2, 18:30 IST
    await asUser(db, ALICE, `update trips set timezone = 'Europe/London' where id = $1`, [tripId]);
    const s2 = await rows<{ at: string }>(ALICE, `select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as at from itinerary_items where id = $1`, [aliceStop]);
    expect(s2[0].at).toBe("2027-03-02 18:30");
    await asUser(db, ALICE, `update trips set timezone = 'Asia/Kolkata' where id = $1`, [tripId]);
  });

  it("the author can delete their own stop", async () => {
    const mine = await addStop(BOB, 1, "08:00", "Run");
    await asUser(db, BOB, `select delete_stop_checked($1, (select version from itinerary_items where id = $1))`, [mine]);
    expect(await rows(BOB, `select id from itinerary_items where id = $1`, [mine])).toEqual([]);
  });
});

describe("votes", () => {
  let stop: string;
  it("one vote per person; voting again replaces it; null withdraws it", async () => {
    stop = await addStop(ALICE, 2, "11:00", "Spice farm");
    await asUser(db, BOB, `select vote_stop($1, 'for')`, [stop]);
    await asUser(db, BOB, `select vote_stop($1, 'against')`, [stop]);
    await asUser(db, ALICE, `select vote_stop($1, 'for')`, [stop]);
    const v = await rows<{ user_id: string; vote: string }>(ERIN, `select user_id, vote from stop_votes where item_id = $1 order by user_id`, [stop]);
    expect(v).toEqual([
      { user_id: ALICE, vote: "for" },
      { user_id: BOB, vote: "against" },
    ]);
    await asUser(db, BOB, `select vote_stop($1, null)`, [stop]);
    expect(await rows(ERIN, `select 1 from stop_votes where item_id = $1 and user_id = $2`, [stop, BOB])).toEqual([]);
    await expect(rows(BOB, `select vote_stop($1, 'maybe')`, [stop])).rejects.toThrow(/for or against/);
  });

  it("you can only cast your own vote", async () => {
    await expect(
      rows(ALICE, `insert into stop_votes (item_id, trip_id, user_id, vote) values ($1, $2, $3, 'for')`, [stop, tripId, BOB]),
    ).rejects.toThrow(BLOCKED);
    await expect(rows(ALICE, `update stop_votes set vote = 'against'`)).rejects.toThrow(BLOCKED);
    await expect(rows(CAROL, `select vote_stop($1, 'for')`, [stop])).rejects.toThrow(/not a member/);
  });
});

describe("comments", () => {
  let stop: string;
  it("members comment; the same client key adds one comment", async () => {
    stop = await addStop(ALICE, 3, "15:00", "Market");
    const key = "22222222-2222-4222-8222-222222222222";
    const a = (await rows<{ id: string }>(BOB, `select add_comment($1, ' Too crowded? ', $2) as id`, [stop, key]))[0].id;
    const b = (await rows<{ id: string }>(BOB, `select add_comment($1, ' Too crowded? ', $2) as id`, [stop, key]))[0].id;
    expect(b).toBe(a);
    const c = await rows<{ body: string }>(ALICE, `select body from stop_comments where item_id = $1`, [stop]);
    expect(c).toEqual([{ body: "Too crowded?" }]);
    await expect(rows(BOB, `select add_comment($1, '   ')`, [stop])).rejects.toThrow(/1 to 1000/);
  });

  it("outsiders cannot read or write comments, nor write directly", async () => {
    expect(await rows(CAROL, `select * from stop_comments`)).toEqual([]);
    await expect(rows(CAROL, `select add_comment($1, 'hi')`, [stop])).rejects.toThrow(/not a member/);
    await expect(
      rows(BOB, `insert into stop_comments (item_id, trip_id, user_id, body) values ($1, $2, $3, 'x')`, [stop, tripId, ALICE]),
    ).rejects.toThrow(BLOCKED);
  });

  it("only the author or a planner deletes a comment", async () => {
    const id = (await rows<{ id: string }>(ALICE, `select add_comment($1, 'Opens at 4') as id`, [stop]))[0].id;
    await expect(rows(BOB, `select delete_comment($1)`, [id])).rejects.toThrow(/Only the author/);
    await asUser(db, ERIN, `select delete_comment($1)`, [id]);
    expect(await rows(ALICE, `select id from stop_comments where id = $1`, [id])).toEqual([]);
  });

  it("leaving the trip removes your votes and comments", async () => {
    await asUser(db, BOB, `select vote_stop($1, 'for')`, [stop]);
    await asUser(db, BOB, `delete from trip_members where trip_id = $1 and user_id = $2`, [tripId, BOB]);
    expect(await rows(ALICE, `select 1 from stop_votes where user_id = $1`, [BOB])).toEqual([]);
    expect(await rows(ALICE, `select 1 from stop_comments where user_id = $1`, [BOB])).toEqual([]);
  });
});

describe("trips without dates", () => {
  it("stops have no instant yet, and days are capped generously", async () => {
    // Carol's own trip: she is still outside Alice's.
    const t = (
      await rows<{ id: string }>(CAROL, `insert into trips (name, timezone, currency) values ('Someday', 'UTC', 'USD') returning id`)
    )[0].id;
    const id = (await rows<{ id: string }>(CAROL, `select add_stop($1, 10, '09:00', 30, 'Hike') as id`, [t]))[0].id;
    expect(await rows(CAROL, `select starts_at from itinerary_items where id = $1`, [id])).toEqual([{ starts_at: null }]);
    await expect(rows(CAROL, `select add_stop($1, 62, '09:00', 30, 'Far')`, [t])).rejects.toThrow(/within the trip/);
  });
});
