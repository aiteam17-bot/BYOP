// Regression: "Route /account (and /trips, /trips/[id]/stays): Next.js
// encountered the unstable value Date.now() while prerendering". supabase-js
// reads Date.now() to check session expiry, so the server client must wait
// for connection() BEFORE the Supabase client is created or used.
import { afterEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];

vi.mock("next/headers", () => ({
  cookies: async () => {
    calls.push("cookies");
    return { getAll: () => [], set: () => {} };
  },
}));
vi.mock("next/server", () => ({
  connection: async () => {
    calls.push("connection");
  },
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => {
    calls.push("createServerClient");
    return {};
  },
}));

afterEach(() => {
  calls.length = 0;
  vi.unstubAllEnvs();
});

describe("lib/supabase/server createClient", () => {
  it("awaits connection() before creating the Supabase client", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    vi.resetModules();
    const { createClient } = await import("@/lib/supabase/server");
    await createClient();
    expect(calls).toEqual(["cookies", "connection", "createServerClient"]);
  });
});
