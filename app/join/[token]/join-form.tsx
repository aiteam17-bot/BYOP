"use client";

import { useActionState } from "react";
import { FieldError, inputClass, labelClass, primaryButton } from "@/components/ui";
import { joinTrip, type JoinState } from "./actions";

export function JoinForm({
  token,
  defaultName,
  alreadyMember = false,
}: {
  token: string;
  defaultName: string;
  alreadyMember?: boolean;
}) {
  const [state, action, pending] = useActionState<JoinState, FormData>(
    joinTrip.bind(null, token),
    {},
  );

  return (
    <form action={action} className="flex flex-col gap-5">
      {!alreadyMember && (
      <label className={labelClass}>
        Your name (so friends know who you are)
        <input
          name="display_name"
          defaultValue={defaultName}
          maxLength={60}
          className={inputClass}
        />
      </label>
      )}
      <FieldError message={state.error} />
      <div>
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? "Opening…" : alreadyMember ? "Open the trip" : "Join this trip"}
        </button>
      </div>
    </form>
  );
}
