import Link from "next/link";
import { Card, Muted, Shell } from "@/components/ui";
import { NewTripForm } from "./new-trip-form";

export const metadata = { title: "Start a trip · Group Trip Planner" };

export default function NewTripPage() {
  return (
    <Shell>
      <Link href="/trips" className="text-sm text-zinc-600 underline dark:text-zinc-400">
        ← Your trips
      </Link>
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
          Start a trip
        </h1>
        <Muted>
          You&apos;ll get an invite link to send to your friends right after.
        </Muted>
      </div>
      <Card>
        <NewTripForm />
      </Card>
    </Shell>
  );
}
