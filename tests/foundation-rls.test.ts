// Foundation rules from supabase/007_foundation.sql, checked against the real
// SQL in an in-memory Postgres. Superuser queries (db.query without asUser)
// stand in for the Supabase dashboard / time passing.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALICE,
  BOB,
  CAROL,
  ERIN,
  asUser,
  createDb,
  createInvite,
  inviteAndJoin,
  redeem,
  sqlFile,
} from "./helpers/db";

const BLOCKED = /row-level security|permission denied/;
const DAVE = "00000000-0000-0000-0000-0000000000f1"; // signs up during the tests

let db: PGlite;
let tripId: string; // Alice's trip: Bob member, Erin co-planner
let otherTripId: string; // Bob's own trip

async function rows<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await asUser<T>(db, userId, sql, params)).rows;
}

beforeAll(async () => {
  db = await createDb();
  tripId = (await rows<{ id: string }>(ALICE, `insert into trips (name, timezone, currency) values ('Goa', 'Asia/Kolkata', 'INR') returning id`))[0].id;
  otherTripId = (await rows<{ id: string }>(BOB, `insert into trips (name, timezone, currency) values ('Coorg', 'Asia/Kolkata', 'INR') returning id`))[0].id;
  await inviteAndJoin(db, ALICE, tripId, BOB, "Bob");
  await inviteAndJoin(db, ALICE, tripId, ERIN, "Erin");
  await asUser(db, ALICE, `select set_member_role($1, $2, 'co_planner')`, [tripId, ERIN]);
});

afterAll(async () => {
  await db.close();
});

describe("version record", () => {
  it("records every migration, and nobody can read it through the API", async () => {
    const versions = await db.query<{ version: number }>(`select version from schema_versions order by version`);
    expect(versions.rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await expect(rows(ALICE, `select * from schema_versions`)).rejects.toThrow(BLOCKED);
    await expect(rows(null, `select * from schema_versions`)).rejects.toThrow(BLOCKED);
  });
});

describe("default deny", () => {
  it("every table in public has row-level security on", async () => {
    const off = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(off.rows).toEqual([]);
  });

  it("signed-out visitors have no privilege on any table", async () => {
    const granted = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and (has_table_privilege('anon', c.oid, 'select')
            or has_table_privilege('anon', c.oid, 'insert')
            or has_table_privilege('anon', c.oid, 'update')
            or has_table_privilege('anon', c.oid, 'delete'))`,
    );
    expect(granted.rows).toEqual([]);
  });

  it("every SECURITY DEFINER function pins search_path and is not executable by anyone signed out", async () => {
    const definers = await db.query<{ name: string; pinned: boolean; anon: boolean; everyone: boolean }>(
      `select n.nspname || '.' || p.proname as name,
              coalesce(array_to_string(p.proconfig, ',') like '%search_path=%', false) as pinned,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where a.grantee = 0 and a.privilege_type = 'EXECUTE') as everyone
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private') and p.prosecdef`,
    );
    expect(definers.rows.length).toBeGreaterThan(20);
    expect(definers.rows.filter((f) => !f.pinned)).toEqual([]);
    expect(definers.rows.filter((f) => f.anon || f.everyone)).toEqual([]);
  });

  it("the old helpers that answered for ANY user are no longer callable", async () => {
    for (const call of [
      `select is_trip_member($1, $2)`,
      `select is_trip_owner($1, $2)`,
      `select member_role($1, $2)`,
      `select can_plan($1, $2)`,
    ]) {
      await expect(rows(CAROL, call, [tripId, ALICE]), call).rejects.toThrow(BLOCKED);
    }
    await expect(rows(CAROL, `select * from invite_preview('x')`)).rejects.toThrow(BLOCKED);
    await expect(rows(CAROL, `select join_trip('x')`)).rejects.toThrow(BLOCKED);
  });

  it("the private helpers answer only for the caller", async () => {
    // Carol is on neither trip: she learns nothing about who is.
    const probe = await rows<{ a: boolean; b: boolean }>(
      CAROL,
      `select private.is_co_member($1, $2) as a, private.is_member($1) as b`,
      [tripId, ALICE],
    );
    expect(probe).toEqual([{ a: false, b: false }]);
  });

  it("health_check says ok and nothing else, even signed out", async () => {
    expect(await rows(null, `select health_check() as h`)).toEqual([{ h: "ok" }]);
  });
});

