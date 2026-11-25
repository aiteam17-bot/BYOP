import { describe, expect, it } from "vitest";
import { opFromForm, parseOps, previewOps } from "@/lib/concierge";
import type { Stop } from "@/lib/itinerary";

const ID = "8d8b6c0e-7d0e-4b8e-9d55-2b1f0c3a9e11";
const ID2 = "1d8b6c0e-7d0e-4b8e-9d55-2b1f0c3a9e12";
const stop = (id: string, day: number, time: string, title: string, version = 1): Stop => ({
  id, day, time, duration: 60, title, placeUrl: null, lat: null, lng: null, costMinor: null, notes: null, createdBy: null, version,
});

describe("parseOps", () => {
  it("accepts the three allowed operations", () => {
    const r = parseOps(
      [
        { op: "add_stop", day: 1, time: "09:00", duration: 30, title: " Run " },
        { op: "add_stop", day: 2, time: "10:00", suggestion_id: ID },
        { op: "move_stop", item_id: ID, expected_version: 2, day: 3, time: "11:00" },
        { op: "remove_stop", item_id: ID2, expected_version: 1 },
      ],
      4,
    );
    expect(r.ok && r.ops[0]).toEqual({ op: "add_stop", day: 1, time: "09:00", duration: 30, title: "Run" });
    expect(r.ok && r.ops.length).toBe(4);
  });
  it("rejects malformed, unknown or unbounded patches", () => {
    const bad: unknown[] = [
      null, {}, [], "[]",
      Array.from({ length: 11 }, () => ({ op: "remove_stop", item_id: ID, expected_version: 1 })),
      [{ op: "run_sql", sql: "drop table trips" }],
      [{ op: "add_stop", day: 1, time: "09:00", duration: 30, title: "x", url: "https://evil.example" }],
      [{ op: "add_stop", day: 9, time: "09:00", duration: 30, title: "x" }],
      [{ op: "add_stop", day: 1, time: "25:00", duration: 30, title: "x" }],
      [{ op: "add_stop", day: 1, time: "09:00", title: "x" }],
      [{ op: "add_stop", day: 1, time: "09:00", suggestion_id: ID, title: "x" }],
      [{ op: "move_stop", item_id: "abc", expected_version: 1, day: 1, time: "09:00" }],
      [{ op: "remove_stop", item_id: ID }],
      [{ op: "add_stop", day: 1.5, time: "09:00", duration: 30, title: "x" }],
    ];
    for (const b of bad) expect(parseOps(b, 4).ok, JSON.stringify(b)).toBe(false);
  });
});

describe("opFromForm", () => {
  const form = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };
  it("builds only the fields for the chosen operation", () => {
    expect(opFromForm(form({ op: "move_stop", stop: `${ID}:3`, day: "2", time: "10:00", suggestion_id: ID2 }))).toEqual({
      op: "move_stop", item_id: ID, expected_version: 3, day: 2, time: "10:00",
    });
    expect(opFromForm(form({ op: "remove_stop", stop: `${ID}:3`, day: "2", time: "10:00" }))).toEqual({ op: "remove_stop", item_id: ID, expected_version: 3 });
    expect(opFromForm(form({ op: "add_idea", suggestion_id: ID2, day: "1", time: "08:00" }))).toEqual({ op: "add_stop", day: 1, time: "08:00", suggestion_id: ID2 });
    expect(parseOps([opFromForm(form({ op: "move_stop", stop: "", day: "1", time: "08:00" }))], 4).ok).toBe(false);
  });
});

describe("previewOps", () => {
  const current = [stop(ID, 1, "10:00", "Beach"), stop(ID2, 2, "09:00", "Market", 4)];
  it("shows before and after for every day touched", () => {
    const pv = previewOps(
      [
        { op: "move_stop", item_id: ID, expected_version: 1, day: 2, time: "15:00" },
        { op: "add_stop", day: 2, time: "12:00", suggestion_id: "idea" },
      ],
      current,
      [{ id: "idea", name: "Fort", minutes: 90, priceMinor: 5000, placeUrl: "https://x.org" }],
    );
    expect(pv.problems).toEqual([]);
    expect(pv.days.map((d) => [d.day, d.before.map((s) => s.title), d.after.map((s) => s.title)])).toEqual([
      [1, ["Beach"], []],
      [2, ["Market"], ["Market", "Fort", "Beach"]],
    ]);
    expect(pv.lines[0]).toBe('Move "Beach" from day 1 10:00 to day 2 15:00.');
  });
  it("flags stale versions and missing stops or ideas", () => {
    const pv = previewOps(
      [
        { op: "remove_stop", item_id: ID2, expected_version: 3 },
        { op: "remove_stop", item_id: "1d8b6c0e-0000-4b8e-9d55-2b1f0c3a9e12", expected_version: 1 },
        { op: "add_stop", day: 1, time: "08:00", suggestion_id: "gone" },
      ],
      current,
      [],
    );
    expect(pv.problems).toEqual([
      '"Market" changed since this was proposed.',
      "A stop in this proposal no longer exists.",
      "An idea in this proposal is no longer confirmed.",
    ]);
  });
});
