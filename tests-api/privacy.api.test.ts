// AUTHENTICATED API tests for PRD 01-03, against a SEPARATE test Supabase
// project (never production). Every call goes through Supabase's real REST
// API with a real signed-in user's JWT: no service key, no hidden buttons.
//
//   A  organiser of the trip
//   B  member of the same trip
//   C  signed in, but NOT on the trip
//   D  member, used only to reach a third budget answer
//
// Setup: see BUILD_STATUS.md "Authenticated API tests". Needs the test
// project to have migrations 001-008 + supabase/test-support/001_test_only.sql,
// the Email provider ON and "Confirm email" OFF. Passwords are random and
// never printed. Run with: npm run test:api
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_SUPABASE_URL as string;
const key = process.env.TEST_SUPABASE_PUBLISHABLE_KEY as string;
const run = Date.now().toString(36);

type Person = { db: SupabaseClient; id: string };

async function signUp(label: string): Promise<Person> {
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await db.auth.signUp({
    email: `api-${run}-${label}@example.com`,
    password: randomBytes(18).toString("base64url"),
  });
  if (error) throw new Error(`sign-up ${label}: ${error.message}`);
  if (!data.session || !data.user) throw new Error("No session: switch off 'Confirm email' in the TEST project");
  return { db, id: data.user.id };
}

function ok<T>(r: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (r.error) throw new Error(r.error.message);
  if (r.data === null || r.data === undefined) throw new Error("no data returned");
  return r.data as NonNullable<T>;
}

const RS = (rupees: number) => rupees * 100;

let A: Person, B: Person, C: Person, D: Person;
let trip: string;
let otherTrip: string;
let liveToken: string;

beforeAll(async () => {
  expect(url, "TEST_SUPABASE_URL missing from .env.test.local").toBeTruthy();
  expect(key, "TEST_SUPABASE_PUBLISHABLE_KEY missing from .env.test.local").toBeTruthy();
  expect(url).not.toContain("bbqsuwsloegyjutbefjd"); // never the production project
  [A, B, C, D] = await Promise.all([signUp("a"), signUp("b"), signUp("c"), signUp("d")]);

  trip = ok(
    await A.db.from("trips").insert({ name: `API ${run}`, timezone: "Asia/Kolkata", currency: "INR" }).select("id").single(),
  ).id;
  const invite = ok(await A.db.rpc("create_invite", { _trip_id: trip, _valid_days: 7 })) as { token: string };
  liveToken = invite.token;
  expect(ok(await B.db.rpc("redeem_invite", { _token: liveToken, _display_name: "B" }))).toEqual({
    status: "joined",
    trip_id: trip,
  });
  otherTrip = ok(
    await B.db.from("trips").insert({ name: `B own ${run}`, timezone: "Asia/Kolkata", currency: "INR" }).select("id").single(),
  ).id;
});

describe("a new account starts empty", () => {
  it("C sees no trips at all", async () => {
    expect(ok(await C.db.from("trips").select("id"))).toEqual([]);
  });
});

describe("C (outside the trip) cannot read or write trip data", () => {
  it("reads return nothing", async () => {
    for (const table of ["trips", "trip_members", "polls", "poll_options", "poll_votes", "preferences", "trip_invites", "stays"]) {
      const sel = table === "trips" ? "id" : table === "trip_invites" ? "id" : "*";
      const { data, error } = await C.db.from(table).select(sel).eq(table === "trips" ? "id" : "trip_id", trip);
      expect(error, table).toBeNull();
      expect(data, table).toEqual([]);
    }
  });

  it("writes and trip functions are refused", async () => {
    const stay = await C.db.from("stays").insert({ trip_id: trip, name: "x", added_by: C.id });
    expect(stay.error?.message).toMatch(/row-level security/);
    const pref = await C.db.from("preferences").insert({ trip_id: trip, user_id: C.id, budget_min_paise: 1, budget_max_paise: 2 });
    expect(pref.error).not.toBeNull();
    const member = await C.db.from("trip_members").insert({ trip_id: trip, user_id: C.id, display_name: "C" });
    expect(member.error?.message).toMatch(/permission denied|row-level security/);
    for (const [fn, args] of [
      ["set_rsvp", { _trip_id: trip, _rsvp: "in" }],
      ["trip_budget_band", { _trip_id: trip }],
      ["preference_progress", { _trip_id: trip }],
      ["create_invite", { _trip_id: trip, _valid_days: 7 }],
      ["add_poll_option", { _trip_id: trip, _kind: "destination", _label: "Goa" }],
    ] as const) {
      const r = await C.db.rpc(fn, args);
      expect(r.error?.message, fn).toMatch(/not a member/);
    }
  });

  it("C cannot redeem an expired invite, nor a revoked one, nor guess one", async () => {
    const created = ok(await A.db.rpc("create_invite", { _trip_id: trip, _valid_days: 1 })) as { id: string; token: string };
    ok(await A.db.rpc("test_expire_invite", { _invite_id: created.id }));
    expect(ok(await C.db.rpc("preview_invite", { _token: created.token }))).toEqual({ status: "invalid" });
    expect(ok(await C.db.rpc("redeem_invite", { _token: created.token }))).toEqual({ status: "invalid" });

    const revoked = ok(await A.db.rpc("create_invite", { _trip_id: trip, _valid_days: 1 })) as { id: string; token: string };
    ok(await A.db.rpc("revoke_invite", { _invite_id: revoked.id }));
    expect(ok(await C.db.rpc("redeem_invite", { _token: revoked.token }))).toEqual({ status: "invalid" });

    expect(ok(await C.db.rpc("redeem_invite", { _token: "0".repeat(64) }))).toEqual({ status: "invalid" });
    expect(ok(await C.db.from("trips").select("id").eq("id", trip))).toEqual([]);
  });
});

