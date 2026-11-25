import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Fixed fake people used across the database tests.
export const ALICE = "00000000-0000-0000-0000-00000000000a"; // organiser
export const BOB = "00000000-0000-0000-0000-00000000000b"; // joins via invite
export const CAROL = "00000000-0000-0000-0000-00000000000c"; // never joins
export const ERIN = "00000000-0000-0000-0000-00000000000e"; // joins, becomes co-planner

/** Every migration, in the order they are applied in Supabase. */
export const MIGRATIONS = [
  "schema.sql",
  "002_trip_flow.sql",
  "003_stay_comparison.sql",
  "004_map_locations.sql",
  "005_grants.sql",
  "006_decide.sql",
  "007_foundation.sql",
  "008_budget_privacy.sql",
  "009_itinerary.sql",
  "010_places_quotes.sql",
];

export function sqlFile(name: string): string {
  return readFileSync(join(process.cwd(), "supabase", name), "utf8");
}

/**
 * A throwaway in-memory Postgres with a minimal stand-in for Supabase's
 * `auth` schema (users table, auth.uid(), anon/authenticated roles), then
 * the REAL schema.sql and 002_trip_flow.sql that you paste into Supabase.
 */
export async function createDb(options: { stopBefore?: string } = {}): Promise<PGlite> {
  const db = new PGlite();

  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    -- Like a NEW Supabase project: tables created in the SQL editor are NOT
    -- automatically readable by signed-in users, so 005_grants.sql must do it.
    insert into auth.users values
      ('${ALICE}', 'alice@example.com'),
      ('${BOB}',   'bob@example.com'),
      ('${CAROL}', 'carol@example.com'),
      ('${ERIN}',  'erin@example.com');
  `);

  for (const file of MIGRATIONS) {
    if (file === options.stopBefore) break;
    await db.exec(sqlFile(file));
  }
  return db;
}

/**
 * Run one query exactly as Supabase would for a signed-in user (or, with
 * null, a signed-out visitor): same database role, same auth.uid().
 */
export async function asUser<T = Record<string, unknown>>(
  db: PGlite,
  userId: string | null,
  sql: string,
  params: unknown[] = [],
) {
  await db.exec(`set role ${userId ? "authenticated" : "anon"}`);
  try {
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [
      userId ?? "",
    ]);
    return await db.query<T>(sql, params);
  } finally {
    await db.exec("reset role");
  }
}

/** The organiser (or a co-planner) makes an invite link; returns the token. */
export async function createInvite(db: PGlite, userId: string, tripId: string, days = 7): Promise<string> {
  const res = await asUser<{ invite: { token: string } }>(
    db,
    userId,
    `select create_invite($1, $2) as invite`,
    [tripId, days],
  );
  return res.rows[0].invite.token;
}

/** Redeems an invite token as this user; returns the function's JSON result. */
export async function redeem(
  db: PGlite,
  userId: string,
  token: string,
  name: string | null = null,
): Promise<{ status: string; trip_id?: string }> {
  const res = await asUser<{ r: { status: string; trip_id?: string } }>(
    db,
    userId,
    `select redeem_invite($1, $2) as r`,
    [token, name],
  );
  return res.rows[0].r;
}

/** Shortcut for test setup: the organiser invites, the friend joins. */
export async function inviteAndJoin(db: PGlite, ownerId: string, tripId: string, userId: string, name: string) {
  const token = await createInvite(db, ownerId, tripId);
  const result = await redeem(db, userId, token, name);
  if (result.status !== "joined" && result.status !== "already_member") {
    throw new Error(`join failed: ${result.status}`);
  }
}
