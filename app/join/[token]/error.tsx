"use client";

import { LoadError } from "@/components/load-error";

export default function JoinError({ retry }: { error: unknown; retry: () => void }) {
  return <LoadError title="We couldn't check this invite link" retry={retry} />;
}
