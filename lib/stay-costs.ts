// The maths behind the stay comparison page.
//
// EVERY money value here is an integer number of paise (1 rupee = 100 paise).
// Nothing is ever converted to a decimal rupee amount for calculation, so there
// is no floating-point rounding drift. Division always rounds UP to the next
// paise, so the group's shares add up to at least the real price.

export type Cancellation = "free" | "partial" | "non_refundable" | "unknown";

export const CANCELLATION_LABELS: Record<Cancellation, string> = {
  free: "Free cancellation",
  partial: "Partly refundable",
  non_refundable: "Non-refundable",
  unknown: "Cancellation not stated",
};

// How flexible each type is. "unknown" is not comparable, so it has no rank.
const FLEXIBILITY_RANK: Record<Cancellation, number | null> = {
  free: 3,
  partial: 2,
  non_refundable: 1,
  unknown: null,
};

export type Stay = {
  id: string;
  name: string;
  nightlyPaise: number; // price per night for the WHOLE stay (all rooms)
  taxesPaise: number; // total taxes for the whole stay
  feesPaise: number; // total fees for the whole stay (cleaning, service...)
  rooms: number;
  beds: number;
  distanceCentiKm: number | null; // hundredths of a km from the main area
  cancellationType: Cancellation;
};

// --- Local transport estimate (a rough guide, not a quote) ------------------
// Assumes one round trip a day to the main area by taxi or auto, at a flat
// rate per km, with each vehicle carrying up to 4 people.
export const TRANSPORT_PAISE_PER_KM = 1500; // ₹15 per km per vehicle
export const TRANSPORT_SEATS_PER_VEHICLE = 4;
export const TRANSPORT_TRIPS_PER_DAY = 2; // out and back

/** Whole-number division that rounds up: ceilDiv(10, 3) === 4. */
export function ceilDiv(numerator: number, denominator: number): number {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new Error("ceilDiv needs whole numbers (paise)");
  }
  if (denominator <= 0) throw new Error("ceilDiv needs a positive divisor");
  return Math.ceil(numerator / denominator);
}

/** Nights between two ISO dates ("2026-12-10" -> "2026-12-14" = 4). */
export function nightsBetween(startIso: string, endIso: string): number {
  const toDays = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d) / 86_400_000;
  };
  return Math.round(toDays(endIso) - toDays(startIso));
}

export type CostBreakdown = {
  nights: number;
  sharers: number;
  roomCostPaise: number; // nightly price x nights
  stayTotalPaise: number; // + taxes + fees
  perPersonPaise: number; // true cost per person, rounded up
  transportTotalPaise: number;
  transportPerPersonPaise: number;
};

export function computeCost(
  stay: Pick<
    Stay,
    "nightlyPaise" | "taxesPaise" | "feesPaise" | "distanceCentiKm"
  >,
  nights: number,
  sharers: number,
): CostBreakdown {
  if (!Number.isInteger(nights) || nights < 1) {
    throw new Error("nights must be a whole number of at least 1");
  }
  if (!Number.isInteger(sharers) || sharers < 1) {
    throw new Error("sharers must be a whole number of at least 1");
  }

  const roomCostPaise = stay.nightlyPaise * nights;
  const stayTotalPaise = roomCostPaise + stay.taxesPaise + stay.feesPaise;
  const perPersonPaise = ceilDiv(stayTotalPaise, sharers);

  let transportTotalPaise = 0;
  if (stay.distanceCentiKm !== null && stay.distanceCentiKm > 0) {
    const vehicles = ceilDiv(sharers, TRANSPORT_SEATS_PER_VEHICLE);
    // centi-km x trips x nights x paise/km x vehicles, then / 100 to get paise.
    transportTotalPaise = ceilDiv(
      stay.distanceCentiKm *
        TRANSPORT_TRIPS_PER_DAY *
        nights *
        TRANSPORT_PAISE_PER_KM *
        vehicles,
      100,
    );
  }
  const transportPerPersonPaise = ceilDiv(transportTotalPaise, sharers);

  return {
    nights,
    sharers,
    roomCostPaise,
    stayTotalPaise,
    perPersonPaise,
    transportTotalPaise,
    transportPerPersonPaise,
  };
}

// --- Comparing stays and naming the trade-off ---------------------------------

export type ComparedStay = {
  stay: Stay;
  cost: CostBreakdown | null; // null until the trip has dates
  tradeoff: string;
};

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * One plain sentence naming how this stay trades off against the others, for
 * example "The cheapest, but it sits 2.5 km farther out than Beach Hut and is
 * non-refundable."
 */
