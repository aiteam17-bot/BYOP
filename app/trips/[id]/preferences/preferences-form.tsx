"use client";

import { useActionState } from "react";
import {
  FieldError,
  inputClass,
  labelClass,
  primaryButton,
} from "@/components/ui";
import {
  INTEREST_OPTIONS,
  PACE_LABELS,
  PACE_OPTIONS,
  paiseToRupeesString,
} from "@/lib/validation";
import { savePreferences, type PreferencesState } from "./actions";

export type PreferenceDefaults = {
  budget_min_paise: number | null;
  budget_max_paise: number | null;
  pace: string | null;
  interests: string[];
  food_notes: string | null;
  must_see: string | null;
  avoid: string | null;
};

export function PreferencesForm({
  tripId,
  defaults,
}: {
  tripId: string;
  defaults: PreferenceDefaults;
}) {
  const [state, action, pending] = useActionState<PreferencesState, FormData>(
    savePreferences.bind(null, tripId),
    {},
  );
  const errors = state.errors ?? {};

  const known = INTEREST_OPTIONS as readonly string[];
  const otherInterests = defaults.interests
    .filter((i) => !known.includes(i))
    .join(", ");

  return (
    <form action={action} className="flex flex-col gap-8">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-base font-semibold text-zinc-950 dark:text-zinc-50">
          Budget range (in rupees, for the whole trip, per person)
        </legend>
        <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
          <label className={labelClass}>
            From (₹)
            <input
              name="budget_min"
              inputMode="decimal"
              placeholder="10000"
              defaultValue={paiseToRupeesString(defaults.budget_min_paise)}
              className={inputClass}
            />
            <FieldError message={errors.budget_min} />
          </label>
          <label className={labelClass}>
            To (₹)
            <input
              name="budget_max"
              inputMode="decimal"
              placeholder="25000"
              defaultValue={paiseToRupeesString(defaults.budget_max_paise)}
              className={inputClass}
            />
            <FieldError message={errors.budget_max} />
          </label>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-base font-semibold text-zinc-950 dark:text-zinc-50">
          Pace
        </legend>
        {PACE_OPTIONS.map((option) => (
          <label
            key={option}
            className="flex items-center gap-3 text-base text-zinc-800 dark:text-zinc-200"
          >
            <input
              type="radio"
              name="pace"
              value={option}
              defaultChecked={defaults.pace === option}
              className="h-4 w-4"
            />
            {PACE_LABELS[option]}
          </label>
        ))}
        <FieldError message={errors.pace} />
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-base font-semibold text-zinc-950 dark:text-zinc-50">
          Interests
        </legend>
        <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
          {INTEREST_OPTIONS.map((option) => (
            <label
              key={option}
              className="flex items-center gap-3 text-base text-zinc-800 dark:text-zinc-200"
            >
              <input
                type="checkbox"
                name="interests"
                value={option}
                defaultChecked={defaults.interests.includes(option)}
                className="h-4 w-4"
              />
              {option}
            </label>
          ))}
        </div>
        <label className={labelClass}>
          Anything else? (separate with commas)
          <input
            name="interests_other"
            defaultValue={otherInterests}
            placeholder="Scuba diving, street photography"
            className={inputClass}
          />
        </label>
        <FieldError message={errors.interests} />
      </fieldset>

      <label className={labelClass}>
        Food needs
        <textarea
          name="food_notes"
          rows={3}
          defaultValue={defaults.food_notes ?? ""}
          placeholder="Vegetarian, no peanuts, Jain options…"
          className={inputClass}
        />
        <FieldError message={errors.food_notes} />
      </label>

      <label className={labelClass}>
        Must-sees
        <textarea
          name="must_see"
          rows={3}
          defaultValue={defaults.must_see ?? ""}
          placeholder="Places or experiences you don't want to miss"
          className={inputClass}
        />
        <FieldError message={errors.must_see} />
      </label>

      <label className={labelClass}>
        Things to avoid
        <textarea
          name="avoid"
          rows={3}
          defaultValue={defaults.avoid ?? ""}
          placeholder="Crowds, long drives, early mornings…"
          className={inputClass}
        />
        <FieldError message={errors.avoid} />
      </label>

      {state.message && <FieldError message={state.message} />}

      <div>
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? "Saving…" : "Save my card"}
        </button>
      </div>
    </form>
  );
}