describe("profiles", () => {
  it("a new account gets a profile from its GitHub details, and sees no trips", async () => {
    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data)
       values ($1, 'dave@example.com', '{"user_name":"dave-gh","avatar_url":"https://avatars.example/d.png"}')`,
      [DAVE],
    );
    const profile = await rows<{ display_name: string; avatar_url: string }>(
      DAVE,
      `select display_name, avatar_url from profiles where id = $1`,
      [DAVE],
    );
    expect(profile).toEqual([{ display_name: "dave-gh", avatar_url: "https://avatars.example/d.png" }]);
    expect(await rows(DAVE, `select id from trips`)).toEqual([]);
    expect(await rows(DAVE, `select * from trip_members`)).toEqual([]);
  });

  it("you see the profiles of people you share a trip with, not strangers", async () => {
    const bobSees = await rows<{ id: string }>(BOB, `select id from profiles order by id`);
    expect(bobSees.map((r) => r.id).sort()).toEqual([ALICE, BOB, ERIN].sort());
    const daveSees = await rows<{ id: string }>(DAVE, `select id from profiles`);
    expect(daveSees.map((r) => r.id)).toEqual([DAVE]);
  });

  it("you can rename yourself, nobody else, and never change your id", async () => {
    await asUser(db, BOB, `update profiles set display_name = 'Bobby' where id = $1`, [BOB]);
    const mine = await rows<{ display_name: string }>(BOB, `select display_name from profiles where id = $1`, [BOB]);
    expect(mine[0].display_name).toBe("Bobby");

    const other = await asUser(db, BOB, `update profiles set display_name = 'x' where id = $1`, [ALICE]);
    expect(other.affectedRows ?? 0).toBe(0);
    await expect(
      asUser(db, BOB, `update profiles set id = $1 where id = $2`, [DAVE, BOB]),
    ).rejects.toThrow(BLOCKED);
  });
});

describe("trips and memberships", () => {
  it("creating a trip makes you its organiser in the same transaction", async () => {
    const id = (await rows<{ id: string }>(DAVE, `insert into trips (name, timezone, currency) values ('Hampi', 'Asia/Kolkata', 'INR') returning id`))[0].id;
    const me = await rows<{ role: string; display_name: string }>(
      DAVE,
      `select role, display_name from trip_members where trip_id = $1`,
      [id],
    );
    expect(me).toEqual([{ role: "owner", display_name: "dave-gh" }]);

    // If the transaction is rolled back, neither the trip nor the membership exists.
    await db.exec("begin");
    const ghost = (await rows<{ id: string }>(DAVE, `insert into trips (name, timezone, currency) values ('Ghost', 'Asia/Kolkata', 'INR') returning id`))[0].id;
    await db.exec("rollback");
    expect((await db.query(`select 1 from trips where id = $1`, [ghost])).rows).toEqual([]);
    expect((await db.query(`select 1 from trip_members where trip_id = $1`, [ghost])).rows).toEqual([]);
  });

  it("you cannot create a trip owned by someone else", async () => {
    await expect(
      rows(DAVE, `insert into trips (name, owner_id, timezone, currency) values ('Fake', $1, 'Asia/Kolkata', 'INR')`, [ALICE]),
    ).rejects.toThrow(BLOCKED);
  });

  it("nobody can join by guessing a trip id", async () => {
    await expect(
      rows(CAROL, `insert into trip_members (trip_id, user_id, display_name) values ($1, $2, 'Carol')`, [tripId, CAROL]),
    ).rejects.toThrow(BLOCKED);
    // Even the organiser cannot add someone without an invite.
    await expect(
      rows(ALICE, `insert into trip_members (trip_id, user_id, display_name) values ($1, $2, 'Carol')`, [tripId, CAROL]),
    ).rejects.toThrow(BLOCKED);
    expect(await rows(CAROL, `select id from trips where id = $1`, [tripId])).toEqual([]);
  });

  it("nobody can promote themselves", async () => {
    await expect(
      rows(BOB, `update trip_members set role = 'co_planner' where trip_id = $1 and user_id = $2`, [tripId, BOB]),
    ).rejects.toThrow(BLOCKED);
    await expect(
      rows(BOB, `select set_member_role($1, $2, 'co_planner')`, [tripId, BOB]),
    ).rejects.toThrow(/Only the organiser can change roles/);
    await expect(
      rows(ERIN, `select set_member_role($1, $2, 'co_planner')`, [tripId, BOB]),
    ).rejects.toThrow(/Only the organiser can change roles/);
  });

  it("the organiser cannot be removed and cannot leave while the trip exists", async () => {
    await expect(
      rows(ALICE, `delete from trip_members where trip_id = $1 and user_id = $2`, [tripId, ALICE]),
    ).rejects.toThrow(/organiser cannot leave or be removed/);
    const byMember = await asUser(db, BOB, `delete from trip_members where trip_id = $1 and user_id = $2`, [tripId, ALICE]);
    expect(byMember.affectedRows ?? 0).toBe(0);
    const owner = await rows(ALICE, `select 1 from trip_members where trip_id = $1 and role = 'owner'`, [tripId]);
    expect(owner).toHaveLength(1);
  });

  it("deleting the whole trip is allowed for the organiser only", async () => {
    const id = (await rows<{ id: string }>(DAVE, `insert into trips (name, timezone, currency) values ('Delete me', 'Asia/Kolkata', 'INR') returning id`))[0].id;
    const notOwner = await asUser(db, BOB, `delete from trips where id = $1`, [id]);
    expect(notOwner.affectedRows ?? 0).toBe(0);
    await asUser(db, DAVE, `delete from trips where id = $1`, [id]);
    expect((await db.query(`select 1 from trip_members where trip_id = $1`, [id])).rows).toEqual([]);
  });

  it("rows cannot be moved between trips, even between two trips you are on", async () => {
    const stay = (
      await rows<{ id: string }>(
        BOB,
        `insert into stays (trip_id, name, added_by) values ($1, 'Villa', $2) returning id`,
        [tripId, BOB],
      )
    )[0].id;
    await expect(
      rows(BOB, `update stays set trip_id = $1 where id = $2`, [otherTripId, stay]),
    ).rejects.toThrow(/cannot be moved/);

    await asUser(db, BOB, `insert into preferences (trip_id, user_id) values ($1, $2)`, [tripId, BOB]);
    await expect(
      rows(BOB, `update preferences set trip_id = $1 where trip_id = $2 and user_id = $3`, [otherTripId, tripId, BOB]),
    ).rejects.toThrow(/cannot be moved/);

    await asUser(db, BOB, `select add_stop($1, 1, '10:00', 60, 'Beach')`, [tripId]);
    await expect(
      rows(BOB, `update itinerary_items set trip_id = $1 where trip_id = $2`, [otherTripId, tripId]),
    ).rejects.toThrow(/cannot be moved|permission denied/);

    await expect(
      rows(ALICE, `update trips set owner_id = $1 where id = $2`, [BOB, tripId]),
    ).rejects.toThrow(/cannot be moved|row-level security|permission denied/);
  });

  it("you only edit stays you added", async () => {
    const stay = (
      await rows<{ id: string }>(
        BOB,
        `insert into stays (trip_id, name, added_by) values ($1, 'Mine', $2) returning id`,
        [tripId, BOB],
      )
    )[0].id;
    const byAlice = await asUser(db, ALICE, `update stays set name = 'Taken' where id = $1`, [stay]);
    expect(byAlice.affectedRows ?? 0).toBe(0);
  });

  it("the plaintext invite_token column is not readable or writable", async () => {
    await expect(rows(ALICE, `select invite_token from trips`)).rejects.toThrow(BLOCKED);
    await expect(
      rows(ALICE, `update trips set invite_token = 'abc' where id = $1`, [tripId]),
    ).rejects.toThrow(BLOCKED);
  });
});

describe("invites", () => {
  it("only the organiser and co-planners create links; the token itself is never stored", async () => {
    const token = await createInvite(db, ERIN, tripId);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    await expect(createInvite(db, BOB, tripId)).rejects.toThrow(/Only the organiser or a co-planner/);
    await expect(createInvite(db, ALICE, tripId, 3)).rejects.toThrow(/1, 7 or 30 days/);

    const stored = await db.query<{ n: number }>(
      `select count(*)::int as n from trip_invites where token_hash = $1`,
      [token],
    );
    expect(stored.rows[0].n).toBe(0); // only the hash is stored
  });

  it("planners see the trip's links but never the hash; members see none", async () => {
    const list = await rows<{ use_count: number }>(ERIN, `select id, use_count, expires_at from trip_invites where trip_id = $1`, [tripId]);
    expect(list.length).toBeGreaterThan(0);
    await expect(rows(ERIN, `select token_hash from trip_invites`)).rejects.toThrow(BLOCKED);
    expect(await rows(BOB, `select id from trip_invites`)).toEqual([]);
    await expect(rows(BOB, `delete from trip_invites`)).rejects.toThrow(BLOCKED);
  });

  it("redeeming is idempotent: the second time uses no extra slot", async () => {
    const token = await createInvite(db, ALICE, tripId);
    const userId = "00000000-0000-0000-0000-0000000000f2";
    await db.query(`insert into auth.users (id, email) values ($1, 'fay@example.com')`, [userId]);
    expect((await redeem(db, userId, token, "Fay")).status).toBe("joined");
    expect(await redeem(db, userId, token, "Fay")).toEqual({ status: "already_member", trip_id: tripId });
    const uses = await db.query<{ use_count: number }>(
      `select use_count from trip_invites where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
      [token],
    );
    expect(uses.rows[0].use_count).toBe(1);
  });

  it("expired and revoked links stop working; only planners can revoke", async () => {
    const token = await createInvite(db, ALICE, tripId);
    const hash = `encode(sha256(convert_to('${token}', 'UTF8')), 'hex')`;
    const id = (await db.query<{ id: string }>(`select id from trip_invites where token_hash = ${hash}`)).rows[0].id;

    await expect(rows(BOB, `select revoke_invite($1)`, [id])).rejects.toThrow(/Only the organiser or a co-planner/);
    await asUser(db, ERIN, `select revoke_invite($1)`, [id]);
    await asUser(db, ERIN, `select revoke_invite($1)`, [id]); // retry is harmless
    expect(await redeem(db, CAROL, token)).toEqual({ status: "invalid" });

    const token2 = await createInvite(db, ALICE, tripId);
    await db.query(
      `update trip_invites set created_at = now() - interval '9 days', expires_at = now() - interval '1 day'
        where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
      [token2],
    );
    expect(await redeem(db, CAROL, token2)).toEqual({ status: "invalid" });
    expect(await rows(CAROL, `select id from trips where id = $1`, [tripId])).toEqual([]);
  });

  it("is rate limited: 10 wrong tokens in 15 minutes blocks even a valid one", async () => {
    const good = await createInvite(db, ALICE, tripId);
    await db.query(`delete from invite_attempts where user_id = $1`, [CAROL]);
    for (let i = 0; i < 10; i++) {
      expect((await redeem(db, CAROL, i.toString(16).padStart(64, "a"))).status).toBe("invalid");
    }
    expect(await redeem(db, CAROL, good)).toEqual({ status: "rate_limited" });
    const preview = await rows<{ p: { status: string } }>(CAROL, `select preview_invite($1) as p`, [good]);
    expect(preview[0].p.status).toBe("rate_limited");
    expect(await rows(CAROL, `select id from trips where id = $1`, [tripId])).toEqual([]);

    // Once the window passes, the valid link works.
    await db.query(`update invite_attempts set attempted_at = now() - interval '20 minutes' where user_id = $1`, [CAROL]);
    expect((await redeem(db, CAROL, good)).status).toBe("joined");
  });
});

describe("upgrading an existing database", () => {
  it("links shared before 007 keep working, hashed, for 7 days", async () => {
    const old = await createDb({ stopBefore: "007_foundation.sql" });
    try {
      await old.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${ALICE}', false);`);
      const trip = await old.query<{ id: string; invite_token: string }>(
        `insert into trips (name) values ('Old trip') returning id, invite_token`,
      );
      await old.exec("reset role");
      const { id, invite_token } = trip.rows[0];

      await old.exec(sqlFile("007_foundation.sql"));

      const invite = await old.query<{ expires_in_days: number; created_by: string }>(
        `select round(extract(epoch from expires_at - now()) / 86400)::int as expires_in_days, created_by
           from trip_invites where trip_id = $1`,
        [id],
      );
      expect(invite.rows).toEqual([{ expires_in_days: 7, created_by: ALICE }]);
      const stored = await old.query(`select 1 from trip_invites where token_hash = $1`, [invite_token]);
      expect(stored.rows).toEqual([]); // stored hashed, not as the token

      await old.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${BOB}', false);`);
      const joined = await old.query<{ r: { status: string } }>(`select redeem_invite($1, 'Bob') as r`, [invite_token]);
      await old.exec("reset role");
      expect(joined.rows[0].r.status).toBe("joined");

      // Existing users got profiles.
      const profiles = await old.query<{ n: number }>(`select count(*)::int as n from profiles`);
      expect(profiles.rows[0].n).toBe(4);
    } finally {
      await old.close();
    }
  }, 240_000);
});
