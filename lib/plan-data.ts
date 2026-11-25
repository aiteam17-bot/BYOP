// Reads what Tight / Balanced / Splurge are built from, as the signed-in
// member (row-level security applies). Shared by the Plans page and actions.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ShapeInputs } from "@/lib/plan-shapes";
import type { PricingBasis } from "@/lib/quotes";

const num = (v: number | string | null) => (v === null ? null : Number(v));

export async function loadShapeInputs(supabase: SupabaseClient, tripId: string): Promise<ShapeInputs | null> {
  const [tripRes, quotesRes, catsRes, stopsRes] = await Promise.all([
    supabase
      .from("trips")
      .select("currency, start_date, end_date, planning_budget_min_minor, planning_budget_max_minor, planning_bounds_set_at")
      .eq("id", tripId)
      .maybeSingle(),
    supabase
      .from("stay_quotes")
      .select(
        "id, name, pricing_basis, currency, quoted_amount_minor, nights, rooms, taxes_minor, fees_minor, sharers, fx_rate_micros, fx_rate_date, fx_source, transport_estimate_per_person_minor, version",
      )
      .eq("trip_id", tripId),
    supabase.from("budget_categories").select("id, version, kind, label, planned_per_person_minor").eq("trip_id", tripId).order("created_at"),
    supabase.from("itinerary_items").select("cost_minor").eq("trip_id", tripId).is("variant_id", null).not("cost_minor", "is", null),
  ]);
  if (tripRes.error) throw new Error("Could not load the trip");
  if (quotesRes.error || catsRes.error || stopsRes.error) throw new Error("Could not load the plan inputs");
  const t = tripRes.data;
  if (!t) return null;
  const min = num(t.planning_budget_min_minor);
  const max = num(t.planning_budget_max_minor);
  return {
    currency: t.currency,
    startDate: t.start_date,
    endDate: t.end_date,
    bounds: min !== null && max !== null ? { min, max, setAt: t.planning_bounds_set_at } : null,
    quotes: quotesRes.data.map((r) => ({
      id: r.id,
      name: r.name,
      pricingBasis: r.pricing_basis as PricingBasis,
      currency: r.currency,
      quotedAmountMinor: Number(r.quoted_amount_minor),
      nights: r.nights,
      rooms: r.rooms,
      taxesMinor: num(r.taxes_minor),
      feesMinor: num(r.fees_minor),
      sharers: r.sharers,
      fxRateMicros: num(r.fx_rate_micros),
      fxRateDate: r.fx_rate_date,
      fxSource: r.fx_source,
      transportEstimatePerPersonMinor: num(r.transport_estimate_per_person_minor),
      version: r.version,
    })),
    categories: catsRes.data.map((c) => ({
      id: c.id,
      version: c.version,
      kind: c.kind,
      label: c.label,
      plannedPerPersonMinor: num(c.planned_per_person_minor),
    })),
    stopCostsMinor: stopsRes.data.map((s) => Number(s.cost_minor)),
  };
}
