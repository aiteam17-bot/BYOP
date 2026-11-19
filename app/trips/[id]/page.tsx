import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card, Muted, Shell, inputClass, primaryButton } from "@/components/ui";
import { getOrigin } from "@/lib/site";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";
import { CopyButton } from "./copy-button";

type Member = {
  user_id: string;
  display_name: string;
  role: string;
  has_answered: boolean;
};

async function TripDetails({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Row-level security means this returns nothing unless you belong to the trip.
  const { data: trip } = await supabase
    .from("trips")
    .select("id, name, destination, invite_token")
    .eq("id", id)
    .maybeSingle();
  if (!trip) notFound();

  // Names and an answered yes/no only. Nobody's actual answers come back.
  const { data: rows } = await supabase.rpc("trip_response_status", {
    _trip_id: id,
  });
  const members = (rows ?? []) as Member[];
  const me = members.find((m) => m.user_id === user.id);
  const answeredCount = members.filter((m) => m.has_answered).length;

  const inviteUrl = `${await getOrigin()}/join/${trip.invite_token}`;

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
          {trip.name}
        </h1>
        {trip.destination && <Muted>{trip.destination}</Muted>}
      </div>

      <div className="grid grid-cols-2 gap-6 max-md:grid-cols-1">
        <Card title="Invite your friends">
          <div className="flex flex-col gap-3">
            <Muted>
              Send this link. Anyone who opens it and signs in can join.
            </Muted>
            <input
              readOnly
              value={inviteUrl}
              aria-label="Invite link"
              onFocus={(e) => e.currentTarget.select()}
              className={inputClass}
            />
            <div>
              <CopyButton value={inviteUrl} />
            </div>
          </div>
        </Card>

        <Card title="Your preference card">
          <div className="flex flex-col gap-3">
            <Muted>
              Tell us your budget, pace and must-sees. Only you can see your
              answers.
            </Muted>
            <div>
              <Link href={`/trips/${id}/preferences`} className={primaryButton}>
                {me?.has_answered ? "Edit your answers" : "Fill in your card"}
              </Link>
            </div>
          </div>
        </Card>
      </div>

      <Card title="Stays">
        <div className="flex flex-col gap-3">
          <Muted>
            Paste in places to stay and compare the true cost per person.
          </Muted>
          <div>
            <Link href={`/trips/${id}/stays`} className={primaryButton}>
              Compare stays
            </Link>
          </div>
        </div>
      </Card>

      <Card title={`Who has answered (${answeredCount} of ${members.length})`}>
        <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
          {members.map((m) => (
            <li
              key={m.user_id}
              className="flex items-center justify-between gap-4 py-3"
            >
              <span className="text-zinc-950 dark:text-zinc-50">
                {m.display_name}
                {m.role === "owner" && (
                  <span className="ml-2 text-sm text-zinc-500">organiser</span>
                )}
                {m.user_id === user.id && (
                  <span className="ml-2 text-sm text-zinc-500">you</span>
                )}
              </span>
              <span
                className={
                  m.has_answered
                    ? "text-sm font-medium text-green-700 dark:text-green-400"
                    : "text-sm text-zinc-500"
                }
              >
                {m.has_answered ? "Answered" : "Waiting"}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-zinc-500">
          You can see who has answered, never what they said. Everyone&apos;s
          answers stay private, including from the organiser.
        </p>
      </Card>
    </>
  );
}

export default function TripPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Shell>
      <Link href="/trips" className="text-sm text-zinc-600 underline dark:text-zinc-400">
        ← Your trips
      </Link>
      <Suspense fallback={<Muted>Loading trip…</Muted>}>
        <TripDetails params={params} />
      </Suspense>
    </Shell>
  );
}
