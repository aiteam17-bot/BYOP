"use client";

import { useState, useSyncExternalStore } from "react";
import { smallButton, smallPrimaryButton } from "@/components/ui";
import {
  findLegacyDemoKeys,
  removeLegacyDemoKeys,
  type LegacyFinding,
} from "@/lib/legacy-demo";

type Action =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "removed"; keys: string[] }
  | { kind: "error" };

function readStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // storage blocked (private mode, settings)
  }
}

// Browser storage read as an external store: "checking" on the server,
// then what this browser actually holds. Reads only.
function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}
function snapshot(): string {
  const store = readStorage();
  if (!store) return "unavailable";
  try {
    return JSON.stringify(findLegacyDemoKeys(store));
  } catch {
    return "unavailable";
  }
}

/**
 * Looks for data the old demo prototype left in THIS browser and offers to
 * remove it. Never removes anything on its own, never touches any other key,
 * and never touches your real trips (those live in the database).
 */
export function LegacyDemoCleanup() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => "checking");
  const [action, setAction] = useState<Action>({ kind: "idle" });
  const findings: LegacyFinding[] =
    raw === "checking" || raw === "unavailable" ? [] : (JSON.parse(raw) as LegacyFinding[]);

  function remove() {
    const store = readStorage();
    if (!store) return setAction({ kind: "error" });
    try {
      setAction({ kind: "removed", keys: removeLegacyDemoKeys(store) });
    } catch {
      setAction({ kind: "error" });
    }
  }

  const state =
    action.kind === "removed" || action.kind === "error"
      ? action
      : raw === "checking"
        ? { kind: "checking" as const }
        : raw === "unavailable"
          ? { kind: "unavailable" as const }
          : findings.length === 0
            ? { kind: "none" as const }
            : { kind: "found" as const, findings, confirming: action.kind === "confirming" };

  return (
    <section aria-labelledby="legacy-demo-title" className="flex w-full flex-col gap-3 text-left">
      <h2 id="legacy-demo-title" className="text-base font-semibold text-zinc-950 dark:text-zinc-50">
        Old demo data in this browser
      </h2>
      <div aria-live="polite" className="flex flex-col gap-3 text-sm text-zinc-600 dark:text-zinc-400">
        {state.kind === "checking" && <p>Checking this browser…</p>}
        {state.kind === "unavailable" && <p>This browser does not allow the check, so nothing was read or changed.</p>}
        {state.kind === "none" && <p>None found. Nothing to clean up.</p>}
        {state.kind === "error" && (
          <p role="alert" className="text-red-600 dark:text-red-400">
            The browser did not allow the removal. Nothing else was changed.
          </p>
        )}
        {state.kind === "removed" && (
          <p role="status" className="text-green-700 dark:text-green-400">
            Removed {state.keys.length ? state.keys.join(", ") : "nothing (it was already gone)"}.
          </p>
        )}
        {state.kind === "found" && (
          <>
            <p>
              This browser still holds data from the old demo prototype: the fictional
              &quot;Goa, finally&quot; trip. It is not one of your real trips, and this app
              does not use it.
            </p>
            <ul className="list-disc pl-5">
              {state.findings.map((f) => (
                <li key={f.key}>
                  <code>{f.key}</code> ({f.bytes.toLocaleString("en-IN")} bytes)
                </li>
              ))}
            </ul>
            <p className="font-medium text-amber-800 dark:text-amber-300">
              Removing it cannot be undone. Only the keys listed above are deleted; your
              real trips are stored online and are not affected.
            </p>
            {state.confirming ? (
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={remove} className={smallPrimaryButton}>
                  Yes, remove old demo data
                </button>
                <button
                  type="button"
                  onClick={() => setAction({ kind: "idle" })}
                  className={smallButton}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div>
                <button
                  type="button"
                  onClick={() => setAction({ kind: "confirming" })}
                  className={smallButton}
                >
                  Remove old demo data…
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
