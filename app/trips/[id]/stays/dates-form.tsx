"use client";

import { useActionState } from "react";
import { FieldError, inputClass, labelClass, primaryButton } from "@/components/ui";
import { setTripDates, type DatesState } from "./actions";

export function DatesForm({
  tripId,
  start,
  end,
}: {
  tripId: string;
  start: string | null;
  end: string | null;
}) {
  const [state, action, pending] = useActionState<DatesState, FormData>(
    setTripDates.bind(null, tripId),
    {},
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
        <label className={labelClass}>
          Check-in
          <input name="start_date" type="date" required defaultValue={start ?? ""} className={inputClass} />
        </label>
        <label className={labelClass}>
          Check-out
          <input name="end_date" type="date" required defaultValue={end ?? ""} className={inputClass} />
        </label>
      </div>
      <FieldError message={state.error} />
      {state.saved && (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          Dates saved.
        </p>
      )}
      <div>
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? "Saving…" : "Save dates"}
        </button>
      </div>
    </form>
  );
}
