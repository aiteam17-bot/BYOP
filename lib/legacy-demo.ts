// The old front-end-only prototype (a Vite app, run locally) saved its
// fictional "Goa, finally" demo in the browser under exactly these keys. This
// app never writes them. Nothing here runs automatically: the Account page
// only reports what it finds, and removes it when the person asks.
//
// Browsers keep storage per site, so these keys are only visible here if the
// prototype was opened on this same address. On the deployed site that is
// normally never the case and the check finds nothing.

export const LEGACY_DEMO_KEYS = ["group-travel-demo", "__demo_probe__"] as const;

type KeyStore = Pick<Storage, "getItem" | "removeItem">;

export type LegacyFinding = { key: string; bytes: number };

/** Which legacy demo keys exist, and how big they are. Reads only. */
export function findLegacyDemoKeys(store: KeyStore): LegacyFinding[] {
  const found: LegacyFinding[] = [];
  for (const key of LEGACY_DEMO_KEYS) {
    const value = store.getItem(key);
    if (value !== null) found.push({ key, bytes: new Blob([value]).size });
  }
  return found;
}

/** Removes ONLY the legacy demo keys. Returns the keys that were removed. */
export function removeLegacyDemoKeys(store: KeyStore): string[] {
  const removed: string[] = [];
  for (const key of LEGACY_DEMO_KEYS) {
    if (store.getItem(key) !== null) {
      store.removeItem(key);
      removed.push(key);
    }
  }
  return removed;
}
