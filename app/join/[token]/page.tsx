import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, Muted, Shell, secondaryButton } from "@/components/ui";
import { createClient } from "@/lib/supabase/server";
import { JoinForm } from "./join-form";

export const metadata = { title: "Join a trip · Group Trip Planner" };

type Preview =
  | { status: "invalid" | "rate_limited" }
  | {
      status: "valid";
      trip_name: string;
      destination: string | null;
      already_member: boolean;
      expires_at: string;
    };

function Problem({ title, body }: { title: string; body: string }) {
  return (
    <Card>
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">{title}</h1>
        <Muted>{body}</Muted>
        <div>
          <Link href="/trips" className={secondaryButton}>
            Go to your trips
          </Link>
        </div>
      </div>
    </Card>
  );
}

async function InviteDetails({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Shows only the trip's name and destination before you join: never who
  // is on it. Wrong tokens count towards a rate limit.
  const { data, error } = await supabase.rpc("preview_invite", { _token: token });
  if (error) throw new Error("Could not check this invite link");
  const preview = data as Preview;

  if (preview.status === "rate_limited") {
    return (
      <Problem
        title="Too many invite attempts"
        body="Wait 15 minutes, then open the link again."
      />
    );
  }
  if (preview.status !== "valid") {
    return (
      <Problem
        title="This invite link isn't valid"
        body="It may have expired, been revoked, or been copied incorrectly. Ask whoever invited you for a new link."
      />
    );
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError) throw new Error("Could not load your profile");
  const defaultName = profile?.display_name ?? "";

  return (
    <>
      <div className="flex flex-col gap-2">
        <Muted>You&apos;re invited to</Muted>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
          {preview.trip_name}
        </h1>
        {preview.destination && <Muted>{preview.destination}</Muted>}
      </div>
      <Card>
        {preview.already_member ? (
          <div className="flex flex-col gap-4">
            <Muted>You&apos;re already on this trip.</Muted>
            <JoinForm token={token} defaultName={defaultName} alreadyMember />
          </div>
        ) : (
          <JoinForm token={token} defaultName={defaultName} />
        )}
      </Card>
    </>
  );
}

export default function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  return (
    <Shell>
      <Suspense fallback={<Muted>Checking your invite…</Muted>}>
        <InviteDetails params={params} />
      </Suspense>
    </Shell>
  );
}
