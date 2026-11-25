// Tight / Balanced / Splurge (PRD 04), built only from what the group saved:
// the chosen trip dates, the planning bounds the group confirmed out loud,
// stay quotes and budget categories. Deterministic integer maths; no model,
// no invented prices. Whatever is missing is listed, never filled in.
import { compareQuotes, type ComparedQuote, type Quote } from "@/lib/quotes";

export const TIERS = ["tight", "balanced", "splurge"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LABELS: Record<Tier, string> = {
  tight: "Tight",
  balanced: "Balanced",
  splurge: "Splurge",
};

export type CategoryInput = {
  id: string;
  version: number;
  kind: string;
  label: string;
  plannedPerPersonMinor: number | null;
};

export type ShapeInputs = {
  currency: string;
  startDate: string | null;
  endDate: string | null;
  /** Group-confirmed planning bounds (per person, whole trip), or null. */
  bounds: { min: number; max: number; setAt: string | null } | null;
  quotes: (Quote & { version: number })[];
  categories: CategoryInput[];
  /** Member-entered per-person costs of stops in the main plan. */
  stopCostsMinor: number[];
};

export function tripNights(startDate: string | null, endDate: string | null): number | null {
  if (!startDate || !endDate) return null;
  const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000);
  return days >= 1 ? days : null;
}

/** Quotes that can be ranked per person in the trip currency, cheapest first. */
export function comparableQuotes(inputs: ShapeInputs): ComparedQuote[] {
  return compareQuotes(inputs.quotes, inputs.currency, tripNights(inputs.startDate, inputs.endDate)).filter(
    (c) => c.perPerson !== null,
  );
}

/** Which quote each tier uses: cheapest, middle (lower middle), dearest. */
export function chooseStays(inputs: ShapeInputs): Record<Tier, string | null> {
  const c = comparableQuotes(inputs);
  if (c.length === 0) return { tight: null, balanced: null, splurge: null };
  return {
    tight: c[0].quote.id,
    balanced: c[Math.floor((c.length - 1) / 2)].quote.id,
    splurge: c[c.length - 1].quote.id,
  };
}

/** The target per person for a tier, from the confirmed bounds only. */
export function tierTarget(tier: Tier, bounds: ShapeInputs["bounds"]): number | null {
  if (!bounds) return null;
  if (tier === "tight") return bounds.min;
  if (tier === "splurge") return bounds.max;
  return Math.floor((bounds.min + bounds.max) / 2);
}

export type ShapeLine = { label: string; perPersonMinor: number | null; note?: string };

export type Shape = {
  tier: Tier;
  targetMinor: number | null;
  stay: ComparedQuote | null;
  /** The most anyone pays for the stay: base share, +1 minor unit if the split has a remainder. */
  stayPerPersonMinor: number | null;
  lines: ShapeLine[];
  /** Sum of everything with a known amount. */
  knownTotalMinor: number;
  /** "within" / "over" the target, or "unknown" when there is no target or nothing to compare. */
  verdict: "within" | "over" | "unknown";
  /** target - known total (negative = over). null without a target. */
  headroomMinor: number | null;
  /** True when the known total is a floor (something has no amount yet). */
  incomplete: boolean;
  missing: string[];
};

