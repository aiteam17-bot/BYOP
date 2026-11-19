import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, CAROL, asUser, createDb } from "./helpers/db";

const BLOCKED = /row-level security|permission denied/;

let db: PGlite;
let tripId: string;
let inviteToken: string;

beforeAll(async () => {
  db = await createDb();

  // Alice starts a trip. She becomes its organiser.
  const trip = await asUser<{ id: string; invite_token: string }>(
    db,
    ALICE,
    `insert into trips (name, destination) values ('Goa', 'Goa, India')
     returning id, invite_token`,
  );
  tripId = trip.rows[0].id;
  inviteToken = trip.rows[0].invite_token;

  // Bob opens her invite link and joins.
  await asUser(db, BOB, `select join_trip($1, 'Bob')`, [inviteToken]);

  // Both fill in their private preference cards.
  await asUser(
    db,
    ALICE,
    `insert into preferences
       (trip_id, user_id, budget_min_paise, budget_max_paise, pace, food_notes, submitted_at)
     values ($1, $2, 1000000, 2500000, 'packed', 'ALICE-SECRET-FOOD-NOTE', now())`,
    [tripId, ALICE],
  );
  await asUser(
    db,
    BOB,
    `insert into preferences
       (trip_id, user_id, budget_min_paise, budget_max_paise, pace, must_see, submitted_at)
     values ($1, $2, 500000, 1200000, 'relaxed', 'BOB-SECRET-MUST-SEE', now())`,
    [tripId, BOB],
  );
});

afterAll(async () => {
  await db.close();
});

describe("preferences are private (row-level security)", () => {
  it("a member cannot read another member's preferences row", async () => {
    // Bob asks for Alice's row by name...
    const direct = await asUser(
      db,
      BOB,
      `select * from preferences where trip_id = $1 and user_id = $2`,
      [tripId, ALICE],
    );
    expect(direct.rows).toHaveLength(0);

    // ...and asking for everything still returns only his own row.
    const all = await asUser<{ user_id: string }>(
      db,
      BOB,
      `select user_id from preferences where trip_id = $1`,
      [tripId],
    );
    expect(all.rows.map((r) => r.user_id)).toEqual([BOB]);
  });

  it("the other direction holds too: Alice cannot read Bob's row", async () => {
    const direct = await asUser(
      db,
      ALICE,
      `select * from preferences where user_id = $1`,
      [BOB],
    );
    expect(direct.rows).toHaveLength(0);
  });

  it("the organiser cannot read members' answers either", async () => {
    const all = await asUser<{ user_id: string }>(
      db,
      ALICE,
      `select user_id from preferences where trip_id = $1`,
      [tripId],
    );
    expect(all.rows.map((r) => r.user_id)).toEqual([ALICE]);
  });

  it("a person outside the trip reads no preferences at all", async () => {
    const all = await asUser(db, CAROL, `select * from preferences`);
    expect(all.rows).toHaveLength(0);
  });

  it("a signed-out visitor cannot read preferences", async () => {
    await expect(asUser(db, null, `select * from preferences`)).rejects.toThrow(
      BLOCKED,
    );
  });

  it("a member cannot edit or delete another member's row", async () => {
    const update = await asUser(
      db,
      BOB,
      `update preferences set pace = 'hacked' where user_id = $1 returning user_id`,
      [ALICE],
    );
    expect(update.rows).toHaveLength(0);

    const del = await asUser(
      db,
      BOB,
      `delete from preferences where user_id = $1 returning user_id`,
      [ALICE],
    );
    expect(del.rows).toHaveLength(0);

    // Alice's row is untouched.
    const mine = await asUser<{ pace: string }>(
      db,
      ALICE,
      `select pace from preferences where user_id = $1`,
      [ALICE],
    );
    expect(mine.rows[0].pace).toBe("packed");
  });

  it("a member cannot write a row in someone else's name", async () => {
    await expect(
      asUser(
        db,
        BOB,
        `insert into preferences (trip_id, user_id) values ($1, $2)`,
        [tripId, CAROL],
      ),
    ).rejects.toThrow(BLOCKED);
  });

  it("an outsider cannot write preferences into the trip", async () => {
    await expect(
      asUser(
        db,
        CAROL,
        `insert into preferences (trip_id, user_id) values ($1, $2)`,
        [tripId, CAROL],
      ),
    ).rejects.toThrow(/row-level security|violates foreign key/);
  });
});

