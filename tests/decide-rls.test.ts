// Database rules for 01 Trip home + 02 Decide (supabase/006_decide.sql),
// run against the real SQL in an in-memory Postgres.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, CAROL, ERIN, asUser, createDb, inviteAndJoin } from "./helpers/db";

const BLOCKED = /row-level security|permission denied/;

let db: PGlite;
let tripId: string;

function daysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function one<T>(userId: string, sql: string, params: unknown[] = []): Promise<T> {
  const result = await asUser<T>(db, userId, sql, params);
  return result.rows[0];
}

async function addDates(userId: string, start: number, end: number): Promise<string> {
  const row = await one<{ id: string }>(
    userId,
    `select add_poll_option($1, 'dates', null, $2::date, $3::date) as id`,
    [tripId, daysFromNow(start), daysFromNow(end)],
  );
  return row.id;
}

beforeAll(async () => {
  db = await createDb();
  const trip = await asUser<{ id: string }>(
    db,
    ALICE,
    `insert into trips (name) values ('Friends trip') returning id`,
  );
  tripId = trip.rows[0].id;
  await inviteAndJoin(db, ALICE, tripId, BOB, "Bob");
  await inviteAndJoin(db, ALICE, tripId, ERIN, "Erin");
});

afterAll(async () => {
  await db.close();
});