export function buildShape(tier: Tier, stayQuoteId: string | null, inputs: ShapeInputs): Shape {
  const missing: string[] = [];
  const nights = tripNights(inputs.startDate, inputs.endDate);
  if (nights === null) missing.push("The trip has no dates yet, so nights and stay prices cannot be checked against them.");
  if (!inputs.bounds) missing.push("No planning bounds confirmed by the group yet, so there is no target to plan within.");

  const comparable = comparableQuotes(inputs);
  const uncomparable = inputs.quotes.length - comparable.length;
  if (uncomparable > 0) {
    missing.push(`${uncomparable} stay quote${uncomparable === 1 ? " is" : "s are"} in another currency with no recorded rate, so not compared.`);
  }

  const stay = stayQuoteId ? comparable.find((c) => c.quote.id === stayQuoteId) ?? null : null;
  let stayPerPersonMinor: number | null = null;
  let incomplete = false;
  if (!stay) {
    missing.push(comparable.length === 0 ? "No comparable stay quote saved yet." : "The stay this shape used is no longer comparable.");
    incomplete = true;
  } else {
    const split = stay.perPerson!;
    stayPerPersonMinor = split.baseMinor + (split.extraCount > 0 ? 1 : 0);
    if (stay.total.unknown.length > 0) {
      missing.push(`${stay.quote.name}: ${stay.total.unknown.join(" and ")} unknown, so the stay cost is a minimum.`);
      incomplete = true;
    }
    if (stay.nightsMismatch) missing.push(`${stay.quote.name} is quoted for ${stay.quote.nights} nights; the trip has ${nights}.`);
  }

  const lines: ShapeLine[] = [
    {
      label: stay ? `Stay: ${stay.quote.name}` : "Stay",
      perPersonMinor: stayPerPersonMinor,
      note: stay && stay.converted ? "converted with the recorded rate" : undefined,
    },
  ];
  const others = inputs.categories.filter((c) => c.kind !== "stay");
  for (const c of others) {
    lines.push({ label: c.label, perPersonMinor: c.plannedPerPersonMinor });
    if (c.plannedPerPersonMinor === null) {
      missing.push(`${c.label} has no planned amount.`);
      incomplete = true;
    }
  }
  if (!inputs.categories.some((c) => c.kind === "flights")) {
    missing.push("No flights category: the bounds include flights, so add one (or 0 if nobody flies).");
    incomplete = true;
  }
  const stopsTotal = inputs.stopCostsMinor.reduce((a, b) => a + b, 0);
  if (inputs.stopCostsMinor.length > 0) {
    lines.push({ label: "Itinerary stops with a cost", perPersonMinor: stopsTotal, note: "members' estimates" });
  }

  const knownTotalMinor = lines.reduce((sum, l) => sum + (l.perPersonMinor ?? 0), 0);
  const targetMinor = tierTarget(tier, inputs.bounds);
  const headroomMinor = targetMinor === null ? null : targetMinor - knownTotalMinor;
  const verdict: Shape["verdict"] =
    targetMinor === null || knownTotalMinor === 0
      ? "unknown"
      : knownTotalMinor > targetMinor
        ? "over"
        : incomplete
          ? "unknown"
          : "within";

  return { tier, targetMinor, stay, stayPerPersonMinor, lines, knownTotalMinor, verdict, headroomMinor, incomplete, missing };
}

/** A saved shape row: the choices and the snapshot it was built from. */
export type SavedShape = {
  id: string;
  generation: number;
  tier: Tier;
  stayQuoteId: string | null;
  stayQuoteVersion: number | null;
  startDate: string | null;
  endDate: string | null;
  boundsMin: number | null;
  boundsMax: number | null;
  boundsSetAt: string | null;
  categories: { id: string; version: number }[];
  chosenAt: string | null;
};

/** Why a saved shape no longer matches the trip. Empty = up to date. */
export function staleReasons(saved: SavedShape, inputs: ShapeInputs): string[] {
  const out: string[] = [];
  if (saved.startDate !== inputs.startDate || saved.endDate !== inputs.endDate) out.push("the trip dates changed");
  const b = inputs.bounds;
  if ((b?.min ?? null) !== saved.boundsMin || (b?.max ?? null) !== saved.boundsMax) out.push("the planning bounds changed");
  if (saved.stayQuoteId) {
    const q = inputs.quotes.find((x) => x.id === saved.stayQuoteId);
    if (!q) out.push("its stay quote was deleted");
    else if (q.version !== saved.stayQuoteVersion) out.push("its stay quote was edited");
  } else if (saved.stayQuoteVersion !== null) {
    out.push("its stay quote was deleted");
  }
  const now = [...inputs.categories].map((c) => `${c.id}:${c.version}`).sort().join(",");
  const then = [...saved.categories].map((c) => `${c.id}:${c.version}`).sort().join(",");
  if (now !== then) out.push("budget categories changed");
  // A comparable quote added since may change which stay each tier uses.
  const choices = chooseStays(inputs);
  if (out.length === 0 && choices[saved.tier] !== saved.stayQuoteId) out.push("the saved stay quotes changed");
  return out;
}
