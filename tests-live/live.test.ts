// LIVE end-to-end check against your REAL Supabase project.
//
// Run with:  npm run test:live
//
// It signs up three throwaway users with random passwords (never printed),
// then drives the same database calls the app makes, as each of them, and
// checks the row-level security rules actually hold on the real database.
// Needs "Confirm email" switched off in Supabase while it runs, because the
// throwaway addresses have no inbox. Normal `npm test` never runs this file.
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;
const runId = Date.now().toString(36);

type Person = { supabase: SupabaseClient; id: string; email: string };

function newClient(): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function newUser(label: string): Promise<Person> {
  const supabase = newClient();
  const email = `gp-live-${runId}-${label}@example.com`;
  const password = randomBytes(18).toString("base64url"); // never logged
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw new Error(`Sign-up failed for ${label}: ${error.message}`);
  if (!data.session || !data.user) {
    throw new Error("No session came back. Is 'Confirm email' still switched on?");
  }
  return { supabase, id: data.user.id, email };
}

/** Throws with the database's own message if a call failed or returned nothing. */
function ok<T>(result: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null || result.data === undefined) {
    throw new Error("The database returned no data");
  }
  return result.data as NonNullable<T>;
}

let alice: Person; // the organiser
let bob: Person; // joins by invite link
let carol: Person; // never joins
let tripId: string;
let inviteToken: string;
const created: string[] = [];

beforeAll(async () => {
  expect(url, "NEXT_PUBLIC_SUPABASE_URL missing from .env.local").toBeTruthy();
  expect(anonKey, "NEXT_PUBLIC_SUPABASE_ANON_KEY missing from .env.local").toBeTruthy();
  alice = await newUser("alice");
  bob = await newUser("bob");
  carol = await newUser("carol");
  created.push(alice.email, bob.email, carol.email);
}, 60_000);

afterAll(async () => {
  // Remove the test trip (its members, stays, preferences etc. go with it).
  if (tripId) await alice.supabase.from("trips").delete().eq("id", tripId);
  console.log(
    "\nThrowaway test users left in Supabase (Authentication > Users), safe to delete:\n  " +
      created.join("\n  "),
  );
});

describe("starting a trip and inviting friends", () => {
  it("the organiser creates a trip, becomes its owner member, and gets an invite token", async () => {
    const trip = ok(
      await alice.supabase
        .from("trips")
        .insert({
          name: "Live test trip",
          destination: "Goa",
          start_date: "2026-12-10",
          end_date: "2026-12-14",
        })
        .select("id, owner_id, currency, invite_token")
        .single(),
    );
    tripId = trip.id;
    inviteToken = trip.invite_token;
    expect(trip.owner_id).toBe(alice.id); // owner_id defaults to the signed-in user
    expect(trip.currency).toBe("INR");
    expect(inviteToken).toMatch(/^[0-9a-f]{32}$/);

    const members = ok(
      await alice.supabase.from("trip_members").select("user_id, role").eq("trip_id", tripId),
    );
    expect(members).toEqual([{ user_id: alice.id, role: "owner" }]);
  });

  it("someone not on the trip cannot see it, but can preview it from the invite link", async () => {
    const seen = ok(await carol.supabase.from("trips").select("id"));
    expect(seen).toHaveLength(0);

    const preview = ok(await carol.supabase.rpc("invite_preview", { _token: inviteToken }));
    expect(preview).toHaveLength(1);
    expect(preview[0]).toMatchObject({ name: "Live test trip", already_member: false });
  });

  it("a friend joins with the link, and joining twice is harmless", async () => {
    const joined = ok(await bob.supabase.rpc("join_trip", { _token: inviteToken, _display_name: "Bob" }));
    expect(joined).toBe(tripId);
    ok(await bob.supabase.rpc("join_trip", { _token: inviteToken, _display_name: "Bob again" }));

    const members = ok(await bob.supabase.from("trip_members").select("user_id, display_name"));
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.user_id === bob.id)?.display_name).toBe("Bob");
    expect(ok(await bob.supabase.from("trips").select("id"))).toHaveLength(1);
  });

  it("a wrong invite token cannot be used", async () => {
    const result = await carol.supabase.rpc("join_trip", { _token: "not-a-real-token" });
    expect(result.error?.message).toMatch(/not valid/);
  });

  it("a signed-out visitor cannot read any table", async () => {
    const anon = newClient();
    for (const table of ["trips", "trip_members", "preferences", "stays", "itinerary_items"]) {
      const { data, error } = await anon.from(table).select("*");
      expect(error, `${table} should be locked to signed-out visitors`).not.toBeNull();
      expect(data).toBeNull();
    }
  });
});

