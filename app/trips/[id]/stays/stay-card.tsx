import { formatDate, formatKm, formatRupees } from "@/lib/format";
import {
  CANCELLATION_LABELS,
  capacityWarning,
  nightsBetween,
  type ComparedStay,
} from "@/lib/stay-costs";
import { safeHttpUrl } from "@/lib/stay-input";

export type StayCardData = ComparedStay & {
  url: string;
  cancellationTerms: string | null;
  priceCheckedOn: string;
  addedByMe: boolean;
};

export function StayCard({
  data,
  today,
  rank,
  sharers,
  removeAction,
}: {
  data: StayCardData;
  today: string;
  rank: number;
  sharers: number;
  removeAction: () => Promise<void>;
}) {
  const { stay, cost, tradeoff } = data;
  const link = safeHttpUrl(data.url);
  const daysOld = nightsBetween(data.priceCheckedOn, today);
  const stale = daysOld > 7;
  const capacity = capacityWarning(stay.beds, sharers);

  return (
    <article className="grid grid-cols-[1fr_auto] gap-8 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950 max-md:grid-cols-1 max-md:gap-4 max-md:p-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-xl font-semibold text-zinc-950 dark:text-zinc-50">
            <span className="mr-2 text-zinc-400">{rank}.</span>
            {stay.name}
          </h3>
          {link ? (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="text-sm text-blue-700 underline dark:text-blue-400"
            >
              View the listing ↗
            </a>
          ) : (
            <span className="text-sm text-zinc-500">No valid link saved</span>
          )}
        </div>

        <p className="text-base font-medium text-zinc-900 dark:text-zinc-100">
          {tradeoff}
        </p>

        <ul className="flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">
          <li>
            {stay.rooms} {stay.rooms === 1 ? "room" : "rooms"} · {stay.beds}{" "}
            {stay.beds === 1 ? "bed" : "beds"}
            {stay.distanceCentiKm !== null &&
              ` · ${formatKm(stay.distanceCentiKm)} from the main area`}
          </li>
          {capacity && (
            <li className="font-medium text-amber-700 dark:text-amber-400">
              {capacity}
            </li>
          )}
          <li>
            {CANCELLATION_LABELS[stay.cancellationType]}
            {data.cancellationTerms && `: ${data.cancellationTerms}`}
          </li>
          <li className={stale ? "text-amber-700 dark:text-amber-400" : undefined}>
            Price checked {formatDate(data.priceCheckedOn)}
            {stale && ` (${daysOld} days ago, so it may have changed)`}
          </li>
        </ul>

        {data.addedByMe && (
          <form action={removeAction}>
            <button type="submit" className="text-sm text-zinc-500 underline">
              Remove this stay
            </button>
          </form>
        )}
      </div>

      <div className="flex min-w-60 flex-col gap-2 border-l border-zinc-200 pl-8 dark:border-zinc-800 max-md:min-w-0 max-md:border-l-0 max-md:border-t max-md:pl-0 max-md:pt-4">
        {cost ? (
          <>
            <p className="text-sm text-zinc-500">True cost per person</p>
            <p className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
              {formatRupees(cost.perPersonPaise)}
            </p>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {formatRupees(stay.nightlyPaise)} × {cost.nights}{" "}
              {cost.nights === 1 ? "night" : "nights"} ={" "}
              {formatRupees(cost.roomCostPaise)}
              <br />+ {formatRupees(stay.taxesPaise)} taxes
              <br />+ {formatRupees(stay.feesPaise)} fees
              <br />= {formatRupees(cost.stayTotalPaise)} ÷ {cost.sharers}{" "}
              {cost.sharers === 1 ? "person" : "people"}
            </p>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {stay.distanceCentiKm === null
                ? "Local transport: add a distance to estimate it."
                : `Estimated local transport: about ${formatRupees(cost.transportPerPersonPaise)} per person.`}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-zinc-500">Nightly price</p>
            <p className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
              {formatRupees(stay.nightlyPaise)}
            </p>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Set the trip dates to see the true cost per person.
            </p>
          </>
        )}
      </div>
    </article>
  );
}
