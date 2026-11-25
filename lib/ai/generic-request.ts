// The ONLY data that may be sent to the unpaid Gemini service, and the only
// way to build it. Allowlisted fields, each generic and non-personal:
//
//   destination  a place name (letters only; no member names, numbers, links)
//   season       a month name, or "any time of year" (never exact dates)
//   groupSize    a coarse band ("1", "2", "3-4", "5-8", "9+")
//   pace         relaxed / balanced / packed (chosen by the requester)
//   interests    up to 3 from the fixed list (chosen by the requester)
//
// Never sent: budgets or anything derived from them, exact dates or
// schedules, names, emails, chat or comments, food/health notes, bookings,
// files, expenses, or free-text preferences. Private constraints are used
// afterwards, locally, to filter and rank what comes back.
import { INTEREST_OPTIONS, PACE_OPTIONS, type Pace } from "@/lib/validation";

export const ALLOWED_KEYS = ["destination", "season", "groupSize", "pace", "interests"] as const;
export const GROUP_SIZES = ["1", "2", "3-4", "5-8", "9+"] as const;
export type GroupSize = (typeof GROUP_SIZES)[number];
export type Interest = (typeof INTEREST_OPTIONS)[number];

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;
export const SEASONS = [...MONTHS, "any time of year"] as const;

export type GenericIdeasRequest = {
  destination: string;
  season: (typeof SEASONS)[number];
  groupSize: GroupSize;
  pace: Pace;
  interests: Interest[];
};

/** Hard cap on the serialised request. */
export const MAX_REQUEST_BYTES = 512;

export function groupSizeBand(count: number): GroupSize {
  if (count <= 1) return "1";
  if (count === 2) return "2";
  if (count <= 4) return "3-4";
  if (count <= 8) return "5-8";
  return "9+";
}

/** Month of the trip start, never the day. */
export function seasonOf(startDate: string | null): GenericIdeasRequest["season"] {
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return "any time of year";
  return MONTHS[Number(startDate.slice(5, 7)) - 1] ?? "any time of year";
}

// A place name: letters, up to 4 words and 40 characters ("Ho Chi Minh City").
// Short on purpose, so a sentence about someone cannot ride along.
const DESTINATION_RE = /^(?=.{1,40}$)[\p{L}\p{M}][\p{L}\p{M}.'-]*(?:[ ,]{1,2}[\p{L}\p{M}][\p{L}\p{M}.'-]*){0,3}$/u;

type Built = { ok: true; request: GenericIdeasRequest; json: string; bytes: number } | { ok: false; error: string };

/**
 * Build the request. `forbiddenWords` are member names (and anything else
 * personal the caller knows); a destination containing one is refused.
 */
export function buildGenericRequest(input: {
  destination: string | null;
  startDate: string | null;
  memberCount: number;
  pace: string;
  interests: string[];
  forbiddenWords: string[];
}): Built {
  const raw = (input.destination ?? "").trim();
  if (!raw) return { ok: false, error: "Add a destination to the trip first." };
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return { ok: false, error: "The destination must be a plain place name (letters only, up to 4 words) to be sent." };
  }
  const destination = raw.replace(/ +/g, " ");
  if (!DESTINATION_RE.test(destination)) {
    return { ok: false, error: "The destination must be a plain place name (letters only, up to 4 words) to be sent." };
  }
  const lower = destination.toLowerCase();
  for (const w of input.forbiddenWords) {
    const word = w.trim().toLowerCase();
    if (word.length >= 3 && new RegExp(`(^|[^\\p{L}])${escapeRe(word)}([^\\p{L}]|$)`, "u").test(lower)) {
      return { ok: false, error: "The destination contains a member's name, so it was not sent. Rename the destination to a place name." };
    }
  }
  if (!(PACE_OPTIONS as readonly string[]).includes(input.pace)) return { ok: false, error: "Choose a pace." };
  const interests = [...new Set(input.interests)];
  if (interests.length > 3) return { ok: false, error: "Choose up to 3 interests." };
  if (!interests.every((i) => (INTEREST_OPTIONS as readonly string[]).includes(i))) {
    return { ok: false, error: "Choose interests from the list." };
  }
  const request: GenericIdeasRequest = {
    destination,
    season: seasonOf(input.startDate),
    groupSize: groupSizeBand(input.memberCount),
    pace: input.pace as Pace,
    interests: interests as Interest[],
  };
  return finalize(request);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Re-checks a request object against the allowlist and serialises it. */
export function finalize(request: unknown): Built {
  if (!isAllowlisted(request)) return { ok: false, error: "That request is not allowed." };
  // Fixed key order; nothing else can be added.
  const json = JSON.stringify({
    destination: request.destination,
    season: request.season,
    groupSize: request.groupSize,
    pace: request.pace,
    interests: request.interests,
  });
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > MAX_REQUEST_BYTES) return { ok: false, error: "That request is too large." };
  return { ok: true, request, json, bytes };
}

export function isAllowlisted(x: unknown): x is GenericIdeasRequest {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const keys = Object.keys(x);
  if (keys.length !== ALLOWED_KEYS.length || !keys.every((k) => (ALLOWED_KEYS as readonly string[]).includes(k))) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.destination === "string" &&
    DESTINATION_RE.test(r.destination) &&
    (SEASONS as readonly unknown[]).includes(r.season) &&
    (GROUP_SIZES as readonly unknown[]).includes(r.groupSize) &&
    (PACE_OPTIONS as readonly unknown[]).includes(r.pace) &&
    Array.isArray(r.interests) &&
    r.interests.length <= 3 &&
    r.interests.every((i) => (INTEREST_OPTIONS as readonly unknown[]).includes(i))
  );
}
