import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveController } from "@/lib/live";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("live controller (Realtime as a notification layer)", () => {
  it("refetches after a reconnect, not on a quick first connect", () => {
    const refetch = vi.fn();
    const states: string[] = [];
    let t = 0;
    const live = createLiveController({ refetch, onState: (s) => states.push(s), now: () => t });
    t = 500;
    live.status("SUBSCRIBED");
    expect(refetch).not.toHaveBeenCalled();
    live.status("CHANNEL_ERROR");
    live.status("TIMED_OUT");
    expect(refetch).not.toHaveBeenCalled();
    live.status("SUBSCRIBED");
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["live", "reconnecting", "reconnecting", "live"]);
  });

  it("refetches if the first connection was slow (changes may have been missed)", () => {
    const refetch = vi.fn();
    let t = 0;
    const live = createLiveController({ refetch, now: () => t });
    t = 5000;
    live.status("SUBSCRIBED");
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst of change events into one refetch", () => {
    const refetch = vi.fn();
    const live = createLiveController({ refetch, debounceMs: 400 });
    live.change();
    live.change();
    vi.advanceTimersByTime(300);
    live.change();
    expect(refetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("refetches when the tab becomes visible again", () => {
    const refetch = vi.fn();
    createLiveController({ refetch }).visible();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels a pending refetch", () => {
    const refetch = vi.fn();
    const live = createLiveController({ refetch });
    live.change();
    live.dispose();
    vi.advanceTimersByTime(1000);
    expect(refetch).not.toHaveBeenCalled();
  });
});
