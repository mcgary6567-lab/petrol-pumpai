import { dt } from "../lib/format";

/** "Baad mein darj": the entry was typed more than an hour after the moment it is dated for (a missed entry entered
 *  later on its real date/time). `at` = the entry's own date/time, `typed` = when it was actually written. */
export function LateBadge({ at, typed, className = "" }: { at?: string | null; typed?: string | null; className?: string }) {
  if (!at || !typed) return null;
  const gap = Date.parse(typed) - Date.parse(at);
  if (!(gap > 60 * 60_000)) return null;
  const days = Math.floor(gap / 86_400_000), hrs = Math.floor((gap % 86_400_000) / 3_600_000);
  return (
    <span className={`inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-amber-900 ring-1 ring-amber-200 ${className}`}
      title={`Baad mein darj hui · likhi gayi: ${dt(typed)} (${days ? `${days} din ` : ""}${hrs} ghante baad)`}>⏱ Baad mein darj</span>
  );
}
