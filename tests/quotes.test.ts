import { describe, expect, it } from "vitest";
import {
  compareQuotes,
  convertMinor,
  inTripCurrency,
  parseRateMicros,
  quoteTotal,
  quotedTotalMinor,
  splitExactly,
  type Quote,
} from "@/lib/quotes";

const q = (over: Partial<Quote>): Quote => ({
  id: "q",
  name: "Villa",
  pricingBasis: "entire_stay_total",
  currency: "INR",
  quotedAmountMinor: 3_600_000,
  nights: 3,
  rooms: 2,
  taxesMinor: 0,
  feesMinor: 0,
  sharers: 5,
  fxRateMicros: null,
  fxRateDate: null,
  fxSource: null,
  transportEstimatePerPersonMinor: null,
  ...over,
});

describe("quoted total by pricing basis", () => {
  it("a total for the stay is never multiplied again", () => {
    expect(quotedTotalMinor(q({ pricingBasis: "entire_stay_total", quotedAmountMinor: 3_600_000, rooms: 2, nights: 3 }))).toBe(3_600_000);
  });
  it("per room per night multiplies by rooms and nights once", () => {
    expect(quotedTotalMinor(q({ pricingBasis: "per_room_per_night", quotedAmountMinor: 600_000, rooms: 2, nights: 3 }))).toBe(3_600_000);
  });
});

describe("taxes and fees", () => {
  it("known amounts are added", () => {
    expect(quoteTotal(q({ taxesMinor: 432_000, feesMinor: 150_000 }))).toEqual({ amountMinor: 4_182_000, unknown: [] });
  });
  it("unknown is reported, never treated as zero silently", () => {
    expect(quoteTotal(q({ taxesMinor: null, feesMinor: 150_000 }))).toEqual({ amountMinor: 3_750_000, unknown: ["taxes"] });
    expect(quoteTotal(q({ taxesMinor: null, feesMinor: null })).unknown).toEqual(["taxes", "fees"]);
  });
});

describe("per-person split reconciles exactly", () => {
  it("shares add up to the total; the remainder goes one paisa at a time", () => {
    const s = splitExactly(1_000_001, 3);
    expect(s).toEqual({ baseMinor: 333_333, extraCount: 2, shares: [333_334, 333_334, 333_333] });
    expect(s.shares.reduce((a, b) => a + b, 0)).toBe(1_000_001);
  });
  it("holds for many totals and group sizes", () => {
    for (let total = 0; total < 5000; total += 37) {
      for (let n = 1; n <= 12; n++) {
        const s = splitExactly(total, n);
        expect(s.shares.reduce((a, b) => a + b, 0)).toBe(total);
        expect(Math.max(...s.shares) - Math.min(...s.shares)).toBeLessThanOrEqual(1);
      }
    }
  });
  it("rejects fractions and zero sharers", () => {
    expect(() => splitExactly(10.5, 2)).toThrow();
    expect(() => splitExactly(10, 0)).toThrow();
  });
});

describe("currencies", () => {
  it("another currency is not compared without a recorded rate", () => {
    expect(inTripCurrency(10_000, q({ currency: "USD" }), "INR")).toEqual({ ok: false, reason: "needs_rate" });
  });
  it("converts with the recorded rate, rounding half up in integer maths", () => {
    // $420.00 at 83.125 INR per USD = ₹34,912.50
    const usd = q({ currency: "USD", fxRateMicros: 83_125_000, fxRateDate: "2026-11-20", fxSource: "RBI reference rate" });
    expect(inTripCurrency(42_000, usd, "INR")).toEqual({ ok: true, amountMinor: 3_491_250, converted: true });
    expect(convertMinor(1, 1_500_000)).toBe(2); // 1.5 rounds up
    expect(convertMinor(1, 1_499_999)).toBe(1);
  });
  it("parses rates exactly", () => {
    expect(parseRateMicros("83.12")).toBe(83_120_000);
    expect(parseRateMicros("0.012345")).toBe(12_345);
    for (const bad of ["", "-1", "1e3", "1.1234567", "0"]) expect(parseRateMicros(bad), bad).toBeNull();
  });
});

describe("compareQuotes", () => {
  it("ranks by per-person cost in trip currency; unrated currencies come last, unranked", () => {
    const cheap = q({ id: "a", name: "Cheap", quotedAmountMinor: 2_000_000, sharers: 4 });
    const pricey = q({ id: "b", name: "Pricey", pricingBasis: "per_room_per_night", quotedAmountMinor: 1_000_000, rooms: 1, nights: 3, sharers: 2 });
    const usd = q({ id: "c", name: "Dollar", currency: "USD", quotedAmountMinor: 10_000 });
    const out = compareQuotes([usd, pricey, cheap], "INR", 3);
    expect(out.map((r) => r.quote.id)).toEqual(["a", "b", "c"]);
    expect(out[0].perPerson?.baseMinor).toBe(500_000);
    expect(out[1].perPerson?.baseMinor).toBe(1_500_000);
    expect(out[2].perPerson).toBeNull();
  });
  it("flags quotes whose nights differ from the trip", () => {
    expect(compareQuotes([q({ nights: 2 })], "INR", 3)[0].nightsMismatch).toBe(true);
    expect(compareQuotes([q({ nights: 2 })], "INR", null)[0].nightsMismatch).toBe(false);
  });
  it("transport estimate is never part of the quote total", () => {
    const r = compareQuotes([q({ transportEstimatePerPersonMinor: 99_999 })], "INR", 3)[0];
    expect(r.tripTotalMinor).toBe(3_600_000);
  });
});
