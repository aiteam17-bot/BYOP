"use client";

import { LoadError } from "@/components/load-error";

export default function TripError({ retry }: { error: unknown; retry: () => void }) {
  return <LoadError title="We couldn't load this trip" retry={retry} />;
}
