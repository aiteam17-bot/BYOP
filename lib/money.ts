// Trip currency and time zone. Every amount is stored as integer MINOR units
// (paise for INR, cents for USD...). All supported currencies have 2 decimals.

export const CURRENCIES = ["INR", "USD", "EUR", "GBP", "SGD", "AED", "AUD", "CAD", "THB", "MYR", "LKR", "NPR"] as const;
export type Currency = (typeof CURRENCIES)[number];

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

/** 2030000 INR -> "₹20,300"; 995050 -> "₹9,950.50". Display only. */
export function formatMoney(minor: number, currency: string): string {
  const whole = minor % 100 === 0;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

/** The currency's symbol as shown in form labels, e.g. "₹" or "US$". */
export function currencySymbol(currency: string): string {
  const part = new Intl.NumberFormat("en-IN", { style: "currency", currency })
    .formatToParts(0)
    .find((p) => p.type === "currency");
  return part?.value ?? currency;
}

// Offered in the "new trip" form. The database accepts any real IANA zone.
export const COMMON_TIMEZONES = [
  "Asia/Kolkata",
  "Asia/Colombo",
  "Asia/Kathmandu",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Bangkok",
  "Asia/Kuala_Lumpur",
  "Asia/Tokyo",
  "Europe/London",
  "Europe/Paris",
  "America/New_York",
  "America/Los_Angeles",
  "Australia/Sydney",
  "UTC",
] as const;

/** A real IANA time zone name (region/city or UTC), as the runtime knows it. */
export function isTimezone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^([A-Za-z_]+(\/[A-Za-z0-9_+-]+)+|UTC)$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
