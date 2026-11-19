import { describe, expect, it } from "vitest";
import { formatKm, formatRupees } from "@/lib/format";
import {
  capacityWarning,
  ceilDiv,
  compareStays,
  computeCost,
  nightsBetween,
  type Stay,
} from "@/lib/stay-costs";

const rupees = (r: number) => r * 100; // test helper: rupees -> paise

// A three-room villa that six friends share.
const villa: Stay = {
  id: "villa",
  name: "Villa Sol",
  nightlyPaise: rupees(12_000), // whole villa, all three rooms
  taxesPaise: rupees(5_760),
  feesPaise: rupees(1_500),
  rooms: 3,
  beds: 6,
  distanceCentiKm: 300, // 3 km
  cancellationType: "free",
};

// Cheapest, but the rate cannot be refunded.
const cottage: Stay = {
  id: "cottage",
  name: "Lakeview Cottage",
  nightlyPaise: rupees(9_000),
  taxesPaise: rupees(2_000),
  feesPaise: rupees(1_000),
  rooms: 3,
  beds: 6,
  distanceCentiKm: 500, // 5 km
  cancellationType: "non_refundable",
};

// Closest to the action, most expensive, partly refundable.
const loft: Stay = {
  id: "loft",
  name: "Central Loft",
  nightlyPaise: rupees(14_000),
  taxesPaise: rupees(6_720),
  feesPaise: 0,
  rooms: 3,
  beds: 6,
  distanceCentiKm: 50, // 0.5 km
  cancellationType: "partial",
};

describe("true cost per person", () => {
  it("splits three rooms across six people: (nightly x nights + taxes + fees) / sharers", () => {
    const cost = computeCost(villa, 4, 6);

    expect(cost.roomCostPaise).toBe(4_800_000); // ₹12,000 x 4 nights
    expect(cost.stayTotalPaise).toBe(5_526_000); // + ₹5,760 taxes + ₹1,500 fees
    expect(cost.perPersonPaise).toBe(921_000); // ÷ 6 people = ₹9,210 each
    expect(formatRupees(cost.perPersonPaise)).toBe("₹9,210");

    // Three rooms, six beds: everyone fits, so no capacity warning.
    expect(capacityWarning(villa.beds, 6)).toBeNull();
    // Per-person x people recovers the whole price when it divides evenly.
    expect(cost.perPersonPaise * 6).toBe(cost.stayTotalPaise);
  });

  it("rounds up to the next paise so the group never underpays", () => {
    // ₹10,000.01 split three ways does not divide evenly.
    const cost = computeCost(
      { nightlyPaise: 1_000_001, taxesPaise: 0, feesPaise: 0, distanceCentiKm: null },
      1,
      3,
    );
    expect(cost.perPersonPaise).toBe(333_334);
    expect(cost.perPersonPaise * 3).toBeGreaterThanOrEqual(cost.stayTotalPaise);
    expect(ceilDiv(10, 3)).toBe(4);
    expect(ceilDiv(9, 3)).toBe(3);
  });

  it("prices the non-refundable rate with the same formula", () => {
    const cost = computeCost(cottage, 4, 6);
    // ₹9,000 x 4 = ₹36,000, + ₹2,000 + ₹1,000 = ₹39,000, / 6 = ₹6,500
    expect(cost.stayTotalPaise).toBe(3_900_000);
    expect(cost.perPersonPaise).toBe(650_000);
  });

  it("keeps every figure an integer number of paise", () => {
    for (const stay of [villa, cottage, loft]) {
      const cost = computeCost(stay, 4, 6);
      for (const value of Object.values(cost)) {
        expect(Number.isInteger(value)).toBe(true);
      }
    }
  });

  it("refuses nonsense nights or sharers", () => {
    expect(() => computeCost(villa, 0, 6)).toThrow();
    expect(() => computeCost(villa, 4, 0)).toThrow();
    expect(() => computeCost(villa, 2.5, 6)).toThrow();
  });
});

