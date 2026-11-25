// Pure rules for PRD 05 (itinerary day view). No database access.
import { parseCoordinates } from "@/lib/map-config";
import { safeHttpUrl } from "@/lib/url";
import { parseRupees } from "@/lib/validation";

export type Stop = {
  id: string;
  day: number;
  /** Local wall-clock start in the trip time zone, "HH:MM". */
  time: string;
  duration: number; // minutes
  title: string;
  placeUrl: string | null;
  lat: number | null;
  lng: number | null;
  costMinor: number | null;
  notes: string | null;
  createdBy: string | null;
  /** Member-entered travel time from the previous stop; null = unknown. */
  travelMinutes?: number | null;
  placeId?: string | null;
  version?: number;
};

export type StopStatus = "agreed" | "contested" | "proposed";

/** Agreed: every current member is for it. Contested: anyone is against. */
export function stopStatus(votes: Record<string, "for" | "against">, memberIds: string[]): StopStatus {
  const current = memberIds.map((id) => votes[id]).filter(Boolean);
  if (current.includes("against")) return "contested";
  if (memberIds.length > 0 && current.length === memberIds.length) return "agreed";
  return "proposed";
}

export function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export function fromMinutes(total: number): string {
  const m = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function sortStops(stops: Stop[]): Stop[] {
  return [...stops].sort((a, b) => toMinutes(a.time) - toMinutes(b.time) || a.title.localeCompare(b.title));
}

/** Great-circle distance in km (straight line, not a route). */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export type DayWarning = { stopId: string; message: string };

/** Clashes within one day, in words. */
export function dayWarnings(dayStops: Stop[]): DayWarning[] {
  const sorted = sortStops(dayStops);
  const warnings: DayWarning[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const end = toMinutes(s.time) + s.duration;
    if (end > 1440) {
      warnings.push({ stopId: s.id, message: `${s.title} runs past midnight (ends ${fromMinutes(end)} the next day).` });
    }
    const next = sorted[i + 1];
    if (next && end > toMinutes(next.time)) {
      warnings.push({
        stopId: next.id,
        message: `${next.title} starts at ${next.time}, before ${s.title} ends at ${fromMinutes(end)}.`,
      });
    }
  }
  return warnings;
}

/** Straight-line km from the previous located stop that day, by stop id. */
export function distancesFromPrevious(dayStops: Stop[]): Record<string, number> {
  const out: Record<string, number> = {};
  let prev: Stop | null = null;
  for (const s of sortStops(dayStops)) {
    if (s.lat !== null && s.lng !== null) {
      if (prev && prev.lat !== null && prev.lng !== null) {
        out[s.id] = haversineKm({ lat: prev.lat, lng: prev.lng }, { lat: s.lat, lng: s.lng });
      }
      prev = s;
    }
  }
  return out;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Day 2 · Sat 6 Feb" when the trip has dates; "Day 2" otherwise. Date-only maths. */
export function dayLabel(day: number, startDate: string | null): string {
  if (!startDate) return `Day ${day}`;
  const [y, m, d] = startDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + day - 1));
  return `Day ${day} · ${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** Number of days the trip covers, or null without dates. */
export function tripDays(startDate: string | null, endDate: string | null): number | null {
  if (!startDate || !endDate) return null;
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1;
}

export type StopInput = {
  day: number;
  time: string;
  duration: number;
  title: string;
  placeUrl: string | null;
  lat: number | null;
  lng: number | null;
  costMinor: number | null;
  notes: string | null;
  travelMinutes: number | null;
  placeId: string | null;
};

function field(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/** Validates the stop form. The database checks again. */
export function parseStopForm(form: FormData, maxDay: number): { ok: true; data: StopInput } | { ok: false; error: string } {
  const day = Number(field(form, "day"));
  if (!Number.isInteger(day) || day < 1 || day > maxDay) return { ok: false, error: `Choose a day from 1 to ${maxDay}` };
  const time = field(form, "time");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { ok: false, error: "Choose a start time" };
  const duration = Number(field(form, "duration"));
  if (!Number.isInteger(duration) || duration < 5 || duration > 1440) {
    return { ok: false, error: "Duration must be between 5 minutes and 24 hours" };
  }
  const title = field(form, "title");
  if (title.length < 1 || title.length > 120) return { ok: false, error: "Give the stop a name (up to 120 characters)" };
  const urlRaw = field(form, "place_url");
  const placeUrl = urlRaw === "" ? null : safeHttpUrl(urlRaw);
  if (urlRaw !== "" && !placeUrl) return { ok: false, error: "Links must start with http:// or https://" };
  const coordsRaw = field(form, "coordinates");
  let lat: number | null = null;
  let lng: number | null = null;
  if (coordsRaw !== "") {
    const c = parseCoordinates(coordsRaw);
    if (!c.ok) return { ok: false, error: c.error };
    lat = c.lat;
    lng = c.lng;
  }
  const cost = parseRupees(field(form, "cost"));
  if (!cost.ok) return { ok: false, error: cost.error };
  const notes = field(form, "notes");
  if (notes.length > 1000) return { ok: false, error: "Keep notes under 1000 characters" };
  const travelRaw = field(form, "travel_minutes");
  let travelMinutes: number | null = null;
  if (travelRaw !== "") {
    const t = Number(travelRaw);
    if (!Number.isInteger(t) || t < 0 || t > 1440) return { ok: false, error: "Travel time is 0 to 1440 minutes, or leave it empty" };
    travelMinutes = t;
  }
  const placeRaw = field(form, "place_id");
  const placeId = /^[0-9a-f-]{36}$/i.test(placeRaw) ? placeRaw : null;
  return {
    ok: true,
    data: {
      day, time, duration, title, placeUrl, lat, lng, costMinor: cost.value,
      notes: notes === "" ? null : notes, travelMinutes, placeId,
    },
  };
}
