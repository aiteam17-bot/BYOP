"use client";

import { useActionState } from "react";
import { FieldError, inputClass, labelClass, primaryButton } from "@/components/ui";
import { createTrip, type NewTripState } from "./actions";

export function NewTripForm() {
  const [state, action, pending] = useActionState<NewTripState, FormData>(
    createTrip,
    {},
  );

  return (
    <form action={action} className="flex flex-col gap-5">
      <label className={labelClass}>
        Trip name
        <input
          name="name"
          required
          maxLength={80}
          placeholder="Goa with the gang"
          className={inputClass}
        />
      </label>
      <label className={labelClass}>
        Destination (optional)
        <input
          name="destination"
          maxLength={80}
          placeholder="Goa, India"
          className={inputClass}
        />
      </label>
      <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
        <label className={labelClass}>
          Check-in (optional)
          <input name="start_date" type="date" className={inputClass} />
        </label>
        <label className={labelClass}>
          Check-out (optional)
          <input name="end_date" type="date" className={inputClass} />
        </label>
      </div>
      <p className="-mt-2 text-sm text-zinc-500">
        Dates let us work out each stay&apos;s true cost per person. You can add
        them later.
      </p>
      <FieldError message={state.error} />
      <div>
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? "Creating…" : "Create trip"}
        </button>
      </div>
    </form>
  );
}
