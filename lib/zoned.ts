// Wall-clock time in an IANA zone <-> instant. Used for cancellation
// deadlines and "price checked" times entered in a named time zone.

function offsetMs(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** "2027-02-01T18:00" in Asia/Kolkata -> ISO instant "2027-02-01T12:30:00.000Z". Null if invalid. */
export function zonedLocalToIso(local: string, timeZone: string): string | null {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  if (new Date(guess).getUTCMonth() !== mo - 1 || new Date(guess).getUTCDate() !== d) return null;
  try {
    let instant = guess - offsetMs(guess, timeZone);
    instant = guess - offsetMs(instant, timeZone); // settle across DST changes
    return new Date(instant).toISOString();
  } catch {
    return null;
  }
}

/** ISO instant -> "1 Feb 2027, 18:00 (Asia/Kolkata)". */
export function formatInZone(iso: string, timeZone: string): string {
  const text = new Intl.DateTimeFormat("en-IN", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
  return `${text} (${timeZone.replace(/_/g, " ")})`;
}

/** ISO instant -> "YYYY-MM-DDTHH:mm" wall clock in the zone (for form defaults). */
export function isoToZonedLocal(iso: string, timeZone: string): string {
  const instant = Date.parse(iso);
  const local = new Date(instant + offsetMs(instant, timeZone));
  return local.toISOString().slice(0, 16);
}
