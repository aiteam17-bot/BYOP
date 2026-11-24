import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/auth-redirect";
import {
  paiseToRupeesString,
  parseBudgetRange,
  parsePreferences,
  parseRupees,
  parseTripInput,
} from "@/lib/validation";

function form(entries: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    for (const v of Array.isArray(value) ? value : [value]) f.append(key, v);
  }
  return f;
}

describe("parseRupees", () => {
  it("converts rupees to integer paise", () => {
    expect(parseRupees("15000")).toEqual({ ok: true, value: 1_500_000 });
    expect(parseRupees("12,500")).toEqual({ ok: true, value: 1_250_000 });
    expect(parseRupees("₹ 99.5")).toEqual({ ok: true, value: 9_950 });
    expect(parseRupees("0.07")).toEqual({ ok: true, value: 7 });
  });

  it("treats empty as not provided", () => {
    expect(parseRupees("  ")).toEqual({ ok: true, value: null });
  });

  it("rejects junk, negatives and absurd amounts", () => {
    for (const bad of ["abc", "-5", "1.234", "1e5", "99999999999"]) {
      expect(parseRupees(bad).ok).toBe(false);
    }
  });

  it("round-trips through paiseToRupeesString", () => {
    expect(paiseToRupeesString(1_500_000)).toBe("15000");
    expect(paiseToRupeesString(9_950)).toBe("99.50");
    expect(paiseToRupeesString(null)).toBe("");
  });
});

describe("parsePreferences", () => {
  it("accepts a full card (budget is no longer part of it)", () => {
    const result = parsePreferences(
      form({
        budget_min: "10000", // ignored: the budget has its own private form
        budget_max: "25,000",
        pace: "balanced",
        interests: ["Beaches", "Food"],
        interests_other: "Scuba diving, Beaches",
        food_notes: "Vegetarian",
        must_see: "Sunset at Chapora",
        avoid: "",
      }),
    );
    expect(result).toEqual({
      ok: true,
      data: {
        pace: "balanced",
        interests: ["Beaches", "Food", "Scuba diving"],
        food_notes: "Vegetarian",
        must_see: "Sunset at Chapora",
        avoid: null,
      },
    });
  });

  it("accepts an empty card", () => {
    const result = parsePreferences(form({}));
    expect(result.ok).toBe(true);
  });


  it("rejects an unknown pace and ignores unknown ticked interests", () => {
    const bad = parsePreferences(form({ pace: "ludicrous" }));
    expect(bad.ok).toBe(false);

    const ok = parsePreferences(form({ interests: ["Beaches", "<script>"] }));
    expect(ok.ok && ok.data.interests).toEqual(["Beaches"]);
  });

  it("rejects over-long free text", () => {
    const result = parsePreferences(form({ must_see: "x".repeat(1001) }));
    expect(result.ok).toBe(false);
  });
});

describe("parseBudgetRange", () => {
  it("returns integer minor units, accepting symbols and commas", () => {
    expect(parseBudgetRange(form({ budget_min: "₹20,000", budget_max: "25000.50" }))).toEqual({
      ok: true,
      min: 2_000_000,
      max: 2_500_050,
    });
  });
  it("requires both amounts, and max >= min", () => {
    expect(parseBudgetRange(form({ budget_min: "20000" })).ok).toBe(false);
    const backwards = parseBudgetRange(form({ budget_min: "20000", budget_max: "10000" }));
    expect(backwards.ok).toBe(false);
    if (!backwards.ok) expect(backwards.errors.budget_max).toMatch(/at least/);
  });
  it("rejects negatives, decimals beyond 2 places and text", () => {
    for (const bad of ["-5", "10.555", "lots", "1e5"]) {
      expect(parseBudgetRange(form({ budget_min: bad, budget_max: "50000" })).ok, bad).toBe(false);
    }
  });
});

describe("parseTripInput", () => {
  const base = { timezone: "Asia/Kolkata", currency: "INR" };
  it("requires a name and trims", () => {
    expect(parseTripInput(form({ name: "  Goa  ", destination: " ", ...base }))).toEqual({
      ok: true,
      name: "Goa",
      destination: null,
      startDate: null,
      endDate: null,
      timezone: "Asia/Kolkata",
      currency: "INR",
    });
    expect(parseTripInput(form({ name: "  ", ...base })).ok).toBe(false);
  });

  it("requires a real time zone and a supported currency", () => {
    expect(parseTripInput(form({ name: "Goa", currency: "INR" })).ok).toBe(false);
    expect(parseTripInput(form({ name: "Goa", timezone: "Mars/Base", currency: "INR" })).ok).toBe(false);
    expect(parseTripInput(form({ name: "Goa", timezone: "IST", currency: "INR" })).ok).toBe(false);
    expect(parseTripInput(form({ name: "Goa", timezone: "Asia/Kolkata", currency: "XYZ" })).ok).toBe(false);
  });

  it("accepts dates only as a valid pair, end after start", () => {
    const ok = parseTripInput(
      form({ name: "Goa", start_date: "2026-12-10", end_date: "2026-12-14", ...base }),
    );
    expect(ok.ok && [ok.startDate, ok.endDate]).toEqual(["2026-12-10", "2026-12-14"]);

    for (const bad of [
      { start_date: "2026-12-10", end_date: "" }, // only one date
      { start_date: "2026-12-14", end_date: "2026-12-10" }, // backwards
      { start_date: "2026-12-10", end_date: "2026-12-10" }, // zero nights
      { start_date: "2026-02-31", end_date: "2026-03-05" }, // not a real day
      { start_date: "2026-01-01", end_date: "2026-06-01" }, // far too long
    ]) {
      expect(parseTripInput(form({ name: "Goa", ...base, ...bad })).ok).toBe(false);
    }
  });
});

describe("safeNextPath (post-login redirect)", () => {
  it("allows same-site paths", () => {
    expect(safeNextPath("/join/abc123")).toBe("/join/abc123");
    expect(safeNextPath("/trips/new?x=1")).toBe("/trips/new?x=1");
  });

  it("blocks anything that could leave the site", () => {
    for (const bad of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "",
      null,
      undefined,
      "/ok\nSet-Cookie: x=1",
    ]) {
      expect(safeNextPath(bad)).toBeNull();
    }
  });
});
