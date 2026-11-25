import { Suspense } from "react";
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { ClientKey } from "@/components/client-key";
import { Card, Muted, Shell, inputClass, labelClass, smallButton, smallPrimaryButton } from "@/components/ui";
import { buildGenericRequest } from "@/lib/ai/generic-request";
import { aiConfig } from "@/lib/ai/gemini";
import { previewOps, span, parseOps, type ConfirmedIdea } from "@/lib/concierge";
import { canPlan } from "@/lib/decide";
import { tripDays, type Stop } from "@/lib/itinerary";
import { currencySymbol, formatMoney } from "@/lib/money";
import { loadShapeInputs } from "@/lib/plan-data";
import { TIERS, TIER_LABELS, buildShape, staleReasons, type SavedShape, type ShapeInputs, type Tier } from "@/lib/plan-shapes";
import { createClient } from "@/lib/supabase/server";
import { loadTripContext, type TripContext } from "@/lib/trip-data";
import { INTEREST_OPTIONS, PACE_LABELS, PACE_OPTIONS } from "@/lib/validation";
import {
  acceptProposal,
  buildShapes,
  chooseShape,
  confirmIdea,
  dismissIdea,
  dismissProposal,
  proposeChange,
  requestIdeas,
  setAiOptIn,
} from "./actions";

export const metadata = { title: "Plans · Group Trip Planner" };

const badge = "inline-block rounded-full px-2 py-0.5 text-xs font-medium";
const unverifiedBadge = `${badge} bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200`;
const okBadge = `${badge} bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200`;

type Supa = Awaited<ReturnType<typeof createClient>>;

function nameOf(ctx: TripContext, id: string | null): string {
  if (!id) return "a former member";
  return ctx.members.find((m) => m.userId === id)?.name ?? "a former member";
}

// ---------------------------------------------------------------------------
// Tight / Balanced / Splurge
// ---------------------------------------------------------------------------

type ShapeRow = {
  id: string;
  generation: number;
  tier: Tier;
  stay_quote_id: string | null;
  stay_quote_version: number | null;
  start_date: string | null;
  end_date: string | null;
  bounds_min_minor: number | string | null;
  bounds_max_minor: number | string | null;
  bounds_set_at: string | null;
  categories: { id: string; version: number }[];
  chosen_at: string | null;
  chosen_by: string | null;
  created_by: string | null;
  created_at: string;
};

const n = (v: number | string | null) => (v === null ? null : Number(v));

function toSaved(r: ShapeRow): SavedShape {
  return {
    id: r.id, generation: r.generation, tier: r.tier, stayQuoteId: r.stay_quote_id, stayQuoteVersion: r.stay_quote_version,
    startDate: r.start_date, endDate: r.end_date, boundsMin: n(r.bounds_min_minor), boundsMax: n(r.bounds_max_minor),
    boundsSetAt: r.bounds_set_at, categories: r.categories ?? [], chosenAt: r.chosen_at,
  };
}

