"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createLiveController, type ChannelStatus, type LiveState } from "@/lib/live";
import { createClient } from "@/lib/supabase/client";

// Tables whose changes mean "refetch". Private preferences are never here
// (and are not in the Realtime publication either).
const WATCHED = [
  "itinerary_items",
  "stop_comments",
  "stop_votes",
  "saved_lists",
  "saved_places",
  "plan_variants",
  "stay_quotes",
  "stay_quote_votes",
  "budget_categories",
] as const;

// Presence carries only who and which stop. Never budgets or preferences.
type Presence = { user_id: string; name: string; editing: string | null };

type LiveContext = {
  state: LiveState;
  editors: (itemId: string) => string[];
  setEditing: (itemId: string | null) => void;
};

const Ctx = createContext<LiveContext>({ state: "connecting", editors: () => [], setEditing: () => {} });

export function useLive() {
  return useContext(Ctx);
}

export function LiveTrip({
  tripId,
  userId,
  displayName,
  children,
}: {
  tripId: string;
  userId: string;
  displayName: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [state, setState] = useState<LiveState>("connecting");
  const [others, setOthers] = useState<Presence[]>([]);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const editingRef = useRef<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    const live = createLiveController({ refetch: () => router.refresh(), onState: setState });
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      // Private channel: the database only lets members of this trip join.
      await supabase.realtime.setAuth();
      if (cancelled) return;
      channel = supabase.channel(`trip:${tripId}`, {
        config: { private: true, presence: { key: userId } },
      });
      for (const table of WATCHED) {
        channel.on(
          "postgres_changes",
          { event: "*", schema: "public", table, filter: `trip_id=eq.${tripId}` },
          () => live.change(),
        );
      }
      channel.on("presence", { event: "sync" }, () => {
        const all = Object.values(channel!.presenceState<Presence>()).flat();
        setOthers(all.filter((p) => p.user_id !== userId));
      });
      channel.subscribe((status) => {
        live.status(status as ChannelStatus);
        if (status === "SUBSCRIBED") {
          void channel!.track({ user_id: userId, name: displayName, editing: editingRef.current });
        }
      });
      channelRef.current = channel;
    })();

    const onVisible = () => {
      if (document.visibilityState === "visible") live.visible();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      live.dispose();
      document.removeEventListener("visibilitychange", onVisible);
      if (channel) void supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [tripId, userId, displayName, router]);

  const setEditing = useCallback(
    (itemId: string | null) => {
      editingRef.current = itemId;
      void channelRef.current?.track({ user_id: userId, name: displayName, editing: itemId });
    },
    [userId, displayName],
  );

  const value = useMemo<LiveContext>(
    () => ({
      state,
      editors: (itemId) => others.filter((p) => p.editing === itemId).map((p) => p.name),
      setEditing,
    }),
    [state, others, setEditing],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** "Live" / "Reconnecting…" line. The page always works without it. */
export function LiveStatus() {
  const { state } = useLive();
  const text =
    state === "live"
      ? "Live: changes from others appear automatically."
      : state === "reconnecting"
        ? "Reconnecting… the page reloads the latest data when the connection is back."
        : "Connecting for live updates…";
  return (
    <p role="status" className="text-sm text-zinc-500">
      {text}
    </p>
  );
}

/** "Asha is editing this" for one stop (names only, from presence). */
export function EditingMarker({ itemId }: { itemId: string }) {
  const names = useLive().editors(itemId);
  if (names.length === 0) return null;
  return (
    <p className="text-sm font-medium text-indigo-700 dark:text-indigo-300">
      {names.join(", ")} {names.length === 1 ? "is" : "are"} editing this now
    </p>
  );
}

/** A <details> that tells others you are editing this stop while it is open. */
export function EditDetails({ itemId, summary, children }: { itemId: string; summary: ReactNode; children: ReactNode }) {
  const { setEditing } = useLive();
  return (
    <details
      className="w-full"
      onToggle={(e) => setEditing((e.currentTarget as HTMLDetailsElement).open ? itemId : null)}
    >
      <summary className="cursor-pointer text-sm text-zinc-700 underline dark:text-zinc-300">{summary}</summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}
