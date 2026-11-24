"use client";

import { LoadError } from "@/components/load-error";

export default function TripsError({ retry }: { error: unknown; retry: () => void }) {
  return <LoadError title="We couldn't load your trips" retry={retry} backHref="/account" backLabel="Your account" />;
}