async function Shapes({ ctx, supabase, inputs }: { ctx: TripContext; supabase: Supa; inputs: ShapeInputs }) {
  const { data, error } = await supabase
    .from("plan_shapes")
    .select("id, generation, tier, stay_quote_id, stay_quote_version, start_date, end_date, bounds_min_minor, bounds_max_minor, bounds_set_at, categories, chosen_at, chosen_by, created_by, created_at")
    .eq("trip_id", ctx.trip.id)
    .order("generation", { ascending: false })
    .limit(30);
  if (error) throw new Error("Could not load plan shapes");
  const rows = (data ?? []) as ShapeRow[];
  const latestGen = rows[0]?.generation ?? null;
  const latest = rows.filter((r) => r.generation === latestGen);
  const chosen = rows.find((r) => r.chosen_at && r.generation !== latestGen);
  const planner = canPlan(ctx.me.role);
  const money = (m: number) => formatMoney(m, ctx.trip.currency);

  return (
    <Card title="Tight, Balanced, Splurge">
      <div className="flex flex-col gap-4">
        <Muted>
          Three shapes built only from what the group saved: the trip dates, the planning bounds the
          group confirmed, stay quotes and budget categories. Amounts are per person, worked out in
          code from those rows. Nothing is estimated by AI and anything missing is listed.
        </Muted>
        {latest.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No shapes saved yet.</p>
        ) : (
          <>
            <p className="text-sm text-zinc-500">
              Saved by {nameOf(ctx, latest[0].created_by)} · version {latestGen}
            </p>
            <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
              {TIERS.map((tier) => {
                const row = latest.find((r) => r.tier === tier);
                if (!row) return null;
                const saved = toSaved(row);
                const shape = buildShape(tier, saved.stayQuoteId, inputs);
                const stale = staleReasons(saved, inputs);
                return (
                  <article key={tier} aria-label={TIER_LABELS[tier]} className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
                    <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold">
                      {TIER_LABELS[tier]}
                      {row.chosen_at && <span className={okBadge}>The group&apos;s plan</span>}
                    </h3>
                    {stale.length > 0 && (
                      <p role="note" className="rounded bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                        Out of date: {stale.join("; ")}. Rebuild to update.
                      </p>
                    )}
                    <p className="text-sm">
                      Target: {shape.targetMinor === null ? <strong>no bounds yet</strong> : <strong>{money(shape.targetMinor)}</strong>}
                    </p>
                    <ul className="flex flex-col gap-1 text-sm">
                      {shape.lines.map((l) => (
                        <li key={l.label} className="flex justify-between gap-2">
                          <span>
                            {l.label}
                            {l.note && <span className="text-zinc-500"> ({l.note})</span>}
                          </span>
                          <span className="tabular-nums">{l.perPersonMinor === null ? "Unknown" : money(l.perPersonMinor)}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="text-sm font-medium">
                      Known total: {shape.incomplete ? "at least " : ""}
                      {money(shape.knownTotalMinor)}
                    </p>
                    <p className="text-sm">
                      {shape.verdict === "over" && shape.headroomMinor !== null && <>Over the target by {money(-shape.headroomMinor)}.</>}
                      {shape.verdict === "within" && shape.headroomMinor !== null && <>Within the target, {money(shape.headroomMinor)} to spare.</>}
                      {shape.verdict === "unknown" && "Can't tell yet whether this fits."}
                    </p>
                    {shape.missing.length > 0 && (
                      <details className="text-sm">
                        <summary className="cursor-pointer underline">Missing ({shape.missing.length})</summary>
                        <ul className="mt-1 list-disc pl-5 text-zinc-700 dark:text-zinc-300">
                          {shape.missing.map((m) => (
                            <li key={m}>{m}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {planner && !row.chosen_at && (
                      <ActionForm action={chooseShape.bind(null, ctx.trip.id, row.id)}>
                        <SubmitButton className={smallButton} pendingText="Saving…">
                          Go with {TIER_LABELS[tier]}
                        </SubmitButton>
                      </ActionForm>
                    )}
                  </article>
                );
              })}
            </div>
            {chosen && (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                The group&apos;s plan is still {TIER_LABELS[chosen.tier]} from version {chosen.generation}.
              </p>
            )}
          </>
        )}
        <p className="text-sm text-zinc-500">
          Inputs live on <Link className="underline" href={`/trips/${ctx.trip.id}/budget`}>Budget</Link> (bounds and
          categories) and <Link className="underline" href={`/trips/${ctx.trip.id}/stays`}>Compare stays</Link> (quotes).
        </p>
        {planner ? (
          <ActionForm action={buildShapes.bind(null, ctx.trip.id)}>
            <SubmitButton className={smallPrimaryButton} pendingText="Building…">
              {latest.length === 0 ? "Build the three shapes" : "Rebuild from current inputs"}
            </SubmitButton>
          </ActionForm>
        ) : (
          <p className="text-sm text-zinc-500">The organiser or a co-planner builds these.</p>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Limited AI ideas
// ---------------------------------------------------------------------------

type IdeaRow = {
  id: string;
  name: string;
  category: string;
  area: string | null;
  why: string | null;
  source_url: string | null;
  status: "unverified" | "confirmed" | "dismissed";
  confirmed_place_url: string | null;
  confirmed_hours: string | null;
  confirmed_minutes: number | null;
  confirmed_price_minor: number | string | null;
  confirmed_by: string | null;
  created_by: string | null;
  version: number;
};

function WhatIsSent({ ctx }: { ctx: TripContext }) {
  const preview = buildGenericRequest({
    destination: ctx.trip.destination,
    startDate: ctx.trip.startDate,
    memberCount: ctx.members.length,
    pace: "balanced",
    interests: [],
    forbiddenWords: ctx.members.flatMap((m) => m.name.split(/\s+/)),
  });
  return (
    <details className="text-sm">
      <summary className="cursor-pointer underline">Exactly what is sent, and what is not</summary>
      <div className="mt-2 flex flex-col gap-2 text-zinc-700 dark:text-zinc-300">
        {preview.ok ? (
          <ul className="list-disc pl-5">
            <li>Destination: {preview.request.destination}</li>
            <li>Season: {preview.request.season} (the month only, never dates)</li>
            <li>Group size: {preview.request.groupSize} people (a range, never names)</li>
            <li>The pace and up to 3 interests you pick below</li>
          </ul>
        ) : (
          <p>{preview.error}</p>
        )}
        <p>
          Never sent: anyone&apos;s budget or anything worked out from budgets, exact dates or the
          itinerary, names, emails, comments, food or health notes, bookings, files, expenses or
          anyone&apos;s preferences. Your own interests are used afterwards, on this server, only to
          sort the ideas.
        </p>
        <p>
          This uses Google&apos;s unpaid Gemini service, which may keep and review what is sent. That
          is why only these generic facts go. Using personal details would need a separately
          reviewed provider and data-processing decision.
        </p>
      </div>
    </details>
  );
}

async function Ideas({ ctx, supabase }: { ctx: TripContext; supabase: Supa }) {
  const config = aiConfig();
  const planner = canPlan(ctx.me.role);
  const [tripRes, ideasRes] = await Promise.all([
    supabase.from("trips").select("ai_ideas_opt_in_at, ai_ideas_opt_in_by").eq("id", ctx.trip.id).maybeSingle(),
    supabase
      .from("ai_suggestions")
      .select("id, name, category, area, why, source_url, status, confirmed_place_url, confirmed_hours, confirmed_minutes, confirmed_price_minor, confirmed_by, created_by, version")
      .eq("trip_id", ctx.trip.id)
      .neq("status", "dismissed")
      .order("created_at", { ascending: false })
      .limit(40),
  ]);
  if (tripRes.error || ideasRes.error) throw new Error("Could not load ideas");
  const optedIn = Boolean(tripRes.data?.ai_ideas_opt_in_at);
  const ideas = (ideasRes.data ?? []) as IdeaRow[];
  const symbol = currencySymbol(ctx.trip.currency);

  return (
    <Card title="Ideas (limited AI)">
      <div className="flex flex-col gap-4">
        {!config.available ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">AI ideas are unavailable.</p>
            <Muted>
              No AI service is set up on this site, so nothing is generated. Add ideas yourself on{" "}
              <Link className="underline" href={`/trips/${ctx.trip.id}/places`}>Saved places</Link> or the{" "}
              <Link className="underline" href={`/trips/${ctx.trip.id}/itinerary`}>Itinerary</Link>.
            </Muted>
          </div>
        ) : !optedIn ? (
          <div className="flex flex-col gap-2">
            <Muted>
              Limited mode: generic ideas for the destination from Google&apos;s unpaid Gemini service.
              It is off until the organiser or a co-planner turns it on for this trip.
            </Muted>
            <WhatIsSent ctx={ctx} />
            {planner && (
              <ActionForm action={setAiOptIn.bind(null, ctx.trip.id, true)}>
                <SubmitButton className={smallPrimaryButton} pendingText="Turning on…">
                  Turn on limited AI ideas
                </SubmitButton>
              </ActionForm>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Muted>
              Limited mode: generic ideas only. Every idea is <span className={unverifiedBadge}>Unverified</span> until a
              member checks the place, opening hours, time needed and price, and confirms them.
              Limits: 5 requests an hour per person on this trip, 20 a day per person, 30 a day per trip.
            </Muted>
            <WhatIsSent ctx={ctx} />
            <ActionForm action={requestIdeas.bind(null, ctx.trip.id)} className="flex flex-col gap-3" ariaLabel="Ask for generic ideas">
              <fieldset className="flex flex-col gap-1">
                <legend className={labelClass}>Pace</legend>
                {PACE_OPTIONS.map((p) => (
                  <label key={p} className="flex items-center gap-2 text-sm">
                    <input type="radio" name="pace" value={p} defaultChecked={p === "balanced"} required />
                    {PACE_LABELS[p]}
                  </label>
                ))}
              </fieldset>
              <fieldset className="flex flex-col gap-1">
                <legend className={labelClass}>Interests (up to 3)</legend>
                <div className="grid grid-cols-3 gap-1 max-md:grid-cols-2">
                  {INTEREST_OPTIONS.map((i) => (
                    <label key={i} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="interests" value={i} />
                      {i}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div>
                <SubmitButton className={smallPrimaryButton} pendingText="Asking…">
                  Get generic ideas
                </SubmitButton>
              </div>
            </ActionForm>
            {planner && (
              <ActionForm action={setAiOptIn.bind(null, ctx.trip.id, false)}>
                <SubmitButton className={smallButton} pendingText="Turning off…">
                  Turn off AI ideas for this trip
                </SubmitButton>
              </ActionForm>
            )}
          </div>
        )}

        {ideas.length > 0 && (
          <ul className="flex flex-col gap-3">
            {ideas.map((idea) => (
              <li key={idea.id} className="flex flex-col gap-1 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {idea.name}
                  {idea.status === "confirmed" ? (
                    <span className={okBadge}>Confirmed by {nameOf(ctx, idea.confirmed_by)}</span>
                  ) : (
                    <span className={unverifiedBadge}>Unverified AI idea</span>
                  )}
                </p>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  {idea.category}
                  {idea.area ? ` · ${idea.area}` : ""}
                  {idea.why ? ` · ${idea.why}` : ""}
                </p>
                {idea.status === "confirmed" ? (
                  <p className="text-sm">
                    Checked: <a className="underline" href={idea.confirmed_place_url!} target="_blank" rel="noopener noreferrer nofollow">place ↗</a>
                    {" · "}hours {idea.confirmed_hours} · about {idea.confirmed_minutes} min ·{" "}
                    {Number(idea.confirmed_price_minor) === 0 ? "free" : `${formatMoney(Number(idea.confirmed_price_minor), ctx.trip.currency)} per person`}
                  </p>
                ) : (
                  <>
                    {idea.source_url && (
                      <p className="text-sm">
                        <a className="underline" href={idea.source_url} target="_blank" rel="noopener noreferrer nofollow ugc">
                          Link suggested by AI (unverified) ↗
                        </a>
                      </p>
                    )}
                    <p className="text-sm text-zinc-500">No price, hours or time is known for this idea yet.</p>
                    <details className="text-sm">
                      <summary className="cursor-pointer underline">I checked it: confirm</summary>
                      <ActionForm action={confirmIdea.bind(null, ctx.trip.id, idea.id, idea.version)} className="mt-2 grid grid-cols-2 gap-3 max-md:grid-cols-1" ariaLabel={`Confirm ${idea.name}`}>
                        <label className={labelClass}>
                          Link where you checked the place
                          <input name="place_url" type="url" required placeholder="https://" className={inputClass} />
                        </label>
                        <label className={labelClass}>
                          Opening hours you checked
                          <input name="hours" required maxLength={120} placeholder="e.g. 09:30-17:30, closed Mon" className={inputClass} />
                        </label>
                        <label className={labelClass}>
                          Time needed (minutes)
                          <input name="minutes" type="number" min={5} max={1440} required className={inputClass} />
                        </label>
                        <label className={labelClass}>
                          Price per person ({symbol}, 0 if free)
                          <input name="price" inputMode="decimal" required className={inputClass} />
                        </label>
                        <label className="col-span-2 flex items-start gap-2 text-sm max-md:col-span-1">
                          <input type="checkbox" name="checked" value="yes" required className="mt-1" />
                          I checked these myself just now; they are not from the AI.
                        </label>
                        <div>
                          <SubmitButton className={smallPrimaryButton} pendingText="Confirming…">
                            Confirm
                          </SubmitButton>
                        </div>
                      </ActionForm>
                    </details>
                  </>
                )}
                {(planner || idea.created_by === ctx.userId) && (
                  <ActionForm action={dismissIdea.bind(null, ctx.trip.id, idea.id, idea.version)}>
                    <SubmitButton className={smallButton} pendingText="…">
                      Set aside
                    </SubmitButton>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Concierge proposals
// ---------------------------------------------------------------------------

type ProposalRow = {
  id: string;
  ops: unknown;
  status: "pending" | "accepted" | "dismissed" | "stale";
  base_plan_version: number;
  created_by: string | null;
  created_at: string;
  decided_by: string | null;
};

async function Concierge({ ctx, supabase }: { ctx: TripContext; supabase: Supa }) {
  const [stopsRes, tripRes, ideasRes, propRes] = await Promise.all([
    supabase
      .from("itinerary_items")
      .select("id, day_number, time, duration_minutes, title, place_url, cost_minor, created_by, version")
      .eq("trip_id", ctx.trip.id)
      .is("variant_id", null),
    supabase.from("trips").select("plan_version").eq("id", ctx.trip.id).maybeSingle(),
    supabase
      .from("ai_suggestions")
      .select("id, name, confirmed_minutes, confirmed_price_minor, confirmed_place_url")
      .eq("trip_id", ctx.trip.id)
      .eq("status", "confirmed"),
    supabase
      .from("concierge_proposals")
      .select("id, ops, status, base_plan_version, created_by, created_at, decided_by")
      .eq("trip_id", ctx.trip.id)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  if (stopsRes.error || tripRes.error || ideasRes.error || propRes.error) throw new Error("Could not load proposals");
  const stops: Stop[] = (stopsRes.data ?? []).map((r) => ({
    id: r.id, day: r.day_number, time: String(r.time).slice(0, 5), duration: r.duration_minutes, title: r.title,
    placeUrl: r.place_url, lat: null, lng: null, costMinor: r.cost_minor === null ? null : Number(r.cost_minor),
    notes: null, createdBy: r.created_by, version: r.version,
  }));
  const ideas: ConfirmedIdea[] = (ideasRes.data ?? []).map((i) => ({
    id: i.id, name: i.name, minutes: i.confirmed_minutes, priceMinor: Number(i.confirmed_price_minor), placeUrl: i.confirmed_place_url,
  }));
  const planVersion = tripRes.data?.plan_version ?? 0;
  const days = tripDays(ctx.trip.startDate, ctx.trip.endDate);
  const maxDay = days ?? Math.min(61, Math.max(0, ...stops.map((s) => s.day)) + 1);
  const proposals = (propRes.data ?? []) as ProposalRow[];
  const pending = proposals.filter((p) => p.status === "pending");
  const decided = proposals.filter((p) => p.status !== "pending").slice(0, 5);
  const sorted = [...stops].sort((a, b) => a.day - b.day || a.time.localeCompare(b.time));

  return (
    <Card title="Concierge: proposed changes">
      <div className="flex flex-col gap-4">
        <Muted>
          Changes to the itinerary are proposed first, shown before and after, and applied only when
          someone allowed to make them presses Accept. If the plan changes in the meantime the
          proposal goes stale and must be made again. In limited mode no AI writes proposals.
        </Muted>

        {pending.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No open proposals.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {pending.map((p) => {
              const parsed = parseOps(p.ops, 61);
              if (!parsed.ok) return null;
              const pv = previewOps(parsed.ops, stops, ideas);
              const stale = p.base_plan_version !== planVersion || pv.problems.length > 0;
              return (
                <li key={p.id} className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                  <p className="text-sm text-zinc-500">Proposed by {nameOf(ctx, p.created_by)}</p>
                  <ul className="list-disc pl-5 text-sm">
                    {pv.lines.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                  {stale && (
                    <p role="note" className="rounded bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                      The plan changed since this was proposed{pv.problems.length ? `: ${pv.problems.join(" ")}` : "."} Accept
                      will not apply it; make it again from the current plan.
                    </p>
                  )}
                  {pv.days.map((d) => (
                    <div key={d.day} className="grid grid-cols-2 gap-3 text-sm max-md:grid-cols-1">
                      <div>
                        <p className="font-medium">Day {d.day} before</p>
                        <ol className="text-zinc-700 dark:text-zinc-300">
                          {d.before.length === 0 ? <li>Nothing planned</li> : d.before.map((s) => <li key={s.id}>{span(s)} {s.title}</li>)}
                        </ol>
                      </div>
                      <div>
                        <p className="font-medium">Day {d.day} after</p>
                        <ol className="text-zinc-700 dark:text-zinc-300">
                          {d.after.length === 0 ? <li>Nothing planned</li> : d.after.map((s) => <li key={s.id}>{span(s)} {s.title}</li>)}
                        </ol>
                      </div>
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-2">
                    <ActionForm action={acceptProposal.bind(null, ctx.trip.id, p.id)}>
                      <SubmitButton className={smallPrimaryButton} pendingText="Applying…">
                        Accept
                      </SubmitButton>
                    </ActionForm>
                    {(canPlan(ctx.me.role) || p.created_by === ctx.userId) && (
                      <ActionForm action={dismissProposal.bind(null, ctx.trip.id, p.id)}>
                        <SubmitButton className={smallButton} pendingText="…">
                          Not now
                        </SubmitButton>
                      </ActionForm>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <details>
          <summary className="cursor-pointer text-sm underline">Propose a change</summary>
          <ActionForm action={proposeChange.bind(null, ctx.trip.id, maxDay)} className="mt-2 grid grid-cols-2 gap-3 max-md:grid-cols-1" ariaLabel="Propose a change">
            <ClientKey />
            <label className={labelClass}>
              Change
              <select name="op" required className={inputClass} defaultValue="move_stop">
                <option value="move_stop">Move a stop</option>
                <option value="remove_stop">Remove a stop</option>
                <option value="add_idea" disabled={ideas.length === 0}>Add a confirmed idea</option>
              </select>
            </label>
            <label className={labelClass}>
              Stop (to move or remove)
              <select name="stop" className={inputClass}>
                <option value="">—</option>
                {sorted.map((s) => (
                  <option key={s.id} value={`${s.id}:${s.version}`}>
                    Day {s.day} {s.time} {s.title}
                  </option>
                ))}
              </select>
            </label>
            <label className={labelClass}>
              Confirmed idea (to add)
              <select name="suggestion_id" className={inputClass}>
                <option value="">—</option>
                {ideas.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className={labelClass}>
                Day
                <select name="day" className={inputClass}>
                  {Array.from({ length: maxDay }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
              <label className={labelClass}>
                Time
                <input name="time" type="time" defaultValue="10:00" className={inputClass} />
              </label>
            </div>
            <div>
              <SubmitButton className={smallPrimaryButton} pendingText="Proposing…">
                Propose
              </SubmitButton>
            </div>
          </ActionForm>
        </details>

        {decided.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer underline">Recently decided</summary>
            <ul className="mt-1 list-disc pl-5 text-zinc-700 dark:text-zinc-300">
              {decided.map((p) => (
                <li key={p.id}>
                  {p.status === "accepted" ? `Accepted by ${nameOf(ctx, p.decided_by)}` : p.status === "stale" ? "Went stale (plan changed)" : `Set aside by ${nameOf(ctx, p.decided_by)}`}
                  {" · "}proposed by {nameOf(ctx, p.created_by)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Card>
  );
}

async function Plans({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await loadTripContext(id);
  const supabase = await createClient();
  const inputs = await loadShapeInputs(supabase, ctx.trip.id);
  if (!inputs) throw new Error("Could not load the trip");
  return (
    <>
      <div className="flex flex-col gap-1">
        <Link href={`/trips/${id}`} className="text-sm text-zinc-600 underline dark:text-zinc-400">
          ← {ctx.trip.name}
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">Plans</h1>
        <Muted>Plan shapes from your real inputs, generic ideas to check, and proposed changes.</Muted>
      </div>
      <Shapes ctx={ctx} supabase={supabase} inputs={inputs} />
      <Ideas ctx={ctx} supabase={supabase} />
      <Concierge ctx={ctx} supabase={supabase} />
    </>
  );
}

export default function PlansPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Shell>
      <Suspense
        fallback={
          <div className="flex flex-col gap-6" aria-busy="true">
            <p className="text-zinc-500">Loading plans…</p>
            <div className="h-32 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-900" />
          </div>
        }
      >
        <Plans params={params} />
      </Suspense>
    </Shell>
  );
}
