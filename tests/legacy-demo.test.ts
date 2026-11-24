import { describe, expect, it } from "vitest";
import { LEGACY_DEMO_KEYS, findLegacyDemoKeys, removeLegacyDemoKeys } from "@/lib/legacy-demo";

// A stand-in for window.localStorage (test fixture only).
function memoryStore(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    removeItem: (k: string) => void data.delete(k),
    keys: () => [...data.keys()].sort(),
  };
}

describe("legacy demo storage cleanup", () => {
  it("targets only the prototype's own keys", () => {
    expect(LEGACY_DEMO_KEYS).toEqual(["group-travel-demo", "__demo_probe__"]);
  });

  it("finding reads but never removes", () => {
    const store = memoryStore({ "group-travel-demo": '{"schemaVersion":3}', other: "keep" });
    expect(findLegacyDemoKeys(store)).toEqual([{ key: "group-travel-demo", bytes: 19 }]);
    expect(store.keys()).toEqual(["group-travel-demo", "other"]);
  });

  it("removal deletes only legacy keys and leaves everything else", () => {
    const store = memoryStore({
      "group-travel-demo": "{}",
      __demo_probe__: "1",
      "sb-bbq-auth-token": "session",
      other: "keep",
    });
    expect(removeLegacyDemoKeys(store)).toEqual(["group-travel-demo", "__demo_probe__"]);
    expect(store.keys()).toEqual(["other", "sb-bbq-auth-token"]);
  });

  it("is a no-op when nothing is there", () => {
    const store = memoryStore({ other: "keep" });
    expect(findLegacyDemoKeys(store)).toEqual([]);
    expect(removeLegacyDemoKeys(store)).toEqual([]);
    expect(store.keys()).toEqual(["other"]);
  });
});
