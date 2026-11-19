import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Separate config so `npm test` never touches your real Supabase project.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests-live/**/*.test.ts"],
    // Read the two NEXT_PUBLIC_ values from .env.local.
    env: loadEnv("", process.cwd(), "NEXT_PUBLIC_"),
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
