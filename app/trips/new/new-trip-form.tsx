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
      <FieldError message={state.error} />
      <div>
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? "Creating…" : "Create trip"}
        </button>
      </div>
    </form>
  );
}
