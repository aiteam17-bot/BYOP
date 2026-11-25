// Error codes our database functions raise on purpose. Their messages are
// written for people and safe to show.
//
// STALE: someone else changed the row first (optimistic version check).
// Never use 40001 (serialization_failure) for this: PostgREST retries 40001
// automatically, and a stale version never becomes fresh, so the request
// would retry forever. See supabase/012_stale_errcode.sql.
export const STALE_CODE = "VS409";

export const SAFE_CODES: ReadonlySet<string> = new Set(["42501", "22023", "P0002", STALE_CODE]);

/** SQLSTATEs PostgREST retries automatically; our functions must never raise these on purpose. */
export const RETRIED_BY_POSTGREST: readonly string[] = ["40001", "40P01"];