describe("the trip page's 'who has answered' view", () => {
  it("shows names and a yes/no flag, never any answers", async () => {
    const status = await asUser<Record<string, unknown>>(
      db,
      ALICE,
      `select * from trip_response_status($1)`,
      [tripId],
    );
    expect(status.rows).toHaveLength(2);
    // Exactly these four columns: there is nowhere for an answer to hide.
    expect(Object.keys(status.rows[0]).sort()).toEqual(
      ["display_name", "has_answered", "role", "user_id"].sort(),
    );
    expect(JSON.stringify(status.rows)).not.toMatch(/SECRET/);
  });

  it("lists the organiser first and who has answered", async () => {
    const status = await asUser<{
      display_name: string;
      role: string;
      has_answered: boolean;
    }>(db, BOB, `select * from trip_response_status($1)`, [tripId]);
    expect(status.rows.map((r) => [r.display_name, r.role, r.has_answered])).toEqual([
      ["alice", "owner", true],
      ["Bob", "member", true],
    ]);
  });

  it("flags a member who has not answered yet as waiting", async () => {
    // Dan joins but never fills in a card.
    const DAN = "00000000-0000-0000-0000-00000000000d";
    await db.exec(`insert into auth.users values ('${DAN}', 'dan@example.com')`);
    await asUser(db, DAN, `select join_trip($1, 'Dan')`, [inviteToken]);

    const status = await asUser<{ display_name: string; has_answered: boolean }>(
      db,
      ALICE,
      `select display_name, has_answered from trip_response_status($1)`,
      [tripId],
    );
    expect(status.rows.find((r) => r.display_name === "Dan")?.has_answered).toBe(
      false,
    );
  });

  it("returns nothing to someone who is not on the trip", async () => {
    const status = await asUser(
      db,
      CAROL,
      `select * from trip_response_status($1)`,
      [tripId],
    );
    expect(status.rows).toHaveLength(0);
  });
});

describe("invite links", () => {
  it("the organiser is a member automatically", async () => {
    const rows = await asUser<{ role: string }>(
      db,
      ALICE,
      `select role from trip_members where user_id = $1 and trip_id = $2`,
      [ALICE, tripId],
    );
    expect(rows.rows[0].role).toBe("owner");
  });

  it("the invite token is long and random, not guessable", () => {
    expect(inviteToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it("an outsider can preview the trip from the link but sees nothing else", async () => {
    const preview = await asUser<Record<string, unknown>>(
      db,
      CAROL,
      `select * from invite_preview($1)`,
      [inviteToken],
    );
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]).toMatchObject({
      name: "Goa",
      already_member: false,
    });

    const trips = await asUser(db, CAROL, `select * from trips`);
    expect(trips.rows).toHaveLength(0);
    const members = await asUser(db, CAROL, `select * from trip_members`);
    expect(members.rows).toHaveLength(0);
  });

  it("a wrong token previews nothing and cannot be used to join", async () => {
    const preview = await asUser(
      db,
      CAROL,
      `select * from invite_preview($1)`,
      ["not-a-real-token"],
    );
    expect(preview.rows).toHaveLength(0);

    await expect(
      asUser(db, CAROL, `select join_trip($1)`, ["not-a-real-token"]),
    ).rejects.toThrow(/not valid/);
  });

  it("joining twice does not duplicate the member", async () => {
    await asUser(db, BOB, `select join_trip($1, 'Bob again')`, [inviteToken]);
    const rows = await asUser<{ display_name: string }>(
      db,
      BOB,
      `select display_name from trip_members where user_id = $1 and trip_id = $2`,
      [BOB, tripId],
    );
    expect(rows.rows).toEqual([{ display_name: "Bob" }]);
  });

  it("signed-out visitors cannot join or preview", async () => {
    await expect(
      asUser(db, null, `select join_trip($1)`, [inviteToken]),
    ).rejects.toThrow(BLOCKED);
    await expect(
      asUser(db, null, `select * from invite_preview($1)`, [inviteToken]),
    ).rejects.toThrow(BLOCKED);
  });

  it("a friend who joins can then see the trip and its members", async () => {
    await asUser(db, CAROL, `select join_trip($1, 'Carol')`, [inviteToken]);
    const trips = await asUser(db, CAROL, `select id from trips`);
    expect(trips.rows).toHaveLength(1);
    const members = await asUser(db, CAROL, `select * from trip_members`);
    expect(members.rows.length).toBeGreaterThanOrEqual(3);

    // Joining gave Carol access to the trip, but still not to anyone's answers.
    const prefs = await asUser(db, CAROL, `select * from preferences`);
    expect(prefs.rows).toHaveLength(0);
  });
});
