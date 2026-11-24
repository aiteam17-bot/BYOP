import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card, Muted, Shell } from "@/components/ui";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";
import { PreferencesForm, type PreferenceDefaults } from "./preferences-form";

export const metadata = { title: "Your preference card · Group Trip Planner" };

async function CardEditor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: trip, error: tripError } = await supabase
    .from("trips")
    .select("id, name")
    .eq("id", id)
    .maybeSingle();
  if (tripError) throw new Error("Could not load this trip");
  if (!trip) notFound();

  // You can only ever read your own row, so this can't return anyone else's.
  const { data: existing, error: existingError } = await supabase
    .from("preferences")
    .select(
      "budget_min_paise, budget_max_paise, pace, interests, food_notes, must_see, avoid",
    )
    .eq("trip_id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  // Never show a blank form after a failed read: saving it would overwrite
  // the answers you already gave.
  if (existingError) throw new Error("Could not load your answers");

  const defaults: PreferenceDefaults = {
    budget_min_paise: existing?.budget_min_paise ?? null,
    budget_max_paise: existing?.budget_max_paise ?? null,
    pace: existing?.pace ?? null,
    interests: existing?.interests ?? [],
    food_notes: existing?.food_notes ?? null,
    must_see: existing?.must_see ?? null,
    avoid: existing?.avoid ?? null,
  };

  return (
    <>
      <Link
        href={`/trips/${id}`}
        className="text-sm text-zinc-600 underline dark:text-zinc-400"
      >
        ← {trip.name}
      </Link>
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
          Your preference card
        </h1>
        <Muted>
          Private: only you can see these answers. Others will just see that
          you&apos;ve answered. Fill in as much or as little as you like.
        </Muted>
      </div>
      <Card>
        <PreferencesForm tripId={id} defaults={defaults} />
      </Card>
    </>
  );
}

export default function PreferencesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Shell>
      <Suspense fallback={<Muted>Loading your card…</Muted>}>
        <CardEditor params={params} />
      </Suspense>
    </Shell>
  );
}