export function describeTradeoff(
  entry: { stay: Stay; cost: CostBreakdown | null },
  all: Array<{ stay: Stay; cost: CostBreakdown | null }>,
  formatMoney: (paise: number) => string,
  formatDistance: (centiKm: number) => string,
): string {
  if (all.length < 2) {
    return "This is the only stay added so far, so there is nothing to trade off yet.";
  }

  const strengths: string[] = [];
  const weaknesses: string[] = [];

  // Price: only meaningful once the trip has dates.
  const priced = all.filter((a) => a.cost !== null);
  if (entry.cost && priced.length >= 2) {
    const best = priced.reduce((a, b) =>
      b.cost!.perPersonPaise < a.cost!.perPersonPaise ? b : a,
    );
    const worst = Math.max(...priced.map((p) => p.cost!.perPersonPaise));
    const bestPaise = best.cost!.perPersonPaise;
    if (worst !== bestPaise) {
      if (entry.cost.perPersonPaise === bestPaise) {
        strengths.push("the cheapest");
      } else {
        weaknesses.push(
          `costs ${formatMoney(entry.cost.perPersonPaise - bestPaise)} more per person than ${best.stay.name}`,
        );
      }
    }
  }

  // Distance: only stays that state one.
  const withDistance = all.filter((a) => a.stay.distanceCentiKm !== null);
  if (entry.stay.distanceCentiKm !== null && withDistance.length >= 2) {
    const closest = withDistance.reduce((a, b) =>
      b.stay.distanceCentiKm! < a.stay.distanceCentiKm! ? b : a,
    );
    const nearest = closest.stay.distanceCentiKm!;
    const farthest = Math.max(...withDistance.map((d) => d.stay.distanceCentiKm!));
    if (farthest !== nearest) {
      if (entry.stay.distanceCentiKm === nearest) {
        strengths.push("the closest to the main area");
      } else {
        weaknesses.push(
          `sits ${formatDistance(entry.stay.distanceCentiKm - nearest)} farther out than ${closest.stay.name}`,
        );
      }
    }
  }

  // Cancellation: only stays that state their terms.
  const ranked = all.filter((a) => FLEXIBILITY_RANK[a.stay.cancellationType] !== null);
  const myRank = FLEXIBILITY_RANK[entry.stay.cancellationType];
  if (myRank !== null && ranked.length >= 2) {
    const ranks = ranked.map((r) => FLEXIBILITY_RANK[r.stay.cancellationType]!);
    const bestRank = Math.max(...ranks);
    if (bestRank !== Math.min(...ranks)) {
      if (myRank === bestRank) {
        strengths.push("the most flexible on cancellation");
      } else if (entry.stay.cancellationType === "non_refundable") {
        weaknesses.push("is non-refundable");
      } else {
        weaknesses.push("is only partly refundable");
      }
    }
  }

  const topWeaknesses = weaknesses.slice(0, 2);

  if (strengths.length > 0 && topWeaknesses.length > 0) {
    return `${capitalise(joinAnd(strengths))}, but it ${joinAnd(topWeaknesses)}.`;
  }
  if (strengths.length > 0) {
    return `${capitalise(joinAnd(strengths))}, with no trade-off against the other stays.`;
  }
  if (topWeaknesses.length > 0) {
    return `It ${joinAnd(topWeaknesses)}, with no standout strength.`;
  }
  return "It matches the other stays on price, distance and cancellation.";
}

/**
 * Cards in the order they should be shown: cheapest true cost per person
 * first. Before the trip has dates there is no true cost, so stays are ordered
 * by nightly price instead.
 */
export function compareStays(
  stays: Stay[],
  nights: number | null,
  sharers: number,
  formatMoney: (paise: number) => string,
  formatDistance: (centiKm: number) => string,
): ComparedStay[] {
  const withCost = stays.map((stay) => ({
    stay,
    cost: nights !== null ? computeCost(stay, nights, sharers) : null,
  }));

  const sorted = [...withCost].sort((a, b) => {
    const byCost =
      a.cost && b.cost
        ? a.cost.perPersonPaise - b.cost.perPersonPaise
        : a.stay.nightlyPaise - b.stay.nightlyPaise;
    if (byCost !== 0) return byCost;
    // Ties: nearer first, then alphabetical, so the order is stable.
    const da = a.stay.distanceCentiKm ?? Number.MAX_SAFE_INTEGER;
    const db = b.stay.distanceCentiKm ?? Number.MAX_SAFE_INTEGER;
    if (da !== db) return da - db;
    return a.stay.name.localeCompare(b.stay.name);
  });

  return sorted.map((entry) => ({
    ...entry,
    tradeoff: describeTradeoff(entry, sorted, formatMoney, formatDistance),
  }));
}

/** A plain warning when the beds cannot fit everyone, otherwise null. */
export function capacityWarning(beds: number, sharers: number): string | null {
  if (beds >= sharers) return null;
  return `Only ${beds} ${beds === 1 ? "bed" : "beds"} for ${sharers} ${sharers === 1 ? "person" : "people"}.`;
}
