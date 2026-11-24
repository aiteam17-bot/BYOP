"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

export type ActionState = { error?: string; notice?: string; done?: number };
type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

/**
 * A form bound to a server action, with an error line and a success notice
 * that screen readers announce. Its inputs reset after each success. Buttons
 * inside should be <SubmitButton>, which disables itself while saving so a
 * double tap sends one request (the database is retry-safe either way).
 */
export function ActionForm({
  action,
  children,
  className,
  ariaLabel,
}: {
  action: Action;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <div className="flex flex-col gap-2">
      <form key={state.done ?? 0} action={formAction} className={className} aria-label={ariaLabel}>
        {children}
      </form>
      {state.error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
      <p role="status" className="text-sm text-green-700 empty:hidden dark:text-green-400">
        {!state.error && state.notice ? state.notice : ""}
      </p>
    </div>
  );
}

export function SubmitButton({
  children,
  pendingText,
  className,
  pressed,
  name,
  value,
  ariaLabel,
}: {
  children: ReactNode;
  pendingText?: string;
  className: string;
  pressed?: boolean;
  name?: string;
  value?: string;
  ariaLabel?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending}
      aria-pressed={pressed}
      aria-label={ariaLabel}
      aria-busy={pending || undefined}
      className={className}
    >
      {pending && pendingText ? pendingText : children}
    </button>
  );
}
