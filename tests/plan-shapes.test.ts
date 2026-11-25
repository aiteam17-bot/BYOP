import { describe, expect, it } from "vitest";
import { buildShape, chooseStays, staleReasons, tierTarget, type SavedShape, type ShapeInputs } from "@/lib/plan-shapes";
import type { Quote } from "@/lib/quotes";

const q = (id: string, over: Partial<Quote> = {}): Quote & { version: number } => ({
  id, name: id, pricingBasis: "entire_stay_total", currency: "INR", quotedAmountMinor: 900000, nights: 3, rooms: 1,
  taxesMinor: 0, feesMinor: 0, sharers: 3, fxRateMicros: null, fxRateDate: null, fxSource: null,
  transportEstimatePerPersonMinor: null, version: 1, ...over,
});

const base = (over: Partial<ShapeInputs> = {}): ShapeInputs => ({
  currency: "INR",
  startDate: "2027-02-05",
  endDate: "2027-02-08",
  bounds: { min: 2_000_000, max: 4_000_000, setAt: "2026-11-01T00:00:00Z" },
  quotes: [q("mid", { quotedAmountMinor: 1_800_000 }), q("cheap"), q("dear", { quotedAmountMinor: 2_700_000 })],
  categories: [
    { id: "c1", version: 1, kind: "flights", label: "Flights", plannedPerPersonMinor: 800_000 },
    { id: "c2", version: 1, kind: "food", label: "Food", plannedPerPersonMinor: 300_000 },
  ],
  stopCostsMinor: [50_000, 25_000],
  ...over,
});

describe("chooseStays", () => {
  it("cheapest, lower-middle and dearest comparable quote per person", () => {
    expect(chooseStays(base())).toEqual({ tight: "cheap", balanced: "mid", splurge: "dear" });
  });
  it("skips quotes in another currency without a rate, and is empty with none", () => {
    const usd = q("usd", { currency: "USD", quotedAmountMinor: 1 });
    expect(chooseStays(base({ quotes: [usd, q("only")] }))).toEqual({ tight: "only", balanced: "only", splurge: "only" });
    expect(chooseStays(base({ quotes: [usd] }))).toEqual({ tight: null, balanced: null, splurge: null });
  });
  it("never multiplies a total again: per room per night vs total compare on the same basis", () => {
    const perNight = q("pn", { pricingBasis: "per_room_per_night", quotedAmountMinor: 300_000, rooms: 1, nights: 3 }); // 9,000 total
    const total = q("tot", { quotedAmountMinor: 1_000_000 }); // 10,000 total
    expect(chooseStays(base({ quotes: [total, perNight] })).tight).toBe("pn");
  });
});

describe("buildShape", () => {
  it("adds stay share, categories and stop costs in integer minor units", () => {
    const s = buildShape("tight", "cheap", base());
    // stay 9,000.00 / 3 = 3,000.00; flights 8,000; food 3,000; stops 750
    expect(s.stayPerPersonMinor).toBe(300_000);
    expect(s.knownTotalMinor).toBe(300_000 + 800_000 + 300_000 + 75_000);
    expect(s.targetMinor).toBe(2_000_000);
    expect(s.verdict).toBe("within");
    expect(s.headroomMinor).toBe(2_000_000 - 1_475_000);
    expect(s.missing).toEqual([]);
  });
  it("rounds the stay share up to the most anyone pays", () => {
    const s = buildShape("tight", "odd", base({ quotes: [q("odd", { quotedAmountMinor: 1_000_001 })] }));
    expect(s.stayPerPersonMinor).toBe(333_334);
  });
  it("targets come only from confirmed bounds", () => {
    const b = { min: 1001, max: 2000, setAt: null };
    expect([tierTarget("tight", b), tierTarget("balanced", b), tierTarget("splurge", b)]).toEqual([1001, 1500, 2000]);
    expect(tierTarget("balanced", null)).toBeNull();
  });
  it("makes missing information visible instead of filling it in", () => {
    const s = buildShape(
      "balanced",
      "t",
      base({
        startDate: null,
        endDate: null,
        bounds: null,
        quotes: [q("t", { taxesMinor: null }), q("usd", { currency: "USD" })],
        categories: [{ id: "c", version: 1, kind: "food", label: "Food", plannedPerPersonMinor: null }],
        stopCostsMinor: [],
      }),
    );
    expect(s.verdict).toBe("unknown");
    expect(s.incomplete).toBe(true);
    expect(s.missing.join(" | ")).toMatch(/no dates/);
    expect(s.missing.join(" | ")).toMatch(/No planning bounds/);
    expect(s.missing.join(" | ")).toMatch(/another currency/);
    expect(s.missing.join(" | ")).toMatch(/taxes unknown/);
    expect(s.missing.join(" | ")).toMatch(/Food has no planned amount/);
    expect(s.missing.join(" | ")).toMatch(/No flights category/);
    expect(s.lines.find((l) => l.label === "Food")?.perPersonMinor).toBeNull();
  });
  it("says 'over' only from known amounts", () => {
    const s = buildShape("tight", "dear", base({ bounds: { min: 100_000, max: 200_000, setAt: null } }));
    expect(s.verdict).toBe("over");
    expect(s.headroomMinor).toBeLessThan(0);
  });
});

describe("staleReasons", () => {
  const saved = (over: Partial<SavedShape> = {}): SavedShape => ({
    id: "s", generation: 1, tier: "tight", stayQuoteId: "cheap", stayQuoteVersion: 1, startDate: "2027-02-05", endDate: "2027-02-08",
    boundsMin: 2_000_000, boundsMax: 4_000_000, boundsSetAt: null, categories: [{ id: "c1", version: 1 }, { id: "c2", version: 1 }],
    chosenAt: null, ...over,
  });
  it("is empty when nothing changed", () => {
    expect(staleReasons(saved(), base())).toEqual([]);
  });
  it("names what changed", () => {
    expect(staleReasons(saved({ endDate: "2027-02-09" }), base())).toEqual(["the trip dates changed"]);
    expect(staleReasons(saved({ boundsMax: 1 }), base())).toEqual(["the planning bounds changed"]);
    expect(staleReasons(saved({ stayQuoteVersion: 0 }), base())).toEqual(["its stay quote was edited"]);
    expect(staleReasons(saved({ stayQuoteId: "gone" }), base())).toContain("its stay quote was deleted");
    expect(staleReasons(saved({ categories: [{ id: "c1", version: 1 }] }), base())).toEqual(["budget categories changed"]);
    expect(staleReasons(saved(), base({ quotes: [...base().quotes, q("cheaper", { quotedAmountMinor: 3 })] }))).toEqual([
      "the saved stay quotes changed",
    ]);
  });
});
