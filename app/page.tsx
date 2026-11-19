export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-24 text-center dark:bg-black">
      <h1 className="max-w-2xl text-4xl font-semibold leading-tight tracking-tight text-zinc-950 sm:text-5xl dark:text-zinc-50">
        Plan a trip the whole group agrees on
      </h1>
      <p className="mt-6 max-w-xl text-lg leading-8 text-zinc-600 dark:text-zinc-400">
        Group Trip Planner lets everyone suggest destinations, dates and
        activities, then vote so the group lands on a plan that works for all.
      </p>
      <button
        type="button"
        className="mt-10 rounded-full bg-zinc-950 px-8 py-3 text-base font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
      >
        Start a trip
      </button>
    </main>
  );
}
