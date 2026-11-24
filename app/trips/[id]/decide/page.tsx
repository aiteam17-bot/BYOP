import { Suspense } from "react";
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { MemberAvatar } from "@/components/member-avatar";
import {
  Card,
  Muted,
  Shell,
  inputClass,
  labelClass,
  smallButton,
  smallPrimaryButton,
} from "@/components/ui";
import {
  RSVP_LABELS,
  RSVP_OPTIONS,
  ROLE_LABELS,
  canPlan,
  decidedText,
  decisionState,
  optionLabel,
  rsvpCounts,
  summarizePoll,
  type Member,
  type PollKind,
} from "@/lib/decide";
import { createClient } from "@/lib/supabase/server";
import { loadTripContext, type TripContext } from "@/lib/trip-data";
import {
  addDatesOption,
  addDestinationOption,
  castVote,
  nudgeMember,
  removeOption,
  renameTrip,
  reopenPoll,
  revokeInviteLink,
  setMemberRole,
  setRsvp,
  settlePoll,
} from "./actions";
import { InviteCreator } from "./invite-creator";

export const metadata = { title: "Decide · Group Trip Planner" };

const badge = "rounded-full px-2.5 py-0.5 text-xs font-medium";
const RSVP_BADGE: Record<string, string> = {
  in: `${badge} bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300`,
  maybe: `${badge} bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300`,
  not_yet: `${badge} bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300`,
};

function NudgeButton({ ctx, member, topic }: { ctx: TripContext; member: Member; topic: "rsvp" | PollKind }) {
  if (member.userId === ctx.userId) return null;
  return (
    <ActionForm action={nudgeMember.bind(null, ctx.trip.id, member.userId, topic)}>
      <SubmitButton
        className={smallButton}
        pendingText="Sending…"
        ariaLabel={`Nudge ${member.name}`}
      >
        Nudge
      </SubmitButton>
    </ActionForm>
  );
}

function TripNameCard({ ctx }: { ctx: TripContext }) {
  if (!canPlan(ctx.me.role)) {
    return (
      <Card title="Trip name">
        <p className="text-lg text-zinc-950 dark:text-zinc-50">{ctx.trip.name}</p>
        <Muted>The organiser or a co-planner can rename it.</Muted>
      </Card>
    );
  }
  return (
    <Card title="Trip name">
      <ActionForm action={renameTrip.bind(null, ctx.trip.id)} className="flex gap-3 max-md:flex-col">
        <label className="sr-only" htmlFor="trip-name">
          Trip name
        </label>
        <input
          id="trip-name"
          name="name"
          required
          maxLength={80}
          defaultValue={ctx.trip.name}
          className={inputClass}
        />
        <SubmitButton className={smallPrimaryButton} pendingText="Saving…">
          Save
        </SubmitButton>
      </ActionForm>
    </Card>
  );
}

type InviteRow = { id: string; created_at: string; expires_at: string; use_count: number };

