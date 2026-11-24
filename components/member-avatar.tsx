import { initialOf } from "@/lib/decide";

// Identity used on every screen: the member's initial on a colour picked from
// their id, so the same person always looks the same. The name is always
// written next to it or given as the accessible label, never colour alone.
const COLOURS = [
  "bg-teal-700",
  "bg-indigo-600",
  "bg-rose-700",
  "bg-amber-700",
  "bg-sky-700",
  "bg-fuchsia-700",
  "bg-emerald-700",
  "bg-orange-700",
];

function colourFor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return COLOURS[hash % COLOURS.length];
}

export function MemberAvatar({
  userId,
  name,
  size = "md",
  decorative = false,
}: {
  userId: string;
  name: string;
  size?: "sm" | "md";
  decorative?: boolean;
}) {
  const dims = size === "sm" ? "h-7 w-7 text-xs" : "h-9 w-9 text-sm";
  return (
    <span
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative || undefined}
      title={name}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-2 ring-white dark:ring-zinc-950 ${dims} ${colourFor(userId)}`}
    >
      {initialOf(name)}
    </span>
  );
}

export function MemberStack({ members }: { members: { userId: string; name: string }[] }) {
  const shown = members.slice(0, 8);
  const extra = members.length - shown.length;
  return (
    <div className="flex items-center" aria-label={`${members.length} member${members.length === 1 ? "" : "s"}`}>
      <ul className="flex -space-x-2">
        {shown.map((m) => (
          <li key={m.userId}>
            <MemberAvatar userId={m.userId} name={m.name} size="sm" />
          </li>
        ))}
      </ul>
      {extra > 0 && <span className="ml-2 text-sm text-zinc-600 dark:text-zinc-400">+{extra}</span>}
    </div>
  );
}
