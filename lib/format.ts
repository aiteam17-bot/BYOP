// Display helpers. All money in the app is integer paise; these are the only
// places that turn it into text.

/** 1250000 -> "₹12,500", 995050 -> "₹9,950.50" (Indian digit grouping). */
export function formatRupees(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const grouped = whole.toLocaleString("en-IN");
  const fraction = frac === 0 ? "" : `.${String(frac).padStart(2, "0")}`;
  return `${negative ? "-" : ""}₹${grouped}${fraction}`;
}

/** Distance stored as hundredths of a km: 250 -> "2.5 km", 300 -> "3 km". */
export function formatKm(centiKm: number): string {
  const km = centiKm / 100;
  return `${Number.isInteger(km) ? km : km.toFixed(2).replace(/0+$/, "")} km`;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2026-11-12" -> "12 Nov 2026" (no time zones involved). */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