describe("roles", () => {
  it("new members are travellers who have not answered the RSVP", async () => {
    const rows = await asUser<{ user_id: string; role: string; rsvp: string }>(
      db,
      BOB,
      `select user_id, role, rsvp from trip_members where trip_id = $1 order by user_id`,
      [tripId],
    );
    expect(rows.rows.map((r) => [r.user_id, r.role, r.rsvp])).toEqual([
      [ALICE, "owner", "not_yet"],
      [BOB, "member", "not_yet"],
      [ERIN, "member", "not_yet"],
    ]);
  });

  it("only the organiser can make someone a co-planner", async () => {
    await expect(
      asUser(db, BOB, `select set_member_role($1, $2, 'co_planner')`, [tripId, ERIN]),
    ).rejects.toThrow(/Only the organiser can change roles/);

    await asUser(db, ALICE, `select set_member_role($1, $2, 'co_planner')`, [tripId, ERIN]);
    const erin = await one<{ role: string }>(
      ALICE,
      `select role from trip_members where trip_id = $1 and user_id = $2`,
      [tripId, ERIN],
    );
    expect(erin.role).toBe("co_planner");
  });

  it("nobody can hand out or take away the organiser role", async () => {
    await expect(
      asUser(db, ALICE, `select set_member_role($1, $2, 'owner')`, [tripId, BOB]),
    ).rejects.toThrow(/Choose co-planner or traveller/);
    // Not even with a direct table update: the role column is not writable
    // by anyone through the API (007 column grants).
    await expect(
      asUser(db, ALICE, `update trip_members set role = 'owner' where trip_id = $1 and user_id = $2`, [tripId, BOB]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(db, ALICE, `update trip_members set role = 'member' where trip_id = $1 and user_id = $2`, [tripId, ALICE]),
    ).rejects.toThrow(/permission denied/);
  });

  it("a traveller cannot promote themselves", async () => {
    const result = await asUser(
      db,
      BOB,
      `update trip_members set role = 'co_planner' where trip_id = $1 and user_id = $2`,
      [tripId, BOB],
    ).catch((e: Error) => e);
    // Either blocked outright or zero rows changed: his role must not move.
    if (!(result instanceof Error)) expect(result.affectedRows ?? 0).toBe(0);
    const bob = await one<{ role: string }>(
      BOB,
      `select role from trip_members where trip_id = $1 and user_id = $2`,
      [tripId, BOB],
    );
    expect(bob.role).toBe("member");
  });
});

describe("renaming the trip", () => {
  it("a co-planner can rename it; a traveller cannot", async () => {
    await asUser(db, ERIN, `select rename_trip($1, '  Goa, finally  ')`, [tripId]);
    const trip = await one<{ name: string }>(BOB, `select name from trips where id = $1`, [tripId]);
    expect(trip.name).toBe("Goa, finally");

    await expect(
      asUser(db, BOB, `select rename_trip($1, 'Bob trip')`, [tripId]),
    ).rejects.toThrow(/Only the organiser or a co-planner/);
  });

  it("rejects blank and over-long names", async () => {
    await expect(asUser(db, ALICE, `select rename_trip($1, '   ')`, [tripId])).rejects.toThrow(
      /1 to 80 characters/,
    );
    await expect(
      asUser(db, ALICE, `select rename_trip($1, $2)`, [tripId, "x".repeat(81)]),
    ).rejects.toThrow(/1 to 80 characters/);
  });
});

describe("RSVP", () => {
  it("you set your own RSVP", async () => {
    await asUser(db, BOB, `select set_rsvp($1, 'maybe')`, [tripId]);
    await asUser(db, BOB, `select set_rsvp($1, 'maybe')`, [tripId]); // retry is harmless
    const bob = await one<{ rsvp: string; rsvp_updated_at: string | null }>(
      ALICE,
      `select rsvp, rsvp_updated_at from trip_members where trip_id = $1 and user_id = $2`,
      [tripId, BOB],
    );
    expect(bob.rsvp).toBe("maybe");
    expect(bob.rsvp_updated_at).not.toBeNull();
  });

  it("rejects anything but In, Maybe or Not yet", async () => {
    await expect(asUser(db, BOB, `select set_rsvp($1, 'yes')`, [tripId])).rejects.toThrow(
      /In, Maybe or Not yet/,
    );
  });

  it("the organiser cannot answer for someone else, even with a direct update", async () => {
    // Since 007 you can only update your own member row, so this changes nothing.
    const result = await asUser(
      db,
      ALICE,
      `update trip_members set rsvp = 'in' where trip_id = $1 and user_id = $2`,
      [tripId, BOB],
    );
    expect(result.affectedRows ?? 0).toBe(0);
    const bob = await one<{ rsvp: string }>(
      BOB,
      `select rsvp from trip_members where trip_id = $1 and user_id = $2`,
      [tripId, BOB],
    );
    expect(bob.rsvp).toBe("maybe");
  });

  it("an outsider cannot RSVP to a trip they are not on", async () => {
    await expect(asUser(db, CAROL, `select set_rsvp($1, 'in')`, [tripId])).rejects.toThrow(
      /not a member/,
    );
  });
});

describe("dates and destination votes", () => {
  let juneOption: string;
  let julyOption: string;

  it("any member can suggest dates; the vote is created with its first option", async () => {
    juneOption = await addDates(BOB, 30, 34);
    julyOption = await addDates(ALICE, 60, 64);
    const polls = await asUser<{ kind: string; status: string }>(
      db,
      ERIN,
      `select kind, status from polls where trip_id = $1`,
      [tripId],
    );
    expect(polls.rows).toEqual([{ kind: "dates", status: "open" }]);
  });

  it("suggesting the same dates twice returns the same option (retry-safe)", async () => {
    const again = await addDates(BOB, 30, 34);
    expect(again).toBe(juneOption);
    const count = await one<{ n: number }>(
      ALICE,
      `select count(*)::int as n from poll_options where trip_id = $1`,
      [tripId],
    );
    expect(count.n).toBe(2);
  });

  it("rejects past, reversed and over-long date ranges", async () => {
    await expect(addDates(BOB, -5, 2)).rejects.toThrow(/in the past/);
    await expect(addDates(BOB, 10, 10)).rejects.toThrow(/after the start date/);
    await expect(addDates(BOB, 10, 80)).rejects.toThrow(/at most 60 nights/);
  });

  it("one vote per person; voting again replaces it", async () => {
    await asUser(db, BOB, `select cast_vote($1)`, [juneOption]);
    await asUser(db, BOB, `select cast_vote($1)`, [julyOption]);
    await asUser(db, BOB, `select cast_vote($1)`, [julyOption]); // retry
    const votes = await asUser<{ user_id: string; option_id: string }>(
      db,
      ALICE,
      `select user_id, option_id from poll_votes where trip_id = $1`,
      [tripId],
    );
    expect(votes.rows).toEqual([{ user_id: BOB, option_id: julyOption }]);
  });

  it("nobody can write votes or options directly", async () => {
    await expect(
      asUser(
        db,
        BOB,
        `insert into poll_votes (poll_id, option_id, trip_id, user_id)
         select poll_id, id, trip_id, $2 from poll_options where id = $1`,
        [juneOption, ALICE],
      ),
    ).rejects.toThrow(BLOCKED);
    await expect(
      asUser(db, ALICE, `delete from poll_options where id = $1`, [juneOption]),
    ).rejects.toThrow(BLOCKED);
    await expect(
      asUser(db, ALICE, `update polls set status = 'settled' where trip_id = $1`, [tripId]),
    ).rejects.toThrow(BLOCKED);
  });

  it("outsiders see nothing and cannot vote", async () => {
    for (const table of ["polls", "poll_options", "poll_votes", "nudges"]) {
      const rows = await asUser(db, CAROL, `select * from ${table}`);
      expect(rows.rows, table).toHaveLength(0);
    }
    await expect(asUser(db, CAROL, `select cast_vote($1)`, [juneOption])).rejects.toThrow(
      /not a member/,
    );
  });

  it("only whoever suggested it, or a planner, can remove an option", async () => {
    const extra = await addDates(ALICE, 90, 92);
    await expect(asUser(db, BOB, `select remove_poll_option($1)`, [extra])).rejects.toThrow(
      /Only whoever suggested it/,
    );
    await asUser(db, ERIN, `select remove_poll_option($1)`, [extra]); // co-planner
    const gone = await asUser(db, ALICE, `select id from poll_options where id = $1`, [extra]);
    expect(gone.rows).toHaveLength(0);
  });

  it("a traveller cannot settle a vote", async () => {
    const poll = await one<{ id: string }>(BOB, `select id from polls where trip_id = $1 and kind = 'dates'`, [tripId]);
    await expect(
      asUser(db, BOB, `select settle_poll($1, $2)`, [poll.id, julyOption]),
    ).rejects.toThrow(/Only the organiser or a co-planner can settle/);
  });

  it("settling writes the dates to the trip and closes the vote", async () => {
    const poll = await one<{ id: string }>(ALICE, `select id from polls where trip_id = $1 and kind = 'dates'`, [tripId]);
    await asUser(db, ALICE, `select settle_poll($1, $2)`, [poll.id, julyOption]);
    await asUser(db, ALICE, `select settle_poll($1, $2)`, [poll.id, julyOption]); // retry
    const trip = await one<{ start_date: string; end_date: string }>(
      BOB,
      `select start_date::text, end_date::text from trips where id = $1`,
      [tripId],
    );
    expect(trip).toEqual({ start_date: daysFromNow(60), end_date: daysFromNow(64) });

    await expect(asUser(db, BOB, `select cast_vote($1)`, [juneOption])).rejects.toThrow(
      /already settled/,
    );
    await expect(addDates(BOB, 100, 102)).rejects.toThrow(/settled/);
    await expect(
      asUser(db, ALICE, `select settle_poll($1, $2)`, [poll.id, juneOption]),
    ).rejects.toThrow(/Reopen it first/);
  });

  it("an option from another vote cannot be used to settle this one", async () => {
    const destId = await one<{ id: string }>(
      BOB,
      `select add_poll_option($1, 'destination', 'Goa') as id`,
      [tripId],
    );
    const datesPoll = await one<{ id: string }>(ALICE, `select id from polls where trip_id = $1 and kind = 'dates'`, [tripId]);
    await asUser(db, ALICE, `select reopen_poll($1)`, [datesPoll.id]);
    await expect(
      asUser(db, ALICE, `select settle_poll($1, $2)`, [datesPoll.id, destId.id]),
    ).rejects.toThrow(/not part of this vote/);
  });

  it("destination suggestions ignore case and spaces when de-duplicating", async () => {
    const a = await one<{ id: string }>(BOB, `select add_poll_option($1, 'destination', 'Goa') as id`, [tripId]);
    const b = await one<{ id: string }>(ERIN, `select add_poll_option($1, 'destination', '  goa ') as id`, [tripId]);
    expect(b.id).toBe(a.id);
    await expect(
      asUser(db, BOB, `select add_poll_option($1, 'destination', '   ')`, [tripId]),
    ).rejects.toThrow(/1 to 80 characters/);
  });

  it("settling the destination writes it to the trip", async () => {
    const opt = await one<{ id: string }>(BOB, `select add_poll_option($1, 'destination', 'Coorg') as id`, [tripId]);
    const poll = await one<{ id: string }>(ERIN, `select id from polls where trip_id = $1 and kind = 'destination'`, [tripId]);
    await asUser(db, ERIN, `select settle_poll($1, $2)`, [poll.id, opt.id]);
    const trip = await one<{ destination: string }>(BOB, `select destination from trips where id = $1`, [tripId]);
    expect(trip.destination).toBe("Coorg");
  });
});

describe("nudges", () => {
  it("you can nudge someone who has not RSVPd; they and you can see it, others cannot", async () => {
    const sent = await one<{ r: string }>(BOB, `select nudge_member($1, $2, 'rsvp') as r`, [tripId, ERIN]);
    expect(sent.r).toBe("sent");

    const again = await one<{ r: string }>(BOB, `select nudge_member($1, $2, 'rsvp') as r`, [tripId, ERIN]);
    expect(again.r).toBe("recent"); // no spam within 12 hours

    const erinSees = await asUser(db, ERIN, `select topic from nudges where trip_id = $1`, [tripId]);
    expect(erinSees.rows).toEqual([{ topic: "rsvp" }]);
    const aliceSees = await asUser(db, ALICE, `select * from nudges where trip_id = $1`, [tripId]);
    expect(aliceSees.rows).toHaveLength(0);
  });

  it("answering clears the nudge", async () => {
    await asUser(db, ERIN, `select set_rsvp($1, 'in')`, [tripId]);
    const left = await asUser(db, ERIN, `select * from nudges where trip_id = $1`, [tripId]);
    expect(left.rows).toHaveLength(0);
  });

  it("you cannot nudge someone who already answered, yourself, or an outsider", async () => {
    await expect(
      asUser(db, BOB, `select nudge_member($1, $2, 'rsvp')`, [tripId, ERIN]),
    ).rejects.toThrow(/already answered/);
    await expect(
      asUser(db, BOB, `select nudge_member($1, $2, 'rsvp')`, [tripId, BOB]),
    ).rejects.toThrow(/yourself/);
    await expect(
      asUser(db, BOB, `select nudge_member($1, $2, 'rsvp')`, [tripId, CAROL]),
    ).rejects.toThrow(/not on this trip/);
    await expect(
      asUser(db, CAROL, `select nudge_member($1, $2, 'rsvp')`, [tripId, ALICE]),
    ).rejects.toThrow(/not a member/);
  });

  it("vote nudges only go to people who have not voted on an open vote", async () => {
    // The dates vote was reopened above; Bob has voted, Alice has not.
    const sent = await one<{ r: string }>(ERIN, `select nudge_member($1, $2, 'dates') as r`, [tripId, ALICE]);
    expect(sent.r).toBe("sent");
    await expect(
      asUser(db, ERIN, `select nudge_member($1, $2, 'dates')`, [tripId, BOB]),
    ).rejects.toThrow(/already answered/);
    // Alice votes: her nudge disappears.
    const option = await one<{ id: string }>(
      ALICE,
      `select o.id from poll_options o join polls p on p.id = o.poll_id
       where p.trip_id = $1 and p.kind = 'dates' limit 1`,
      [tripId],
    );
    await asUser(db, ALICE, `select cast_vote($1)`, [option.id]);
    const left = await asUser(db, ALICE, `select * from nudges where trip_id = $1`, [tripId]);
    expect(left.rows).toHaveLength(0);
  });

  it("nudges cannot be written directly", async () => {
    await expect(
      asUser(
        db,
        BOB,
        `insert into nudges (trip_id, topic, from_user, to_user) values ($1, 'rsvp', $2, $3)`,
        [tripId, BOB, ALICE],
      ),
    ).rejects.toThrow(BLOCKED);
  });
});

describe("signed-out visitors", () => {
  it("cannot read Decide tables or call its functions", async () => {
    await expect(asUser(db, null, `select * from polls`)).rejects.toThrow(BLOCKED);
    await expect(asUser(db, null, `select set_rsvp($1, 'in')`, [tripId])).rejects.toThrow(
      BLOCKED,
    );
  });
});
