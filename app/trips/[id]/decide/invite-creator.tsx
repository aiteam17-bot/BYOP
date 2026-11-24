"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/action-form";
import { inputClass, smallPrimaryButton } from "@/components/ui";
import { CopyButton } from "../copy-button";
import { createInviteLink, type InviteState } from "./actions";

// Makes a new invite link and shows it ONCE. Only a hash is stored, so the
// link cannot be shown again later: make a new one instead.
export function InviteCreator({ tripId }: { tripId: string }) {
  const [state, action] = useActionState<InviteState, FormData>(createInviteLink.bind(null, tripId), {});
  return (
    <div className="flex flex-col gap-3">
      <form action={action} className="flex flex-wrap items-end gap-3" aria-label="Create an invite link">
        <label className="flex flex-col gap-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-200">
          Link lasts
          <select
            name="days"
            defaultValue="7"
            className="min-h-11 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="1">1 day</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
          </select>
        </label>
        <SubmitButton className={smallPrimaryButton} pendingText="Creating…">
          Create invite link
        </SubmitButton>
      </form>
      {state.error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
      {state.link && (
        <div role="status" className="flex flex-col gap-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            Copy it now and send it to your friends. For safety it won&apos;t be shown again.
            {state.expiresAt && ` It works until ${new Date(state.expiresAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}.`}
          </p>
          <input readOnly value={state.link} aria-label="New invite link" className={inputClass} />
          <div>
            <CopyButton value={state.link} />
          </div>
        </div>
      )}
    </div>
  );
}
