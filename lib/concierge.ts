// Concierge = proposals, never direct edits (PRD 11). A proposal is a
// bounded patch of operations from a fixed list. This module parses and
// previews patches; the database checks them again and applies them
// atomically on Accept (supabase/013_plans_ai_concierge.sql).
//
// In limited mode no model writes patches: they come from members' choices
// (move / remove a stop, add a member-confirmed idea). Even so, a patch is
// treated as untrusted input: only these operations and fields, only ids
// that exist in this trip, no URLs, SQL, tools or free-form actions.
import { fromMinutes, sortStops, toMinutes, type Stop } from "@/lib/itinerary";

export const MAX_OPS = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export type Op =
  | { op: "add_stop"; day: number; time: string; duration?: number; title?: string; suggestion_id?: string }
  | { op: "move_stop"; item_id: string; expected_version: number; day: number; time: string }
  | { op: "remove_stop"; item_id: string; expected_version: number };

const FIELDS: Record<Op["op"], string[]> = {
  add_stop: ["op", "day", "time", "duration", "title", "suggestion_id"],
  move_stop: ["op", "item_id", "expected_version", "day", "time"],
  remove_stop: ["op", "item_id", "expected_version"],
};

const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

export type Parsed = { ok: true; ops: Op[] } | { ok: false; error: string };

export function parseOps(raw: unknown, maxDay: number): Parsed {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_OPS) return { ok: false, error: `A proposal has 1 to ${MAX_OPS} changes.` };
  const ops: Op[] = [];
  for (const o of raw) {
    if (typeof o !== "object" || o === null || Array.isArray(o)) return { ok: false, error: "Each change must be an object." };
    const r = o as Record<string, unknown>;
    const kind = r.op;
    if (kind !== "add_stop" && kind !== "move_stop" && kind !== "remove_stop") return { ok: false, error: "Unknown change type." };
    if (Object.keys(r).some((k) => !FIELDS[kind].includes(k))) return { ok: false, error: "Unexpected fields in a change." };
    if (kind !== "remove_stop") {
      if (!isInt(r.day, 1, maxDay)) return { ok: false, error: `Choose a day from 1 to ${maxDay}.` };
      if (typeof r.time !== "string" || !TIME.test(r.time)) return { ok: false, error: "Choose a time like 09:30." };
    }
    if (kind === "add_stop") {
      if (r.duration !== undefined && !isInt(r.duration, 5, 1440)) return { ok: false, error: "Duration must be between 5 minutes and 24 hours." };
      if (r.suggestion_id !== undefined) {
        if (typeof r.suggestion_id !== "string" || !UUID.test(r.suggestion_id) || r.title !== undefined) {
          return { ok: false, error: "That idea could not be found." };
        }
      } else {
        if (typeof r.title !== "string" || r.title.trim().length < 1 || r.title.trim().length > 120) {
          return { ok: false, error: "Give the stop a name (up to 120 characters)." };
        }
        if (r.duration === undefined) return { ok: false, error: "Duration must be between 5 minutes and 24 hours." };
      }
      ops.push({
        op: "add_stop",
        day: r.day as number,
        time: r.time as string,
        ...(r.duration !== undefined ? { duration: r.duration as number } : {}),
        ...(r.title !== undefined ? { title: (r.title as string).trim() } : {}),
        ...(r.suggestion_id !== undefined ? { suggestion_id: r.suggestion_id as string } : {}),
      });
    } else {
      if (typeof r.item_id !== "string" || !UUID.test(r.item_id) || !isInt(r.expected_version, 1, 999_999_999)) {
        return { ok: false, error: "That stop could not be found." };
      }
      ops.push(
        kind === "move_stop"
          ? { op: "move_stop", item_id: r.item_id, expected_version: r.expected_version as number, day: r.day as number, time: r.time as string }
          : { op: "remove_stop", item_id: r.item_id, expected_version: r.expected_version as number },
      );
    }
  }
  return { ok: true, ops };
}

/** One change from the page's form fields. */
export function opFromForm(form: FormData): unknown {
  const s = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v.trim() : "";
  };
  const kind = s("op");
  const day = Number(s("day"));
  const time = s("time");
  if (kind === "move_stop" || kind === "remove_stop") {
    const [item_id, version] = s("stop").split(":");
    const base = { op: kind, item_id, expected_version: Number(version) };
    return kind === "move_stop" ? { ...base, day, time } : base;
  }
  if (kind === "add_idea") return { op: "add_stop", day, time, suggestion_id: s("suggestion_id") };
  return { op: kind };
}

export type ConfirmedIdea = { id: string; name: string; minutes: number; priceMinor: number; placeUrl: string };

export type Preview = {
  days: { day: number; before: Stop[]; after: Stop[] }[];
  lines: string[];
  /** Problems that mean the patch cannot apply as shown. */
  problems: string[];
};

/** Before/after for the days a patch touches, computed from the current plan. */
export function previewOps(ops: Op[], current: Stop[], ideas: ConfirmedIdea[]): Preview {
  const after = current.map((s) => ({ ...s }));
  const touched = new Set<number>();
  const lines: string[] = [];
  const problems: string[] = [];
  ops.forEach((op, i) => {
    if (op.op === "add_stop") {
      const idea = op.suggestion_id ? ideas.find((x) => x.id === op.suggestion_id) : null;
      if (op.suggestion_id && !idea) {
        problems.push("An idea in this proposal is no longer confirmed.");
        return;
      }
      const title = idea ? idea.name : op.title!;
      const duration = op.duration ?? idea?.minutes ?? 60;
      after.push({
        id: `new-${i}`, day: op.day, time: op.time, duration, title,
        placeUrl: idea?.placeUrl ?? null, lat: null, lng: null, costMinor: idea?.priceMinor ?? null,
        notes: null, createdBy: null,
      });
      touched.add(op.day);
      lines.push(`Add "${title}" on day ${op.day} at ${op.time} (${duration} min).`);
      return;
    }
    const idx = after.findIndex((s) => s.id === op.item_id);
    if (idx < 0) {
      problems.push("A stop in this proposal no longer exists.");
      return;
    }
    const stop = after[idx];
    if (stop.version !== undefined && stop.version !== op.expected_version) problems.push(`"${stop.title}" changed since this was proposed.`);
    touched.add(stop.day);
    if (op.op === "remove_stop") {
      after.splice(idx, 1);
      lines.push(`Remove "${stop.title}" (day ${stop.day}, ${stop.time}).`);
    } else {
      lines.push(`Move "${stop.title}" from day ${stop.day} ${stop.time} to day ${op.day} ${op.time}.`);
      after[idx] = { ...stop, day: op.day, time: op.time };
      touched.add(op.day);
    }
  });
  const days = [...touched].sort((a, b) => a - b).map((day) => ({
    day,
    before: sortStops(current.filter((s) => s.day === day)),
    after: sortStops(after.filter((s) => s.day === day)),
  }));
  return { days, lines, problems };
}

/** "09:00-10:30" for a stop. */
export function span(s: Pick<Stop, "time" | "duration">): string {
  return `${s.time}-${fromMinutes(toMinutes(s.time) + s.duration)}`;
}
