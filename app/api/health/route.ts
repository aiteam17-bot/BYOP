import { connection } from "next/server";

// Health check: GET /api/health -> {"status":"ok"}
// connection() makes this run on every request instead of being prerendered
// at build time, so it proves the server is actually responding.
export async function GET() {
  await connection();
  return Response.json(
    { status: "ok" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
