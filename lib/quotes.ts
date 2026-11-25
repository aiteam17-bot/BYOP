// Stay quote maths (PRD 08). Integer minor units only; no floating point in
// any amount. The database stores the quote exactly as quoted; this turns it
// into comparable numbers and says plainly what is unknown.

export type PricingBasis = "per_room_per_night" | "entire_stay_total";

export type Quote = {
  id: string;
  name: string;
  pricingBasis: PricingBasis;
  currency: string;
  /** The number exactly as quoted, in minor units of `currency`. */
  quotedAmountMinor: number;
  nights: number;
  rooms: number;
  /** null = unknown (never treated as zero). */
  taxesMinor: number | null;
  feesMinor: number | null;
  sharers: number;
  /** Trip-currency units per 1 quote-currency unit, times 1,000,000. */
  fxRateMicros: number | null;
  fxRateDate: string | null;
  fxSource: string | null;
  /** A member's rough guess per person, in trip currency. Never added to the quote. */
  transportEstimatePerPersonMinor: number | null;
};

/** The price before taxes and fees. A total quote is used as it is. */
export function quotedTotalMinor(q: Pick<Quote, "pricingBasis" | "quotedAmountMinor" | "rooms" | "nights">): number {
  return q.pricingBasis === "entire_stay_total" ? q.quotedAmountMinor : q.quotedAmountMinor * q.rooms * q.nights;
}

export type QuoteTotal = {
  /** Quoted total + whatever taxes and fees are known, in quote currency. */
  amountMinor: number;
  /** Which parts are unknown; non-empty means the true total is at least this. */
  unknown: ("taxes" | "fees")[];
};

export function quoteTotal(q: Quote): QuoteTotal {
  const unknown: ("taxes" | "fees")[] = [];
  if (q.taxesMinor === null) unknown.push("taxes");
  if (q.feesMinor === null) unknown.push("fees");
  return { amountMinor: quotedTotalMinor(q) + (q.taxesMinor ?? 0) + (q.feesMinor ?? 0), unknown };
}

/** amount x rate, rounded half up, in integer arithmetic. */
export function convertMinor(amountMinor: number, rateMicros: number): number {
  const scaled = BigInt(amountMinor) * BigInt(rateMicros);
  return Number((scaled + BigInt(500_000)) / BigInt(1_000_000));
}

export type InTrip =
  | { ok: true; amountMinor: number; converted: boolean }
  | { ok: false; reason: "needs_rate" };

/** The total in the trip currency: only with an explicitly recorded rate. */
export function inTripCurrency(totalMinor: number, q: Quote, tripCurrency: string): InTrip {
  if (q.currency === tripCurrency) return { ok: true, amountMinor: totalMinor, converted: false };
  if (q.fxRateMicros === null || q.fxRateDate === null || q.fxSource === null) return { ok: false, reason: "needs_rate" };
  return { ok: true, amountMinor: convertMinor(totalMinor, q.fxRateMicros), converted: true };
}

export type Split = {
  /** What most people pay. */
  baseMinor: number;
  /** How many people pay one minor unit more, so the shares add up exactly. */
  extraCount: number;
  shares: number[];
};

/** Split a total across sharers so the shares sum to the total exactly. */
export function splitExactly(totalMinor: number, sharers: number): Split {
  if (!Number.isInteger(totalMinor) || totalMinor < 0) throw new Error("total must be a whole number of minor units");
  if (!Number.isInteger(sharers) || sharers < 1) throw new Error("sharers must be at least 1");
  const baseMinor = Math.floor(totalMinor / sharers);
  const extraCount = totalMinor - baseMinor * sharers;
  const shares = Array.from({ length: sharers }, (_, i) => baseMinor + (i < extraCount ? 1 : 0));
  return { baseMinor, extraCount, shares };
}

export type ComparedQuote = {
  quote: Quote;
  total: QuoteTotal;
  /** null when the quote's currency has no recorded rate. */
  tripTotalMinor: number | null;
  converted: boolean;
  perPerson: Split | null;
  /** The quote's nights differ from the trip's dates. */
  nightsMismatch: boolean;
};

/**
 * Comparable quotes sorted by per-person cost in the trip currency (lowest
 * first); quotes in another currency without a recorded rate come last and
 * are never ranked.
 */
export function compareQuotes(quotes: Quote[], tripCurrency: string, tripNights: number | null): ComparedQuote[] {
  const rows = quotes.map((quote) => {
    const total = quoteTotal(quote);
    const inTrip = inTripCurrency(total.amountMinor, quote, tripCurrency);
    const tripTotalMinor = inTrip.ok ? inTrip.amountMinor : null;
    return {
      quote,
      total,
      tripTotalMinor,
      converted: inTrip.ok && inTrip.converted,
      perPerson: tripTotalMinor === null ? null : splitExactly(tripTotalMinor, quote.sharers),
      nightsMismatch: tripNights !== null && quote.nights !== tripNights,
    };
  });
  return rows.sort((a, b) => {
    if (a.perPerson && b.perPerson) return a.perPerson.baseMinor - b.perPerson.baseMinor || a.quote.name.localeCompare(b.quote.name);
    if (a.perPerson) return -1;
    if (b.perPerson) return 1;
    return a.quote.name.localeCompare(b.quote.name);
  });
}

/** "83.12" -> 83120000 (rate x 1e6), exactly; up to 6 decimals. */
export function parseRateMicros(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const micros = Number(whole) * 1_000_000 + Number(frac.padEnd(6, "0"));
  return micros > 0 && Number.isSafeInteger(micros) ? micros : null;
}
