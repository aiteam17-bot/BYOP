"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/action-form";
import { parseQuoteForm } from "@/lib/quote-input";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";

// Quotes are written only through create_quote / update_quote / delete_quote /
// vote_quote, which check membership, authorship and the version, validate
// again and run as one transaction. Voting books nothing.

const SAFE = new Set(["42501", "22023", "P0002", "40001"]);

async function db() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return supabase;
}

async function finish(
  tripId: string,
  prev: ActionState,
  result: PromiseLike<{ error: { code?: string; message: string } | null }>,
  notice?: string,
): Promise<ActionState> {
  const { error } = await result;
  if (error) {
    if (error.code === "40001") revalidatePath(`/trips/${tripId}`, "layout");
    return { error: error.code && SAFE.has(error.code) ? error.message : "That didn't work. Please try again." };
  }
  revalidatePath(`/trips/${tripId}`, "layout");
  return { done: (prev.done ?? 0) + 1, notice };
}

export async function createQuote(tripId: string, tripCurrency: string, tripTimezone: string, prev: ActionState, f: FormData) {
  if (!isUuid(tripId)) return { error: "That trip could not be found." };
  const parsed = parseQuoteForm(f, tripCurrency, tripTimezone);
  if (!parsed.ok) return { error: parsed.error };
  const k = String(f.get("client_key") ?? "");
  const supabase = await db();
  return finish(
    tripId,
    prev,
    supabase.rpc("create_quote", { _trip_id: tripId, _q: parsed.data, _client_key: isUuid(k) ? k : null }),
    "Quote added.",
  );
}

export async function updateQuote(
  tripId: string,
  quoteId: string,
  tripCurrency: string,
  tripTimezone: string,
  prev: ActionState,
  f: FormData,
) {
  if (!isUuid(tripId) || !isUuid(quoteId)) return { error: "That quote could not be found." };
  const parsed = parseQuoteForm(f, tripCurrency, tripTimezone);
  if (!parsed.ok) return { error: parsed.error };
  const v = Number(f.get("expected_version"));
  if (!Number.isInteger(v) || v < 1) return { error: "Reload the page and try again." };
  const supabase = await db();
  return finish(
    tripId,
    prev,
    supabase.rpc("update_quote", { _id: quoteId, _q: parsed.data, _expected_version: v }),
    "Saved. Votes on this quote start again.",
  );
}

export async function deleteQuote(tripId: string, quoteId: string, expectedVersion: number, prev: ActionState) {
  if (!isUuid(tripId) || !isUuid(quoteId)) return { error: "That quote could not be found." };
  const supabase = await db();
  return finish(tripId, prev, supabase.rpc("delete_quote", { _id: quoteId, _expected_version: expectedVersion }));
}

export async function voteQuote(tripId: string, quoteId: string, prev: ActionState, f: FormData) {
  if (!isUuid(tripId) || !isUuid(quoteId)) return { error: "That quote could not be found." };
  const v = f.get("vote");
  const vote = v === "for" || v === "against" ? v : v === "clear" ? null : undefined;
  if (vote === undefined) return { error: "Vote for or against" };
  const supabase = await db();
  return finish(tripId, prev, supabase.rpc("vote_quote", { _quote_id: quoteId, _vote: vote }));
}
