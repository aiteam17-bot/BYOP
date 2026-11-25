// Realtime is a notification layer: it says "something changed", and the app
// then refetches from the database (the source of truth). This controller
// decides WHEN to refetch. Pure, so it is unit-tested.

export type ChannelStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";
export type LiveState = "connecting" | "live" | "reconnecting";

export function createLiveController(options: {
  refetch: () => void;
  onState?: (state: LiveState) => void;
  debounceMs?: number;
  /** If the first subscription takes longer than this, refetch: changes may have been missed. */
  slowStartMs?: number;
  now?: () => number;
}) {
  const debounceMs = options.debounceMs ?? 400;
  const slowStartMs = options.slowStartMs ?? 3000;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  let everSubscribed = false;
  let lost = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function scheduleRefetch() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      options.refetch();
    }, debounceMs);
  }

  return {
    /** Feed every channel status here. */
    status(status: ChannelStatus) {
      if (status === "SUBSCRIBED") {
        const missedSomething = everSubscribed ? lost : now() - startedAt > slowStartMs;
        everSubscribed = true;
        lost = false;
        options.onState?.("live");
        if (missedSomething) options.refetch(); // reconnect: reload from the database
      } else {
        lost = true;
        options.onState?.(everSubscribed ? "reconnecting" : "connecting");
      }
    },
    /** A row changed somewhere in this trip. Bursts are coalesced. */
    change() {
      scheduleRefetch();
    },
    /** The tab became visible again: events may have been missed while hidden. */
    visible() {
      options.refetch();
    },
    dispose() {
      if (timer) clearTimeout(timer);
    },
  };
}
