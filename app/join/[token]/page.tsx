import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, Muted, Shell, secondaryButton } from "@/components/ui";
import { createClient } from "@/lib/supabase/server";
import { JoinForm } from "./join-form";

export const metadata = { title: "Join a trip · Group Trip Planner" };

type Preview = {
  trip_id: string;
  name: string;
  destination: string | null;
  already_member: boolean;
};

async function InviteDetails({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data, error } = await supabase.rpc("invite_preview", { _token: token });
  if (error) throw new Error("Could not check this invite link");
  const preview = ((data ?? []) as Preview[])[0];

  if (!preview) {
    return (
      <Card>
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
            This invite link isn&apos;t valid
          </h1>
          <Muted>
            It may have been copied incorrectly. Ask whoever invited you to
            send it again.
          </Muted>
          <div>
            <Link href="/trips" className={secondaryButton}>
              Go to your trips
            </Link>
          </div>
        </div>
      </Card>
    );
  }

  if (preview.already_member) redirect(`/trips/${preview.trip_id}`);

  const defaultName =
    (user.user_metadata?.user_name as string | undefined) ??
    (user.email ?? "").split("@")[0];

  return (
    <>
      <div className="flex flex-col gap-2">
        <Muted>You&apos;re invited to</Muted>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
          {preview.name}
        </h1>
        {preview.destination && <Muted>{preview.destination}</Muted>}
      </div>
      <Card>
        <JoinForm token={token} defaultName={defaultName} />
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
