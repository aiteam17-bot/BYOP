import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, CAROL, asUser, createDb, inviteAndJoin } from "./helpers/db";

let db: PGlite;
let tripId: string;

beforeAll(async () => {
  db = await createDb();
  const trip = await asUser<{ id: string }>(
    db,
    ALICE,
    `insert into trips (name, timezone, currency) values ('Goa', 'Asia/Kolkata', 'INR') returning id`,
  );
  tripId = trip.rows[0].id;
  await inviteAndJoin(db, ALICE, trip.rows[0].id, BOB, 'Bob');
});

afterAll(async () => {
  await db.close();
});

describe("map locations", () => {
  it("a stay and an itinerary item can each carry a location", async () => {
    await asUser(
      db,
      BOB,
      `insert into stays (trip_id, name, added_by, latitude, longitude)
       values ($1, 'Villa Sol', $2, 15.2993, 74.1240)`,
      [tripId, BOB],
    );
    await asUser(
      db,
      ALICE,
      `insert into itinerary_items (trip_id, day_number, title, place_url, latitude, longitude)
       values ($1, 1, 'Sunset', 'https://example.com', 15.6, 73.7)`,
      [tripId],
    );

    const stays = await asUser<{ latitude: string }>(db, ALICE, `select latitude from stays`);
    expect(Number(stays.rows[0].latitude)).toBe(15.2993);
    const items = await asUser(db, BOB, `select * from itinerary_items`);
    expect(items.rows).toHaveLength(1);
  });

  it("locations are optional", async () => {
    const rows = await asUser(
      db,
      BOB,
      `insert into stays (trip_id, name, added_by) values ($1, 'No pin', $2) returning id`,
      [tripId, BOB],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("latitude and longitude must come as a pair", async () => {
    await expect(
      asUser(
        db,
        BOB,
        `insert into stays (trip_id, name, added_by, latitude) values ($1, 'Half', $2, 15.2)`,
        [tripId, BOB],
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      asUser(
        db,
        ALICE,
        `insert into itinerary_items (trip_id, day_number, title, longitude) values ($1, 1, 'Half', 74.1)`,
        [tripId],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("rejects coordinates that are off the globe", async () => {
    await expect(
      asUser(
        db,
        BOB,
        `insert into stays (trip_id, name, added_by, latitude, longitude)
         values ($1, 'Nowhere', $2, 95, 10)`,
        [tripId, BOB],
      ),
    ).rejects.toThrow(/check constraint|out of range/);
  });

  it("people outside the trip cannot see its pins", async () => {
    const stays = await asUser(db, CAROL, `select * from stays`);
    const items = await asUser(db, CAROL, `select * from itinerary_items`);
    expect(stays.rows).toHaveLength(0);
    expect(items.rows).toHaveLength(0);
  });
});