function shortDate(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

async function InviteLinks({ ctx }: { ctx: TripContext }) {
  if (!canPlan(ctx.me.role)) {
    return (
      <Muted>
        Want to bring someone? Ask the organiser or a co-planner for an invite link.
      </Muted>
    );
  }
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("trip_invites")
    .select("id, created_at, expires_at, use_count")
    .eq("trip_id", ctx.trip.id)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error) throw new Error("Could not load invite links");
  const active = (data ?? []) as InviteRow[];
  return (
    <div className="flex flex-col gap-4">
      <Muted>
        Anyone who opens a link and signs in with GitHub joins as a traveller. Links expire, and
        you can revoke them at any time.
      </Muted>
      <InviteCreator tripId={ctx.trip.id} />
      {active.length === 0 ? (
        <p className="text-sm text-zinc-500">No active links.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800" aria-label="Active invite links">
          {active.map((invite) => (
            <li key={invite.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <span className="text-sm text-zinc-700 dark:text-zinc-300">
                Made {shortDate(invite.created_at)} · expires {shortDate(invite.expires_at)} ·{" "}
                {invite.use_count} joined
              </span>
              <ActionForm action={revokeInviteLink.bind(null, ctx.trip.id, invite.id)}>
                <SubmitButton className={smallButton} pendingText="Revoking…" ariaLabel="Revoke this link">
                  Revoke
                </SubmitButton>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function InviteAndRoles({ ctx }: { ctx: TripContext }) {
  const isOrganiser = ctx.me.role === "owner";
  return (
    <Card title="Invite and roles">
      <div className="flex flex-col gap-6">
        <InviteLinks ctx={ctx} />

        <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
          {ctx.members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center gap-3 py-3">
              <MemberAvatar userId={m.userId} name={m.name} decorative />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-zinc-950 dark:text-zinc-50">
                  {m.name}
                  {m.userId === ctx.userId && <span className="ml-2 text-sm font-normal text-zinc-500">you</span>}
                </span>
                <span className="text-sm text-zinc-600 dark:text-zinc-400">{ROLE_LABELS[m.role]}</span>
              </span>
              {isOrganiser && m.role !== "owner" && (
                <ActionForm
                  action={setMemberRole.bind(null, ctx.trip.id, m.userId)}
                  className="flex items-center gap-2"
                  ariaLabel={`Role for ${m.name}`}
                >
                  <label className="sr-only" htmlFor={`role-${m.userId}`}>
                    Role for {m.name}
                  </label>
                  <select
                    id={`role-${m.userId}`}
                    name="role"
                    defaultValue={m.role}
                    className="min-h-11 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  >
                    <option value="member">Traveller</option>
                    <option value="co_planner">Co-planner</option>
                  </select>
                  <SubmitButton className={smallButton} pendingText="Saving…">
                    Save
                  </SubmitButton>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
        <p className="text-sm text-zinc-500">
          Co-planners can rename the trip and settle votes. Only the organiser changes roles.
        </p>
      </div>
    </Card>
  );
}

function WhoIsComing({ ctx }: { ctx: TripContext }) {
  const counts = rsvpCounts(ctx.members);
  return (
    <Card title="Who's coming" id="who">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200" id="my-rsvp-label">
            Are you coming?
          </p>
          <ActionForm
            action={setRsvp.bind(null, ctx.trip.id)}
            className="flex gap-2 max-md:grid max-md:grid-cols-3"
            ariaLabel="Your RSVP"
          >
            {RSVP_OPTIONS.map((value) => {
              const mine = ctx.me.rsvp === value;
              return (
                <SubmitButton
                  key={value}
                  name="rsvp"
                  value={value}
                  pressed={mine}
                  className={mine ? smallPrimaryButton : smallButton}
                >
                  {RSVP_LABELS[value]}
                </SubmitButton>
              );
            })}
          </ActionForm>
        </div>

        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {counts.in} in · {counts.maybe} maybe · {counts.not_yet} not yet
        </p>

        <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
          {ctx.members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center gap-3 py-3">
              <MemberAvatar userId={m.userId} name={m.name} decorative />
              <span className="min-w-0 flex-1 truncate text-zinc-950 dark:text-zinc-50">
                {m.name}
                {m.userId === ctx.userId && <span className="ml-2 text-sm text-zinc-500">you</span>}
              </span>
              <span className={RSVP_BADGE[m.rsvp]}>{RSVP_LABELS[m.rsvp]}</span>
              {m.rsvp === "not_yet" && <NudgeButton ctx={ctx} member={m} topic="rsvp" />}
            </li>
          ))}
        </ul>
        <p className="text-sm text-zinc-500">
          Nudges appear in the app for that person. Nothing is emailed or messaged.
        </p>
      </div>
    </Card>
  );
}

function PollSection({ ctx, kind }: { ctx: TripContext; kind: PollKind }) {
  const poll = ctx.polls[kind];
  const state = decisionState(kind, ctx.trip, poll);
  const planner = canPlan(ctx.me.role);
  const summary = poll ? summarizePoll(poll, ctx.members) : null;
  const open = !poll || poll.status === "open";
  const nameOf = (id: string) => ctx.members.find((m) => m.userId === id)?.name ?? "Former member";
  const current = decidedText(kind, ctx.trip);

  return (
    <Card title={kind === "dates" ? "Dates" : "Destination vote"} id={kind}>
      <div className="flex flex-col gap-5">
        {poll?.status === "settled" && current && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-green-50 p-4 dark:bg-green-950">
            <p className="text-green-900 dark:text-green-200">
              <span className="font-semibold">Settled:</span> {current}
            </p>
            {planner && (
              <ActionForm action={reopenPoll.bind(null, ctx.trip.id, poll.id)}>
                <SubmitButton className={smallButton} pendingText="Reopening…">
                  Reopen vote
                </SubmitButton>
              </ActionForm>
            )}
          </div>
        )}

        {state === "decided" && !poll && current && (
          <Muted>
            Set to <strong>{current}</strong> when the trip was created. Suggest options below to
            put it to a vote instead.
          </Muted>
        )}
        {poll?.status === "open" && current && (
          <Muted>
            The trip currently says <strong>{current}</strong>. Settling this vote replaces it.
          </Muted>
        )}

        {state === "empty" && (
          <Muted>
            Nothing suggested yet. {kind === "dates" ? "Add a date range" : "Add a place"} and
            everyone votes.
          </Muted>
        )}

        {summary && summary.tallies.length > 0 && (
          <>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {summary.votedIds.length} of {ctx.members.length} voted
            </p>
            <ul className="flex flex-col gap-3">
              {summary.tallies.map(({ option, voterIds }) => {
                const mine = poll!.votes[ctx.userId] === option.id;
                const leading = summary.leaderIds.includes(option.id) && poll!.status === "open";
                const settled = poll!.settledOptionId === option.id;
                const canRemove = open && (planner || option.createdBy === ctx.userId);
                return (
                  <li
                    key={option.id}
                    className={`flex flex-col gap-3 rounded-lg border p-4 ${
                      settled
                        ? "border-green-600"
                        : mine
                          ? "border-zinc-900 dark:border-zinc-100"
                          : "border-zinc-200 dark:border-zinc-800"
                    }`}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium text-zinc-950 dark:text-zinc-50">{optionLabel(option)}</span>
                      <span className="text-sm text-zinc-600 dark:text-zinc-400">
                        {voterIds.length} vote{voterIds.length === 1 ? "" : "s"}
                        {leading && " · leading"}
                        {settled && " · chosen"}
                      </span>
                    </div>
                    {voterIds.length > 0 && (
                      <p className="text-sm text-zinc-600 dark:text-zinc-400">
                        {voterIds.map(nameOf).join(", ")}
                      </p>
                    )}
                    {open && (
                      <div className="flex flex-wrap gap-2">
                        <ActionForm action={castVote.bind(null, ctx.trip.id, option.id)}>
                          <SubmitButton
                            className={mine ? smallPrimaryButton : smallButton}
                            pressed={mine}
                            pendingText="Voting…"
                            ariaLabel={`Vote for ${optionLabel(option)}`}
                          >
                            {mine ? "Your vote" : "Vote"}
                          </SubmitButton>
                        </ActionForm>
                        {planner && poll && (
                          <ActionForm action={settlePoll.bind(null, ctx.trip.id, poll.id, option.id)}>
                            <SubmitButton
                              className={smallButton}
                              pendingText="Settling…"
                              ariaLabel={`Settle on ${optionLabel(option)}`}
                            >
                              Settle on this
                            </SubmitButton>
                          </ActionForm>
                        )}
                        {canRemove && (
                          <ActionForm action={removeOption.bind(null, ctx.trip.id, option.id)}>
                            <SubmitButton
                              className={smallButton}
                              pendingText="Removing…"
                              ariaLabel={`Remove ${optionLabel(option)}`}
                            >
                              Remove
                            </SubmitButton>
                          </ActionForm>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            {poll!.status === "open" && summary.notVotedIds.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                  Still to vote
                </p>
                <ul className="flex flex-col gap-2">
                  {summary.notVotedIds.map((id) => {
                    const m = ctx.members.find((x) => x.userId === id)!;
                    return (
                      <li key={id} className="flex flex-wrap items-center gap-3">
                        <MemberAvatar userId={m.userId} name={m.name} size="sm" decorative />
                        <span className="flex-1 text-zinc-950 dark:text-zinc-50">
                          {m.name}
                          {m.userId === ctx.userId && <span className="ml-2 text-sm text-zinc-500">you</span>}
                        </span>
                        <NudgeButton ctx={ctx} member={m} topic={kind} />
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </>
        )}

        {open && (
          <div className="flex flex-col gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            {kind === "dates" ? (
              <ActionForm
                action={addDatesOption.bind(null, ctx.trip.id)}
                className="grid grid-cols-[1fr_1fr_auto] items-end gap-3 max-md:grid-cols-1"
                ariaLabel="Suggest dates"
              >
                <label className={labelClass}>
                  From
                  <input type="date" name="start_date" required className={inputClass} />
                </label>
                <label className={labelClass}>
                  To
                  <input type="date" name="end_date" required className={inputClass} />
                </label>
                <SubmitButton className={smallPrimaryButton} pendingText="Adding…">
                  Suggest dates
                </SubmitButton>
              </ActionForm>
            ) : (
              <ActionForm
                action={addDestinationOption.bind(null, ctx.trip.id)}
                className="grid grid-cols-[1fr_auto] items-end gap-3 max-md:grid-cols-1"
                ariaLabel="Suggest a destination"
              >
                <label className={labelClass}>
                  Place
                  <input name="label" required maxLength={80} placeholder="e.g. Goa" className={inputClass} />
                </label>
                <SubmitButton className={smallPrimaryButton} pendingText="Adding…">
                  Suggest
                </SubmitButton>
              </ActionForm>
            )}
            <p className="text-sm text-zinc-500">
              Anyone on the trip can suggest options. The organiser or a co-planner settles the vote.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}

async function Decide({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await loadTripContext(id);
  return (
    <>
      <div className="flex flex-col gap-1">
        <Link href={`/trips/${id}`} className="text-sm text-zinc-600 underline dark:text-zinc-400">
          ← {ctx.trip.name}
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">Decide</h1>
        <Muted>Who&apos;s coming, when, and where. In that order.</Muted>
      </div>
      <TripNameCard ctx={ctx} />
      <InviteAndRoles ctx={ctx} />
      <WhoIsComing ctx={ctx} />
      <PollSection ctx={ctx} kind="dates" />
      <Card title="Your private preference card">
        <div className="flex flex-col gap-3">
          <Muted>
            Budget, pace and must-sees. Only you can see your answers.{" "}
            {ctx.cardsAnswered} of {ctx.members.length} have filled theirs in.
          </Muted>
          <div>
            <Link href={`/trips/${id}/preferences`} className={smallPrimaryButton}>
              {ctx.myCardAnswered ? "Edit your card" : "Fill in your card"}
            </Link>
          </div>
        </div>
      </Card>
      <PollSection ctx={ctx} kind="destination" />
    </>
  );
}

export default function DecidePage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Shell>
      <Suspense fallback={<DecideSkeleton />}>
        <Decide params={params} />
      </Suspense>
    </Shell>
  );
}

function DecideSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-live="polite">
      <p className="text-zinc-500">Loading Decide…</p>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-32 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-900" />
      ))}
    </div>
  );
}
