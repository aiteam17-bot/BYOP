import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, CAROL, asUser, createDb, inviteAndJoin } from "./helpers/db";

const BLOCKED = /row-level security|permission denied/;

let db: PGlite;
let tripId: string;

beforeAll(async () => {
  db = await createDb();
  const trip = await asUser<{ id: string }>(
    db,
    ALICE,
    `insert into trips (name, start_date, end_date)
     values ('Goa', '2026-12-10', '2026-12-14') returning id`,
  );
  tripId = trip.rows[0].id;
  await inviteAndJoin(db, ALICE, trip.rows[0].id, BOB, 'Bob');
});

afterAll(async () => {
  await db.close();
});

describe("stays (shared by trip members, unlike preferences)", () => {
  it("stores money as integer paise and the cancellation type", async () => {
    const added = await asUser<{
      nightly_price_paise: string | number;
      cancellation_type: string;
    }>(
      db,
      BOB,
      `insert into stays
         (trip_id, name, url, nightly_price_paise, taxes_paise, fees_paise,
          cancellation_type, rooms, beds, distance_km, price_checked_on, added_by)
       values ($1, 'Villa Sol', 'https://example.com', 1200000, 576000, 150000,
               'non_refundable', 3, 6, 2.5, '2026-11-18', $2)
       returning nightly_price_paise, cancellation_type`,
      [tripId, BOB],
    );
    expect(Number(added.rows[0].nightly_price_paise)).toBe(1_200_000);
    expect(added.rows[0].cancellation_type).toBe("non_refundable");
  });

  it("another member can read the stay", async () => {
    const rows = await asUser(db, ALICE, `select name from stays where trip_id = $1`, [tripId]);
    expect(rows.rows).toHaveLength(1);
  });

  it("someone outside the trip cannot read or add stays", async () => {
    const rows = await asUser(db, CAROL, `select * from stays`);
    expect(rows.rows).toHaveLength(0);
    await expect(
      asUser(
        db,
        CAROL,
        `insert into stays (trip_id, name, added_by) values ($1, 'x', $2)`,
        [tripId, CAROL],
      ),
    ).rejects.toThrow(BLOCKED);
  });

  it("a member cannot add a stay in someone else's name", async () => {
    await expect(
      asUser(
        db,
        BOB,
        `insert into stays (trip_id, name, added_by) values ($1, 'x', $2)`,
        [tripId, ALICE],
      ),
    ).rejects.toThrow(BLOCKED);
  });

  it("rejects an unknown cancellation type and a negative price", async () => {
    await expect(
      asUser(
        db,
        BOB,
        `insert into stays (trip_id, name, added_by, cancellation_type)
         values ($1, 'x', $2, 'maybe')`,
        [tripId, BOB],
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      asUser(
        db,
        BOB,
        `insert into stays (trip_id, name, added_by, nightly_price_paise)
         values ($1, 'x', $2, -1)`,
        [tripId, BOB],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("only the organiser can change the trip dates", async () => {
    const byBob = await asUser(
      db,
      BOB,
      `update trips set end_date = '2026-12-20' where id = $1 returning id`,
      [tripId],
    );
    expect(byBob.rows).toHaveLength(0);

    const byAlice = await asUser(
      db,
      ALICE,
      `update trips set end_date = '2026-12-15' where id = $1 returning id`,
      [tripId],
    );
    expect(byAlice.rows).toHaveLength(1);
  });
});
