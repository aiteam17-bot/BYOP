// Pure validation helpers shared by the server actions and the tests.

export const PACE_OPTIONS = ["relaxed", "balanced", "packed"] as const;
export type Pace = (typeof PACE_OPTIONS)[number];

export const PACE_LABELS: Record<Pace, string> = {
  relaxed: "Relaxed: plenty of downtime",
  balanced: "Balanced: a mix of both",
  packed: "Packed: see as much as possible",
};

export const INTEREST_OPTIONS = [
  "Beaches",
  "Mountains",
  "Food",
  "History & culture",
  "Nature & wildlife",
  "Adventure",
  "Nightlife",
  "Shopping",
  "Wellness & relaxing",
] as const;

const MAX_RUPEES = 1_000_000_000; // 100 crore: far above any real trip budget
const MAX_TEXT = 1000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Turns "12,500" or "12500.50" (rupees) into integer paise, without floating
 * point maths. Empty input means "not provided" and gives value: null.
 */
export function parseRupees(
  raw: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  const cleaned = raw.replace(/[\s,₹]/g, "");
  if (cleaned === "") return { ok: true, value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return { ok: false, error: "Enter an amount in rupees, like 15000" };
  }
  const [whole, fraction = ""] = cleaned.split(".");
  if (Number(whole) > MAX_RUPEES) {
    return { ok: false, error: "That amount is too large" };
  }
  const paise = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return { ok: true, value: paise };
}

export type PreferenceInput = {
  budget_min_paise: number | null;
  budget_max_paise: number | null;
  pace: Pace | null;
  interests: string[];
  food_notes: string | null;
  must_see: string | null;
  avoid: string | null;
};

export type FieldErrors = Partial<
  Record<"budget_min" | "budget_max" | "pace" | "interests" | "food_notes" | "must_see" | "avoid", string>
>;

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function parsePreferences(
  form: FormData,
):
  | { ok: true; data: PreferenceInput }
  | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};

  const min = parseRupees(text(form, "budget_min"));
  const max = parseRupees(text(form, "budget_max"));
  if (!min.ok) errors.budget_min = min.error;
  if (!max.ok) errors.budget_max = max.error;
  if (
    min.ok && max.ok &&
    min.value !== null && max.value !== null &&
    max.value < min.value
  ) {
    errors.budget_max = "Maximum must be at least the minimum";
  }

  const paceRaw = text(form, "pace");
  let pace: Pace | null = null;
  if (paceRaw !== "") {
    if ((PACE_OPTIONS as readonly string[]).includes(paceRaw)) {
      pace = paceRaw as Pace;
    } else {
      errors.pace = "Choose one of the options";
    }
  }

  const ticked = form
    .getAll("interests")
    .filter((v): v is string => typeof v === "string")
    .filter((v) => (INTEREST_OPTIONS as readonly string[]).includes(v));
  const other = text(form, "interests_other")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const interests = [...new Set([...ticked, ...other])];
  if (interests.length > 20 || interests.some((i) => i.length > 40)) {
    errors.interests = "Keep it to 20 interests, each under 40 characters";
  }

  const longText: Array<"food_notes" | "must_see" | "avoid"> = [
    "food_notes",
    "must_see",
    "avoid",
  ];
  const texts: Record<string, string | null> = {};
  for (const key of longText) {
    const value = text(form, key);
    if (value.length > MAX_TEXT) {
      errors[key] = `Please keep this under ${MAX_TEXT} characters`;
    }
    texts[key] = value === "" ? null : value;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    data: {
      budget_min_paise: min.ok ? min.value : null,
      budget_max_paise: max.ok ? max.value : null,
      pace,
      interests,
      food_notes: texts.food_notes,
      must_see: texts.must_see,
      avoid: texts.avoid,
    },
  };
}

export function paiseToRupeesString(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return "";
  const whole = Math.floor(paise / 100);
  const frac = paise % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0")}`;
}

/** True for a real calendar date written as YYYY-MM-DD (rejects 2026-02-31). */
export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

const MAX_NIGHTS = 60;

/** Both dates or neither; the end must be after the start. */
export function parseTripDates(
  startRaw: string,
  endRaw: string,
):
  | { ok: true; startDate: string | null; endDate: string | null }
  | { ok: false; error: string } {
  const start = startRaw.trim();
  const end = endRaw.trim();
  if (start === "" && end === "") {
    return { ok: true, startDate: null, endDate: null };
  }
  if (start === "" || end === "") {
    return { ok: false, error: "Enter both a start date and an end date" };
  }
  if (!isRealDate(start) || !isRealDate(end)) {
    return { ok: false, error: "Enter real dates" };
  }
  const nights = Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
      86_400_000,
  );
  if (nights < 1) return { ok: false, error: "The end date must be after the start date" };
  if (nights > MAX_NIGHTS) {
    return { ok: false, error: `Trips can be at most ${MAX_NIGHTS} nights` };
  }
  return { ok: true, startDate: start, endDate: end };
}

export function parseTripInput(
  form: FormData,
):
  | {
      ok: true;
      name: string;
      destination: string | null;
      startDate: string | null;
      endDate: string | null;
    }
  | { ok: false; error: string } {
  const name = text(form, "name");
  const destination = text(form, "destination");
  if (name === "") return { ok: false, error: "Give your trip a name" };
  if (name.length > 80) return { ok: false, error: "Keep the name under 80 characters" };
  if (destination.length > 80) {
    return { ok: false, error: "Keep the destination under 80 characters" };
  }
  const dates = parseTripDates(text(form, "start_date"), text(form, "end_date"));
  if (!dates.ok) return dates;
  return {
    ok: true,
    name,
    destination: destination === "" ? null : destination,
    startDate: dates.startDate,
    endDate: dates.endDate,
  };
}
