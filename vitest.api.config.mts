import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Authenticated API tests against a SEPARATE test Supabase project, never
// production. Reads TEST_SUPABASE_URL and TEST_SUPABASE_PUBLISHABLE_KEY from
// .env.test.local (git-ignored). Run with: npm run test:api
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests-api/**/*.test.ts"],
    env: loadEnv("test", process.cwd(), "TEST_SUPABASE_"),
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
