import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Fixed fake people used across the database tests.
export const ALICE = "00000000-0000-0000-0000-00000000000a"; // organiser
export const BOB = "00000000-0000-0000-0000-00000000000b"; // joins via invite
export const CAROL = "00000000-0000-0000-0000-00000000000c"; // never joins

function sqlFile(name: string): string {
  return readFileSync(join(process.cwd(), "supabase", name), "utf8");
}

/**
 * A throwaway in-memory Postgres with a minimal stand-in for Supabase's
 * `auth` schema (users table, auth.uid(), anon/authenticated roles), then
 * the REAL schema.sql and 002_trip_flow.sql that you paste into Supabase.
 */
export async function createDb(): Promise<PGlite> {
  const db = new PGlite();

  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    insert into auth.users values
      ('${ALICE}', 'alice@example.com'),
      ('${BOB}',   'bob@example.com'),
      ('${CAROL}', 'carol@example.com');
  `);

  await db.exec(sqlFile("schema.sql"));
  await db.exec(sqlFile("002_trip_flow.sql"));
  await db.exec(sqlFile("003_stay_comparison.sql"));
  await db.exec(sqlFile("004_map_locations.sql"));
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