describe("preference cards are private", () => {
  it("each member saves their own card", async () => {
    ok(
      await alice.supabase.from("preferences").upsert(
        {
          trip_id: tripId,
          user_id: alice.id,
          budget_min_paise: 1_000_000,
          budget_max_paise: 2_500_000,
          pace: "packed",
          interests: ["Food"],
          food_notes: "ALICE-SECRET",
          submitted_at: new Date().toISOString(),
        },
        { onConflict: "trip_id,user_id" },
      ),
    );
    ok(
      await bob.supabase.from("preferences").upsert(
        {
          trip_id: tripId,
          user_id: bob.id,
          pace: "relaxed",
          must_see: "BOB-SECRET",
          submitted_at: new Date().toISOString(),
        },
        { onConflict: "trip_id,user_id" },
      ),
    );
  });

  it("one member cannot read another member's preferences row", async () => {
    const direct = ok(await bob.supabase.from("preferences").select("*").eq("user_id", alice.id));
    expect(direct).toHaveLength(0);

    const all = ok(await bob.supabase.from("preferences").select("user_id"));
    expect(all.map((r) => r.user_id)).toEqual([bob.id]);
  });

  it("the organiser cannot read a member's answers either", async () => {
    const all = ok(await alice.supabase.from("preferences").select("user_id"));
    expect(all.map((r) => r.user_id)).toEqual([alice.id]);
  });

  it("an outsider sees no preferences, and cannot write one into the trip", async () => {
    expect(ok(await carol.supabase.from("preferences").select("*"))).toHaveLength(0);
    const attempt = await carol.supabase
      .from("preferences")
      .insert({ trip_id: tripId, user_id: carol.id });
    expect(attempt.error).not.toBeNull();
  });

  it("a member cannot change or delete someone else's card", async () => {
    const edit = ok(
      await bob.supabase.from("preferences").update({ pace: "hacked" }).eq("user_id", alice.id).select(),
    );
    expect(edit).toHaveLength(0);
    const del = ok(await bob.supabase.from("preferences").delete().eq("user_id", alice.id).select());
    expect(del).toHaveLength(0);

    const mine = ok(await alice.supabase.from("preferences").select("pace").eq("user_id", alice.id));
    expect(mine[0].pace).toBe("packed");
  });

  it("the trip page can show who answered without exposing any answers", async () => {
    const status = ok(await alice.supabase.rpc("trip_response_status", { _trip_id: tripId }));
    expect(status).toHaveLength(2);
    expect(Object.keys(status[0]).sort()).toEqual(
      ["display_name", "has_answered", "role", "user_id"].sort(),
    );
    expect(JSON.stringify(status)).not.toMatch(/SECRET/);
    expect(status.every((s: { has_answered: boolean }) => s.has_answered)).toBe(true);

    const outsider = ok(await carol.supabase.rpc("trip_response_status", { _trip_id: tripId }));
    expect(outsider).toHaveLength(0);
  });
});

describe("stays, dates and map locations", () => {
  it("a member adds a stay with money in paise, a cancellation type and a map location", async () => {
    const stay = ok(
      await bob.supabase
        .from("stays")
        .insert({
          trip_id: tripId,
          added_by: bob.id,
          name: "Villa Sol",
          url: "https://example.com/villa",
          nightly_price_paise: 1_200_000,
          taxes_paise: 576_000,
          fees_paise: 150_000,
          cancellation_type: "non_refundable",
          rooms: 3,
          beds: 6,
          distance_km: 2.5,
          price_checked_on: "2026-11-18",
          latitude: 15.2993,
          longitude: 74.124,
        })
        .select("nightly_price_paise, latitude, cancellation_type")
        .single(),
    );
    expect(Number(stay.nightly_price_paise)).toBe(1_200_000);
    expect(Number(stay.latitude)).toBe(15.2993);
    expect(stay.cancellation_type).toBe("non_refundable");
  });

  it("other members see the stay; outsiders do not", async () => {
    expect(ok(await alice.supabase.from("stays").select("name"))).toHaveLength(1);
    expect(ok(await carol.supabase.from("stays").select("name"))).toHaveLength(0);
  });

  it("nobody can add a stay in someone else's name, or without a location pair", async () => {
    const spoof = await bob.supabase
      .from("stays")
      .insert({ trip_id: tripId, name: "x", added_by: alice.id });
    expect(spoof.error).not.toBeNull();

    const half = await bob.supabase
      .from("stays")
      .insert({ trip_id: tripId, name: "x", added_by: bob.id, latitude: 15.2 });
    expect(half.error).not.toBeNull();
  });

  it("only the organiser can change the trip dates", async () => {
    const byBob = ok(
      await bob.supabase.from("trips").update({ end_date: "2026-12-20" }).eq("id", tripId).select("id"),
    );
    expect(byBob).toHaveLength(0);

    const byAlice = ok(
      await alice.supabase.from("trips").update({ end_date: "2026-12-15" }).eq("id", tripId).select("end_date"),
    );
    expect(byAlice[0].end_date).toBe("2026-12-15");
  });

  it("an itinerary item can carry a map location and members can read it", async () => {
    ok(
      await alice.supabase.from("itinerary_items").insert({
        trip_id: tripId,
        day_number: 2,
        time: "17:30",
        title: "Sunset at Chapora Fort",
        place_url: "https://example.com/chapora",
        latitude: 15.6054,
        longitude: 73.7391,
      }),
    );
    const items = ok(await bob.supabase.from("itinerary_items").select("title, latitude"));
    expect(items).toHaveLength(1);
    expect(Number(items[0].latitude)).toBe(15.6054);
    expect(ok(await carol.supabase.from("itinerary_items").select("*"))).toHaveLength(0);
  });
});
