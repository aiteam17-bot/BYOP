import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/auth-redirect";
import {
  paiseToRupeesString,
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
  it("accepts a full card and returns paise", () => {
    const result = parsePreferences(
      form({
        budget_min: "10000",
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
        budget_min_paise: 1_000_000,
        budget_max_paise: 2_500_000,
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

  it("rejects a maximum below the minimum", () => {
    const result = parsePreferences(
      form({ budget_min: "20000", budget_max: "10000" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.budget_max).toMatch(/at least/);
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

describe("parseTripInput", () => {
  it("requires a name and trims", () => {
    expect(parseTripInput(form({ name: "  Goa  ", destination: " " }))).toEqual({
      ok: true,
      name: "Goa",
      destination: null,
    });
    expect(parseTripInput(form({ name: "  " })).ok).toBe(false);
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