describe("roles and cross-trip writes", () => {
  it("B cannot promote themselves or anyone", async () => {
    const direct = await B.db.from("trip_members").update({ role: "owner" }).eq("trip_id", trip).eq("user_id", B.id);
    expect(direct.error?.message).toMatch(/permission denied/);
    const rpc = await B.db.rpc("set_member_role", { _trip_id: trip, _user_id: B.id, _role: "co_planner" });
    expect(rpc.error?.message).toMatch(/Only the organiser can change roles/);
    const members = ok(await A.db.from("trip_members").select("user_id, role").eq("trip_id", trip));
    expect(members.find((m) => m.user_id === B.id)?.role).toBe("member");
  });

  it("B cannot move a row from this trip into their own other trip", async () => {
    const stay = ok(await B.db.from("stays").insert({ trip_id: trip, name: "Villa", added_by: B.id }).select("id").single());
    const moved = await B.db.from("stays").update({ trip_id: otherTrip }).eq("id", stay.id);
    expect(moved.error?.message).toMatch(/cannot be moved/);
  });

  it("nobody changes the trip currency", async () => {
    const r = await A.db.from("trips").update({ currency: "USD" }).eq("id", trip);
    expect(r.error?.message).toMatch(/permission denied/);
  });
});

describe("votes and preference cards are your own", () => {
  it("A cannot cast or change B's vote", async () => {
    const opt = ok(await A.db.rpc("add_poll_option", { _trip_id: trip, _kind: "destination", _label: "Goa" })) as string;
    ok(await B.db.rpc("cast_vote", { _option_id: opt }));
    const write = await A.db.from("poll_votes").update({ option_id: opt }).eq("user_id", B.id);
    expect(write.error?.message).toMatch(/permission denied/);
    const votes = ok(await A.db.from("poll_votes").select("user_id").eq("trip_id", trip));
    expect(votes).toEqual([{ user_id: B.id }]);
  });
});

describe("budget privacy", () => {
  async function band(p: Person) {
    return ok(await p.db.rpc("trip_budget_band", { _trip_id: trip })) as Record<string, unknown>;
  }
  async function setRange(p: Person, min: number, max: number) {
    ok(
      await p.db
        .from("preferences")
        .upsert({ trip_id: trip, user_id: p.id, budget_min_paise: min, budget_max_paise: max }, { onConflict: "trip_id,user_id" }),
    );
  }

  it("suppresses the aggregate before three submissions", async () => {
    expect(await band(A)).toEqual({ status: "insufficient", respondents: 0, needed: 3 });
    await setRange(A, RS(18500), RS(30000));
    expect(await band(B)).toEqual({ status: "insufficient", respondents: 1, needed: 3 });
    await setRange(B, RS(20300), RS(26700));
    const two = await band(A);
    expect(two).toEqual({ status: "insufficient", respondents: 2, needed: 3 });
    expect(JSON.stringify(two)).not.toMatch(/2030000|2670000/);
  });

  it("A (the organiser) cannot read B's raw budget", async () => {
    expect(ok(await A.db.from("preferences").select("*").eq("user_id", B.id))).toEqual([]);
    const mine = ok(await A.db.from("preferences").select("user_id").eq("trip_id", trip));
    expect(mine).toEqual([{ user_id: A.id }]);
    const write = await A.db.from("preferences").update({ budget_max_paise: 1 }).eq("user_id", B.id).select("user_id");
    expect(write.data ?? []).toEqual([]);
  });

  it("rejects max below min", async () => {
    const r = await B.db
      .from("preferences")
      .upsert({ trip_id: trip, user_id: B.id, budget_min_paise: RS(30000), budget_max_paise: RS(1000) }, { onConflict: "trip_id,user_id" });
    expect(r.error?.message).toMatch(/check constraint/);
  });

  it("releases only a rounded band at three respondents, and no overlap honestly", async () => {
    const invite = ok(await A.db.rpc("create_invite", { _trip_id: trip, _valid_days: 1 })) as { token: string };
    ok(await D.db.rpc("redeem_invite", { _token: invite.token }));
    await setRange(D, RS(15000), RS(25200));
    expect(await band(B)).toEqual({
      status: "band",
      respondents: 3,
      low_minor: RS(20000),
      high_minor: RS(26000),
      step_minor: RS(1000),
      currency: "INR",
      scope: "total_per_person_incl_flights",
    });
    await setRange(D, RS(40000), RS(50000));
    expect(await band(A)).toEqual({ status: "no_overlap", respondents: 3 });
  });

  it("C still gets nothing", async () => {
    const r = await C.db.rpc("trip_budget_band", { _trip_id: trip });
    expect(r.error?.message).toMatch(/not a member/);
    expect(ok(await C.db.from("preferences").select("*"))).toEqual([]);
  });

  it("the progress view gives counts, never names", async () => {
    const p = ok(await B.db.rpc("preference_progress", { _trip_id: trip })) as Record<string, unknown>;
    expect(Object.keys(p).sort()).toEqual(["cards_submitted", "me_budget_submitted", "me_card_submitted", "members"]);
    expect(p.members).toBe(3);
  });
});
