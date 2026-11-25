import { Suspense } from "react";
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import {
  Card,
  Muted,
  Shell,
  inputClass,
  labelClass,
  smallButton,
  smallPrimaryButton,
} from "@/components/ui";
import { canPlan } from "@/lib/decide";
import { currencySymbol, formatMoney } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";
import { loadTripContext, type TripContext } from "@/lib/trip-data";
import { paiseToRupeesString } from "@/lib/validation";
import { ClientKey } from "@/components/client-key";
import {
  clearBudget,
  clearPlanningBounds,
  createCategory,
  deleteCategory,
  saveBudget,
  savePlanningBounds,
  updateCategory,
} from "./actions";

export const metadata = { title: "Budget · Group Trip Planner" };

const SCOPE = "Total per person for the whole trip, including flights";

function AmountFields({ currency, min, max }: { currency: string; min: number | null; max: number | null }) {
  const symbol = currencySymbol(currency);
  return (
    <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
      <label className={labelClass}>
        From ({symbol})
        <input
          name="budget_min"
          required
          inputMode="decimal"
          placeholder={`Amount in ${currency}`}
          defaultValue={paiseToRupeesString(min)}
          className={inputClass}
        />
      </label>
      <label className={labelClass}>
        To ({symbol})
        <input
          name="budget_max"
          required
          inputMode="decimal"
          placeholder={`Amount in ${currency}`}
          defaultValue={paiseToRupeesString(max)}
          className={inputClass}
        />
      </label>
    </div>
  );
}

async function MyRange({ ctx }: { ctx: TripContext }) {
  const supabase = await createClient();
  // RLS returns only your own row.
  const { data, error } = await supabase
    .from("preferences")
    .select("budget_min_paise, budget_max_paise")
    .eq("trip_id", ctx.trip.id)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (error) throw new Error("Could not load your range");
  const min = data?.budget_min_paise === undefined || data?.budget_min_paise === null ? null : Number(data.budget_min_paise);
  const max = data?.budget_max_paise === undefined || data?.budget_max_paise === null ? null : Number(data.budget_max_paise);

  return (
    <Card title="Your private range">
      <div className="flex flex-col gap-4">
        <Muted>
          {SCOPE}, in {ctx.trip.currency}. Only you can see these numbers: not the organiser, not
          anyone else on the trip.
        </Muted>
        <ActionForm action={saveBudget.bind(null, ctx.trip.id)} className="flex flex-col gap-4" ariaLabel="Your budget range">
          <AmountFields currency={ctx.trip.currency} min={min} max={max} />
          <div>
            <SubmitButton className={smallPrimaryButton} pendingText="Saving…">
              {min === null ? "Save my range" : "Update my range"}
            </SubmitButton>
          </div>
        </ActionForm>
        {min !== null && (
          <ActionForm action={clearBudget.bind(null, ctx.trip.id)}>
            <SubmitButton className={smallButton} pendingText="Removing…">
              Remove my range
            </SubmitButton>
          </ActionForm>
        )}
        <p className="text-sm text-zinc-500">You can change it up to 6 times a day.</p>
      </div>
    </Card>
  );
}

function GroupZone({ ctx }: { ctx: TripContext }) {
  const b = ctx.budget;
  return (
    <Card title="Group comfort zone">
      <div className="flex flex-col gap-3">
        {b.status === "insufficient" && (
          <>
            <p className="text-lg text-zinc-950 dark:text-zinc-50">
              {b.respondents} of {b.needed} answers needed
            </p>
            <Muted>
              The comfort zone appears once at least {b.needed} people have added a range. Until then
              nothing about anyone&apos;s numbers is shown.
            </Muted>
          </>
        )}
        {b.status === "no_overlap" && (
          <>
            <p className="text-lg font-medium text-amber-800 dark:text-amber-300">No shared range yet</p>
            <Muted>
              From {b.respondents} answers: at least one person&apos;s maximum is below someone
              else&apos;s minimum. You can privately revisit your own range, or the group can revisit
              the dates or destination. No plan is made up to hide this.
            </Muted>
          </>
        )}
        {b.status === "band" && (
          <>
            <p className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
              {formatMoney(b.low_minor, b.currency)} – {formatMoney(b.high_minor, b.currency)}
            </p>
            <Muted>
              {SCOPE}. Where everyone&apos;s ranges overlap, from {b.respondents} answers, rounded
              outward to the nearest {formatMoney(b.step_minor, b.currency)}.
            </Muted>
          </>
        )}
      </div>
    </Card>
  );
}

