// Stay-quote form -> the JSON payload create_quote/update_quote check again.
import { parseCoordinates } from "@/lib/map-config";
import { isCurrency, isTimezone } from "@/lib/money";
import { parseRateMicros } from "@/lib/quotes";
import { safeHttpUrl } from "@/lib/url";
import { isRealDate, parseRupees } from "@/lib/validation";
import { zonedLocalToIso } from "@/lib/zoned";

export type QuotePayload = {
  name: string;
  source_url: string;
  pricing_basis: "per_room_per_night" | "entire_stay_total";
  currency: string;
  quoted_amount_minor: number;
  nights: number;
  rooms: number;
  taxes_minor: number | null;
  fees_minor: number | null;
  sharers: number;
  beds: number | null;
  fx_rate_micros: number | null;
  fx_rate_date: string | null;
  fx_source: string | null;
  cancellation_deadline: string | null;
  cancellation_tz: string | null;
  cancellation_terms: string | null;
  latitude: number | null;
  longitude: number | null;
  transport_estimate_per_person_minor: number | null;
  checked_at: string;
};

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

function wholeNumber(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

/** Blank means unknown (null), never zero. */
function optionalMoney(raw: string): { ok: true; value: number | null } | { ok: false } {
  if (raw === "") return { ok: true, value: null };
  const r = parseRupees(raw.replace(/[$€£]|\b[A-Z]{3}\b/g, ""));
  return r.ok ? { ok: true, value: r.value } : { ok: false };
}

export function parseQuoteForm(
  f: FormData,
  tripCurrency: string,
  tripTimezone: string,
): { ok: true; data: QuotePayload } | { ok: false; error: string } {
  const name = s(f, "name");
  if (name.length < 1 || name.length > 120) return { ok: false, error: "Name the stay (up to 120 characters)" };
  const source = safeHttpUrl(s(f, "source_url"));
  if (!source) return { ok: false, error: "Add the link where this price came from" };
  const basis = s(f, "pricing_basis");
  if (basis !== "per_room_per_night" && basis !== "entire_stay_total") {
    return { ok: false, error: "Say whether the price is per room per night or the total for the stay" };
  }
  const currency = s(f, "currency");
  if (!isCurrency(currency)) return { ok: false, error: "Choose the currency of the quote" };
  const amount = optionalMoney(s(f, "quoted_amount"));
  if (!amount.ok || amount.value === null || amount.value <= 0) return { ok: false, error: "Enter the quoted price" };
  const nights = wholeNumber(s(f, "nights"), 1, 60);
  const rooms = wholeNumber(s(f, "rooms"), 1, 50);
  const sharers = wholeNumber(s(f, "sharers"), 1, 100);
  if (nights === null || rooms === null || sharers === null) {
    return { ok: false, error: "Nights (1–60), rooms (1–50) and people sharing (1–100) are whole numbers" };
  }
  const bedsRaw = s(f, "beds");
  const beds = bedsRaw === "" ? null : wholeNumber(bedsRaw, 0, 200);
  if (bedsRaw !== "" && beds === null) return { ok: false, error: "Beds is a whole number" };
  const taxes = optionalMoney(s(f, "taxes"));
  const fees = optionalMoney(s(f, "fees"));
  if (!taxes.ok || !fees.ok) return { ok: false, error: "Taxes and fees are amounts, or leave them blank if unknown" };

  const rateRaw = s(f, "fx_rate");
  const rateDate = s(f, "fx_rate_date");
  const rateSource = s(f, "fx_source");
  let fx: { micros: number; date: string; source: string } | null = null;
  if (rateRaw || rateDate || rateSource) {
    if (currency === tripCurrency) return { ok: false, error: "No conversion rate is needed for the trip's own currency" };
    const micros = parseRateMicros(rateRaw);
    if (micros === null || !isRealDate(rateDate) || rateSource.length < 1 || rateSource.length > 120) {
      return { ok: false, error: "A conversion needs the rate, the date of the rate and where it came from" };
    }
    fx = { micros, date: rateDate, source: rateSource };
  }

  const deadlineLocal = s(f, "cancellation_deadline");
  const cancelTz = s(f, "cancellation_tz") || tripTimezone;
  let deadline: string | null = null;
  if (deadlineLocal) {
    if (!isTimezone(cancelTz)) return { ok: false, error: "Choose the time zone of the cancellation deadline" };
    deadline = zonedLocalToIso(deadlineLocal, cancelTz);
    if (!deadline) return { ok: false, error: "Enter a real cancellation date and time" };
  }
  const checked = zonedLocalToIso(s(f, "checked_at"), tripTimezone);
  if (!checked) return { ok: false, error: "Enter when you checked the price" };
  if (Date.parse(checked) > Date.now() + 5 * 60_000) return { ok: false, error: "The checked time cannot be in the future" };

  const coords = s(f, "coordinates");
  let lat: number | null = null;
  let lng: number | null = null;
  if (coords) {
    const c = parseCoordinates(coords);
    if (!c.ok) return { ok: false, error: c.error };
    lat = c.lat;
    lng = c.lng;
  }
  const transport = optionalMoney(s(f, "transport_estimate"));
  if (!transport.ok) return { ok: false, error: "The transport estimate is an amount, or leave it blank" };
  const terms = s(f, "cancellation_terms");
  if (terms.length > 1000) return { ok: false, error: "Keep the cancellation terms under 1000 characters" };

  return {
    ok: true,
    data: {
      name,
      source_url: source,
      pricing_basis: basis,
      currency,
      quoted_amount_minor: amount.value,
      nights,
      rooms,
      taxes_minor: taxes.value,
      fees_minor: fees.value,
      sharers,
      beds,
      fx_rate_micros: fx?.micros ?? null,
      fx_rate_date: fx?.date ?? null,
      fx_source: fx?.source ?? null,
      cancellation_deadline: deadline,
      cancellation_tz: deadline ? cancelTz : null,
      cancellation_terms: terms || null,
      latitude: lat,
      longitude: lng,
      transport_estimate_per_person_minor: transport.value,
      checked_at: checked,
    },
  };
}