describe("estimated local transport", () => {
  it("is a rough per-person figure based on distance, days and vehicles", () => {
    // 3 km, there and back daily for 4 nights, 6 people = 2 taxis of 4 seats,
    // at ₹15/km: 3 x 2 x 4 x 15 x 2 = ₹720 total = ₹120 each.
    const cost = computeCost(villa, 4, 6);
    expect(cost.transportTotalPaise).toBe(72_000);
    expect(cost.transportPerPersonPaise).toBe(12_000);
  });

  it("is zero when no distance was given", () => {
    const cost = computeCost({ ...villa, distanceCentiKm: null }, 4, 6);
    expect(cost.transportTotalPaise).toBe(0);
    expect(cost.transportPerPersonPaise).toBe(0);
  });

  it("is smaller for a closer stay", () => {
    const near = computeCost(loft, 4, 6).transportPerPersonPaise;
    const far = computeCost(cottage, 4, 6).transportPerPersonPaise;
    expect(near).toBeLessThan(far);
  });
});

describe("nightsBetween", () => {
  it("counts nights between ISO dates", () => {
    expect(nightsBetween("2026-12-10", "2026-12-14")).toBe(4);
    expect(nightsBetween("2026-12-30", "2027-01-02")).toBe(3);
    expect(nightsBetween("2028-02-27", "2028-03-01")).toBe(3); // leap year
  });
});

describe("comparing stays", () => {
  const compared = compareStays([villa, loft, cottage], 4, 6, formatRupees, formatKm);

  it("sorts cards by true cost per person, cheapest first", () => {
    expect(compared.map((c) => c.stay.name)).toEqual([
      "Lakeview Cottage", // ₹6,500
      "Villa Sol", // ₹9,210
      "Central Loft", // ₹10,453.34
    ]);
    expect(compared.map((c) => c.cost?.perPersonPaise)).toEqual([
      650_000, 921_000, 1_045_334,
    ]);
  });

  it("names the cheapest-but-non-refundable trade-off", () => {
    expect(compared[0].tradeoff).toBe(
      "The cheapest, but it sits 4.5 km farther out than Central Loft and is non-refundable.",
    );
  });

  it("names the most-flexible trade-off", () => {
    expect(compared[1].tradeoff).toBe(
      "The most flexible on cancellation, but it costs ₹2,710 more per person than Lakeview Cottage and sits 2.5 km farther out than Central Loft.",
    );
  });

  it("names the closest trade-off", () => {
    expect(compared[2].tradeoff).toBe(
      "The closest to the main area, but it costs ₹3,953.34 more per person than Lakeview Cottage and is only partly refundable.",
    );
  });

  it("says so when there is nothing to compare against", () => {
    const [only] = compareStays([villa], 4, 6, formatRupees, formatKm);
    expect(only.tradeoff).toMatch(/only stay added/);
  });

  it("says so when stays are identical on everything that matters", () => {
    const twin = { ...villa, id: "twin", name: "Villa Luna" };
    const [a] = compareStays([villa, twin], 4, 6, formatRupees, formatKm);
    expect(a.tradeoff).toBe(
      "It matches the other stays on price, distance and cancellation.",
    );
  });

  it("orders by nightly price and skips cost claims until the trip has dates", () => {
    const undated = compareStays([villa, cottage], null, 6, formatRupees, formatKm);
    expect(undated.map((c) => c.stay.name)).toEqual(["Lakeview Cottage", "Villa Sol"]);
    expect(undated.every((c) => c.cost === null)).toBe(true);
    expect(undated[0].tradeoff).not.toMatch(/per person/);
  });
});

describe("capacity and formatting", () => {
  it("warns when there are fewer beds than people", () => {
    expect(capacityWarning(4, 6)).toBe("Only 4 beds for 6 people.");
    expect(capacityWarning(1, 1)).toBeNull();
  });

  it("formats paise as rupees with Indian digit grouping", () => {
    expect(formatRupees(1_250_000)).toBe("₹12,500");
    expect(formatRupees(995_050)).toBe("₹9,950.50");
    expect(formatRupees(5)).toBe("₹0.05");
    expect(formatRupees(10_000_000)).toBe("₹1,00,000");
    expect(formatKm(250)).toBe("2.5 km");
    expect(formatKm(300)).toBe("3 km");
  });
});