function PlanningBounds({ ctx }: { ctx: TripContext }) {
  const { planningMin, planningMax, planningSetBy, planningSetAt, currency } = ctx.trip;
  const setBy = ctx.members.find((m) => m.userId === planningSetBy)?.name ?? "a former member";
  const planner = canPlan(ctx.me.role);
  const smallGroup = ctx.budget.status === "insufficient";
  return (
    <Card title="Planning bounds the group agreed">
      <div className="flex flex-col gap-4">
        {planningMin !== null && planningMax !== null ? (
          <p className="text-zinc-950 dark:text-zinc-50">
            <strong>
              {formatMoney(planningMin, currency)} – {formatMoney(planningMax, currency)}
            </strong>{" "}
            <span className="text-sm text-zinc-500">
              recorded by {setBy}
              {planningSetAt && ` on ${new Date(planningSetAt).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: ctx.trip.timezone })}`}
            </span>
          </p>
        ) : (
          <Muted>None recorded.</Muted>
        )}
        <Muted>
          {smallGroup
            ? "With fewer than 3 private answers there is no comfort zone, so plan within bounds the whole group agreed out loud."
            : "Optional once the comfort zone is showing."}{" "}
          {SCOPE}.
        </Muted>
        {planner ? (
          <>
            <ActionForm action={savePlanningBounds.bind(null, ctx.trip.id)} className="flex flex-col gap-4" ariaLabel="Planning bounds">
              <AmountFields currency={currency} min={planningMin} max={planningMax} />
              <label className="flex items-start gap-2 text-sm text-zinc-800 dark:text-zinc-200">
                <input type="checkbox" name="group_agreed" value="yes" required className="mt-1" />
                The group agreed to these bounds.
              </label>
              <div>
                <SubmitButton className={smallPrimaryButton} pendingText="Saving…">
                  Record bounds
                </SubmitButton>
              </div>
            </ActionForm>
            {planningMin !== null && (
              <ActionForm action={clearPlanningBounds.bind(null, ctx.trip.id)}>
                <SubmitButton className={smallButton} pendingText="Clearing…">
                  Clear bounds
                </SubmitButton>
              </ActionForm>
            )}
          </>
        ) : (
          <p className="text-sm text-zinc-500">The organiser or a co-planner records them.</p>
        )}
      </div>
    </Card>
  );
}

type Category = {
  id: string;
  kind: string;
  label: string;
  planned_per_person_minor: number | string | null;
  notes: string | null;
  version: number;
};

const KIND_LABELS: Record<string, string> = {
  flights: "Flights",
  stay: "Stay",
  local_transport: "Local transport",
  food: "Food",
  activities: "Activities",
  shopping: "Shopping",
  other: "Other",
};

