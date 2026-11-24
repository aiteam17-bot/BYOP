"use client";

import { useActionState, useSyncExternalStore } from "react";
import { FieldError, inputClass, labelClass, primaryButton } from "@/components/ui";
import { COMMON_TIMEZONES, CURRENCIES } from "@/lib/money";
import { createTrip, type NewTripState } from "./actions";

export function NewTripForm() {
  const [state, action, pending] = useActionState<NewTripState, FormData>(
    createTrip,
    {},
  );
  // Suggest this device's zone; the person still has to confirm the choice.
  const detected = useSyncExternalStore(
    () => () => {},
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => "",
  );
  const zones = detected && !(COMMON_TIMEZONES as readonly string[]).includes(detected)
    ? [detected, ...COMMON_TIMEZONES]
    : [...COMMON_TIMEZONES];

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
      <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
        <label className={labelClass}>
          Trip time zone
          <select name="timezone" required defaultValue="" key={detected} className={inputClass}>
            <option value="" disabled>
              Choose…
            </option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
                {z === detected ? " (this device)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Currency for budgets and prices
          <select name="currency" required defaultValue="" className={inputClass}>
            <option value="" disabled>
              Choose…
            </option>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="-mt-2 text-sm text-zinc-500">
        The currency can&apos;t be changed later: budgets and prices are stored in it.
      </p>
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
