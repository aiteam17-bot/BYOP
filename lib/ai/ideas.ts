// What may come BACK from the model, and what we do with it. Model output is
// untrusted data: it is parsed against a fixed shape, trimmed to limits, and
// never treated as instructions, actions, SQL or a URL to fetch. Ideas carry
// no prices (none are asked for; any number in the text is not used).
import type { Interest } from "@/lib/ai/generic-request";

export const IDEA_CATEGORIES = ["sight", "food", "nature", "activity", "culture", "nightlife", "shopping", "relax"] as const;
export type IdeaCategory = (typeof IDEA_CATEGORIES)[number];

export type Idea = {
  name: string;
  category: IdeaCategory;
  area: string | null;
  why: string | null;
  source_url: string | null;
};

export const MAX_IDEAS = 8;
/** Hard cap on the model's raw text before we even try to parse it. */
export const MAX_OUTPUT_CHARS = 16_000;

/** Plain single-line text: control characters removed, spaces collapsed, cut to max. */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max).trimEnd() : s;
}

/**
 * A link we may show (never fetch): https only, a real-looking public host,
 * no credentials, no IP address or local name, up to 500 characters.
 */
export function safeSourceUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 500) return null;
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null; // no IPv6 / odd hosts
  if (/^\d+(\.\d+){3}$/.test(host)) return null; // no IPv4
  if (/(^|\.)(localhost|local|internal|lan|home|corp|test|example|invalid)$/.test(host)) return null;
  return u.toString();
}

export type ParsedIdeas = { ok: true; ideas: Idea[]; dropped: number } | { ok: false; reason: "malformed" };

/** Parse the model's JSON text. Bad items are dropped and counted; a bad shape fails. */
export function parseIdeas(text: string): ParsedIdeas {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_OUTPUT_CHARS) return { ok: false, reason: "malformed" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { ideas?: unknown }).ideas)) {
    return { ok: false, reason: "malformed" };
  }
  const list = (raw as { ideas: unknown[] }).ideas;
  const ideas: Idea[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const item of list) {
    if (ideas.length >= MAX_IDEAS) {
      dropped++;
      continue;
    }
    if (typeof item !== "object" || item === null) {
      dropped++;
      continue;
    }
    const o = item as Record<string, unknown>;
    const name = cleanText(o.name, 80);
    const category = typeof o.category === "string" && (IDEA_CATEGORIES as readonly string[]).includes(o.category) ? (o.category as IdeaCategory) : null;
    if (!name || !category || seen.has(name.toLowerCase())) {
      dropped++;
      continue;
    }
    seen.add(name.toLowerCase());
    // An unsafe link is dropped; the idea is kept without it.
    const source_url = safeSourceUrl(o.source_url);
    ideas.push({ name, category, area: cleanText(o.area, 80), why: cleanText(o.why, 300), source_url });
  }
  return { ok: true, ideas, dropped };
}

const INTEREST_CATEGORIES: Record<Interest, IdeaCategory[]> = {
  Beaches: ["relax", "nature"],
  Mountains: ["nature", "activity"],
  Food: ["food"],
  "History & culture": ["sight", "culture"],
  "Nature & wildlife": ["nature"],
  Adventure: ["activity"],
  Nightlife: ["nightlife"],
  Shopping: ["shopping"],
  "Wellness & relaxing": ["relax"],
};

/**
 * Local only: filter out what the trip already has and rank by the
 * requester's own private interests. Nothing here is sent anywhere.
 */
export function rankIdeas(ideas: Idea[], opts: { myInterests: string[]; existingNames: string[] }): Idea[] {
  const existing = new Set(opts.existingNames.map((n) => n.trim().toLowerCase()));
  const liked = new Set<IdeaCategory>();
  for (const i of opts.myInterests) for (const c of INTEREST_CATEGORIES[i as Interest] ?? []) liked.add(c);
  return ideas
    .map((idea, index) => ({ idea, index }))
    .filter(({ idea }) => !existing.has(idea.name.toLowerCase()))
    .sort((a, b) => Number(liked.has(b.idea.category)) - Number(liked.has(a.idea.category)) || a.index - b.index)
    .map(({ idea }) => idea);
}
