// Validation for the "Add a stay" form. Pure functions, shared with the tests.
import type { Cancellation } from "@/lib/stay-costs";
import { parseCoordinates } from "@/lib/map-config";
import { safeHttpUrl } from "@/lib/url";
import { isRealDate, parseRupees } from "@/lib/validation";

export const CANCELLATION_TYPES: Cancellation[] = [
  "unknown",
  "free",
  "partial",
  "non_refundable",
];

export type StayInput = {
  name: string;
  url: string;
  nightly_price_paise: number;
  taxes_paise: number;
  fees_paise: number;
  cancellation_type: Cancellation;
  cancellation_terms: string | null;
  rooms: number;
  beds: number;
  distance_km: number | null;
  price_checked_on: string;
  latitude: number | null; // map pin, optional
  longitude: number | null;
};

export type StayErrors = Partial<Record<
  | "name" | "url" | "nightly" | "taxes" | "fees" | "cancellation_type"
  | "cancellation_terms" | "rooms" | "beds" | "distance_km" | "price_checked_on"
  | "location",
  string
>>;

// Kept here too so existing imports keep working.
export { safeHttpUrl };

function text(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function wholeNumber(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

export function parseStayInput(
  form: FormData,
  today: string, // YYYY-MM-DD, passed in so tests are deterministic
): { ok: true; data: StayInput } | { ok: false; errors: StayErrors } {
  const errors: StayErrors = {};

  const name = text(form, "name");
  if (name === "") errors.name = "Give the stay a name";
  else if (name.length > 100) errors.name = "Keep the name under 100 characters";

  const url = safeHttpUrl(text(form, "url"));
  if (!url) errors.url = "Paste the listing link, starting with http:// or https://";

  const nightly = parseRupees(text(form, "nightly"));
  if (!nightly.ok) errors.nightly = nightly.error;
  else if (nightly.value === null || nightly.value === 0) {
    errors.nightly = "Enter the nightly price in rupees";
  }

  const taxes = parseRupees(text(form, "taxes"));
  if (!taxes.ok) errors.taxes = taxes.error;
  const fees = parseRupees(text(form, "fees"));
  if (!fees.ok) errors.fees = fees.error;

  const typeRaw = text(form, "cancellation_type") || "unknown";
  if (!(CANCELLATION_TYPES as string[]).includes(typeRaw)) {
    errors.cancellation_type = "Choose one of the options";
  }

  const terms = text(form, "cancellation_terms");
  if (terms.length > 500) {
    errors.cancellation_terms = "Please keep this under 500 characters";
  }

  const rooms = wholeNumber(text(form, "rooms"), 1, 100);
  if (rooms === null) errors.rooms = "Enter the number of rooms (1 or more)";
  const beds = wholeNumber(text(form, "beds"), 1, 200);
  if (beds === null) errors.beds = "Enter the number of beds (1 or more)";

  let distance: number | null = null;
  const distanceRaw = text(form, "distance_km");
  if (distanceRaw !== "") {
    if (/^\d+(\.\d{1,2})?$/.test(distanceRaw) && Number(distanceRaw) <= 1000) {
      distance = Number(distanceRaw);
    } else {
      errors.distance_km = "Enter the distance in km, like 2.5";
    }
  }

  // Optional map location, pasted as "latitude, longitude".
  let latitude: number | null = null;
  let longitude: number | null = null;
  const locationRaw = text(form, "location");
  if (locationRaw !== "") {
    const place = parseCoordinates(locationRaw);
    if (place.ok) {
      latitude = place.lat;
      longitude = place.lng;
    } else {
      errors.location = place.error;
    }
  }

  const checked = text(form, "price_checked_on");
  if (!isRealDate(checked)) {
    errors.price_checked_on = "Enter the date you checked the price";
  } else if (checked > today) {
    errors.price_checked_on = "That date is in the future";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    data: {
      name,
      url: url!,
      nightly_price_paise: nightly.ok ? nightly.value! : 0,
      taxes_paise: taxes.ok ? (taxes.value ?? 0) : 0,
      fees_paise: fees.ok ? (fees.value ?? 0) : 0,
      cancellation_type: typeRaw as Cancellation,
      cancellation_terms: terms === "" ? null : terms,
      rooms: rooms!,
      beds: beds!,
      distance_km: distance,
      price_checked_on: checked,
      latitude,
      longitude,
    },
  };
}