function CategoryFields({ ctx, c }: { ctx: TripContext; c?: Category }) {
  return (
    <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
      <label className={labelClass}>
        Category
        <select name="kind" defaultValue={c?.kind ?? "flights"} className={inputClass}>
          {Object.entries(KIND_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Name
        <input name="label" required maxLength={60} defaultValue={c?.label} className={inputClass} />
      </label>
      <label className={labelClass}>
        Planned per person ({currencySymbol(ctx.trip.currency)})
        <input
          name="planned"
          inputMode="decimal"
          placeholder="Not set"
          defaultValue={paiseToRupeesString(c?.planned_per_person_minor === undefined || c?.planned_per_person_minor === null ? null : Number(c.planned_per_person_minor))}
          className={inputClass}
        />
      </label>
      <label className={`${labelClass} col-span-3 max-md:col-span-1`}>
        Notes (optional)
        <input name="notes" maxLength={1000} defaultValue={c?.notes ?? ""} className={inputClass} />
      </label>
    </div>
  );
}

async function Categories({ ctx }: { ctx: TripContext }) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("budget_categories")
    .select("id, kind, label, planned_per_person_minor, notes, version")
    .eq("trip_id", ctx.trip.id)
    .order("created_at");
  if (error) throw new Error("Could not load budget categories");
  const cats = (data ?? []) as Category[];
  const planner = canPlan(ctx.me.role);
  const planned = cats.reduce((sum, c) => sum + (c.planned_per_person_minor === null ? 0 : Number(c.planned_per_person_minor)), 0);
  const unset = cats.filter((c) => c.planned_per_person_minor === null).length;
  const b = ctx.budget;
  const low = b.status === "band" ? b.low_minor : ctx.trip.planningMin;
  const high = b.status === "band" ? b.high_minor : ctx.trip.planningMax;
  const against = b.status === "band" ? "the comfort zone" : "the agreed planning bounds";
  return (
    <Card title="Planned costs by category">
      <div className="flex flex-col gap-4">
        <Muted>
          Planned cost per person for the whole trip, by category. These are the group&apos;s plan, not anyone&apos;s private range.
        </Muted>
        {cats.length === 0 ? (
          <p className="text-sm text-zinc-500">No categories yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
            {cats.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium text-zinc-950 dark:text-zinc-50">
                    {c.label} <span className="text-sm font-normal text-zinc-500">({KIND_LABELS[c.kind]})</span>
                  </span>
                  <span className="tabular-nums">
                    {c.planned_per_person_minor === null ? "Not set" : formatMoney(Number(c.planned_per_person_minor), ctx.trip.currency)}
                  </span>
                </div>
                {c.notes && <p className="text-sm text-zinc-600 dark:text-zinc-400">{c.notes}</p>}
                {planner && (
                  <details>
                    <summary className="cursor-pointer text-sm underline">Edit</summary>
                    <ActionForm action={updateCategory.bind(null, ctx.trip.id, c.id)} className="mt-2 flex flex-col gap-3" ariaLabel={`Edit ${c.label}`}>
                      <input type="hidden" name="expected_version" value={c.version} />
                      <CategoryFields ctx={ctx} c={c} />
                      <div className="flex flex-wrap gap-2">
                        <SubmitButton className={smallPrimaryButton} pendingText="Saving…">
                          Save
                        </SubmitButton>
                      </div>
                    </ActionForm>
                    <ActionForm action={deleteCategory.bind(null, ctx.trip.id, c.id, c.version)} className="mt-2">
                      <SubmitButton className={smallButton} pendingText="Deleting…">
                        Delete category
                      </SubmitButton>
                    </ActionForm>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        {cats.length > 0 && (
          <p className="text-zinc-950 dark:text-zinc-50">
            Planned total: <strong>{formatMoney(planned, ctx.trip.currency)}</strong> per person
            {unset > 0 && ` (${unset} categor${unset === 1 ? "y" : "ies"} not set)`}
            {low !== null && high !== null && (
              <span className="block text-sm text-zinc-600 dark:text-zinc-400">
                {planned < low ? "Below" : planned > high ? "Above" : "Inside"} {against} ({formatMoney(low, ctx.trip.currency)} –{" "}
                {formatMoney(high, ctx.trip.currency)}).
              </span>
            )}
          </p>
        )}
        {planner ? (
          <details>
            <summary className="cursor-pointer text-sm underline">Add a category</summary>
            <ActionForm action={createCategory.bind(null, ctx.trip.id)} className="mt-2 flex flex-col gap-3" ariaLabel="Add a budget category">
              <ClientKey />
              <CategoryFields ctx={ctx} />
              <div>
                <SubmitButton className={smallPrimaryButton} pendingText="Adding…">
                  Add category
                </SubmitButton>
              </div>
            </ActionForm>
          </details>
        ) : (
          <p className="text-sm text-zinc-500">The organiser or a co-planner sets these.</p>
        )}
      </div>
    </Card>
  );
}

function HowPrivate() {
  return (
    <details className="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 max-md:p-4">
      <summary className="cursor-pointer text-base font-semibold text-zinc-950 dark:text-zinc-50">
        How private is this?
      </summary>
      <div className="mt-3 flex flex-col gap-2">
        <p>
          <strong>Protected:</strong> your numbers are stored in a row only you can read. The
          organiser cannot see them, and nothing in the app shows, logs or exports anyone&apos;s
          numbers. The group sees only the count of answers and, from 3 answers, the overlap
          rounded to a step. Nobody can ask for a sub-group or &quot;everyone except one
          person&quot;.
        </p>
        <p>
          <strong>Not perfect anonymity:</strong> in a small group people can still work things
          out. If exactly 3 people answer, each of them knows the other two shaped the band. If the
          band moves right after one person joins, leaves or edits, others may guess that
          person&apos;s range was at an edge. Repeatedly editing your own range to probe others is
          slowed by the 6-a-day limit and by rounding, not prevented. Share your range only if
          you&apos;re comfortable with that.
        </p>
      </div>
    </details>
  );
}

async function Budget({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await loadTripContext(id);
  return (
    <>
      <div className="flex flex-col gap-1">
        <Link href={`/trips/${id}`} className="text-sm text-zinc-600 underline dark:text-zinc-400">
          ← {ctx.trip.name}
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">Budget</h1>
        <Muted>Private ranges, one shared comfort zone.</Muted>
      </div>
      <MyRange ctx={ctx} />
      <GroupZone ctx={ctx} />
      <PlanningBounds ctx={ctx} />
      <Categories ctx={ctx} />
      <HowPrivate />
    </>
  );
}

export default function BudgetPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Shell>
      <Suspense
        fallback={
          <div className="flex flex-col gap-6" aria-busy="true">
            <p className="text-zinc-500">Loading budget…</p>
            <div className="h-32 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-900" />
          </div>
        }
      >
        <Budget params={params} />
      </Suspense>
    </Shell>
  );
}
