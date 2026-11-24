"use client";

import { useActionState } from "react";
import {
  FieldError,
  inputClass,
  labelClass,
  primaryButton,
} from "@/components/ui";
import { CANCELLATION_LABELS } from "@/lib/stay-costs";
import { CANCELLATION_TYPES } from "@/lib/stay-input";
import { addStay, type AddStayState } from "./actions";

export function StayForm({ tripId, today }: { tripId: string; today: string }) {
  const [state, action, pending] = useActionState<AddStayState, FormData>(
    addStay.bind(null, tripId),
    {},
  );
  const errors = state.errors ?? {};

  return (
    // Changing the key after each successful save clears the form.
    <form
      key={state.saved ?? 0}
      action={action}
      className="flex flex-col gap-5"
    >
      <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
        <label className={labelClass}>
          Name
          <input name="name" required maxLength={100} placeholder="Name of the stay" className={inputClass} />
          <FieldError message={errors.name} />
        </label>
        <label className={labelClass}>
          Listing link
          <input name="url" type="url" required placeholder="https://…" className={inputClass} />
          <FieldError message={errors.url} />
        </label>
      </div>

      <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
        <label className={labelClass}>
          Nightly price, whole stay (₹)
          <input name="nightly" required inputMode="decimal" placeholder="Amount in ₹" className={inputClass} />
          <FieldError message={errors.nightly} />
        </label>
        <label className={labelClass}>
          Taxes, total (₹)
          <input name="taxes" inputMode="decimal" placeholder="Amount in ₹ (optional)" className={inputClass} />
          <FieldError message={errors.taxes} />
        </label>
        <label className={labelClass}>
          Fees, total (₹)
          <input name="fees" inputMode="decimal" placeholder="Amount in ₹ (optional)" className={inputClass} />
          <FieldError message={errors.fees} />
        </label>
      </div>
      <p className="-mt-2 text-sm text-zinc-500">
        Enter the price for the whole place, all rooms together. We divide the
        total across everyone on the trip.
      </p>

      <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
        <label className={labelClass}>
          Rooms
          <input name="rooms" required inputMode="numeric" className={inputClass} />
          <FieldError message={errors.rooms} />
        </label>
        <label className={labelClass}>
          Beds
          <input name="beds" required inputMode="numeric" className={inputClass} />
          <FieldError message={errors.beds} />
        </label>
        <label className={labelClass}>
          Distance from main area (km)
          <input name="distance_km" inputMode="decimal" placeholder="km (optional)" className={inputClass} />
          <FieldError message={errors.distance_km} />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
        <label className={labelClass}>
          Cancellation
          <select name="cancellation_type" defaultValue="unknown" className={inputClass}>
            {CANCELLATION_TYPES.map((type) => (
              <option key={type} value={type}>
                {CANCELLATION_LABELS[type]}
              </option>
            ))}
          </select>
          <FieldError message={errors.cancellation_type} />
        </label>
        <label className={labelClass}>
          Price checked on
          <input name="price_checked_on" type="date" required defaultValue={today} max={today} className={inputClass} />
          <FieldError message={errors.price_checked_on} />
        </label>
      </div>

      <label className={labelClass}>
        Map location (optional)
        <input
          name="location"
          placeholder="latitude, longitude"
          autoComplete="off"
          className={inputClass}
        />
        <span className="text-sm font-normal text-zinc-500">
          To get this: on openstreetmap.org or Google Maps, right-click the
          place and copy the coordinates.
        </span>
        <FieldError message={errors.location} />
      </label>

      <label className={labelClass}>
        Cancellation terms (optional)
        <textarea
          name="cancellation_terms"
          rows={2}
          placeholder="Free until 3 days before check-in, then 50% refund"
          className={inputClass}
        />
        <FieldError message={errors.cancellation_terms} />
      </label>

      {state.message && <FieldError message={state.message} />}
      {state.saved ? (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          Stay added.
        </p>
      ) : null}

      <div>
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? "Saving…" : "Add this stay"}
        </button>
      </div>
    </form>
  );
}
