/**
 * Dashboard card · پرچی — parchiyan today / this month, unpaid parchi money (and how much is 90+ days old), and the
 * customers owing most on parchi. Manager / CEO only; hidden on a pump that has never written a parchi.
 */
import { Link } from "react-router-dom";
import { Ticket } from "lucide-react";
import { useApi } from "../lib/api";
import { pkr } from "../lib/format";

export function ParchiCard() {
  const { data } = useApi<any>("/parchi/summary");
  if (!data || (data.month.n === 0 && data.unpaid < 0.5)) return null;
  const go = (q = "") => `/parchi?tab=book${q}`;
  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <Link to="/parchi" className="flex items-center gap-2 font-semibold"><span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-violet-600 to-fuchsia-500 text-white"><Ticket size={16} /></span>
          Parchi Billing · <span lang="ur" className="font-urdu font-normal">پرچی</span></Link>
        <Link to="/parchi" className="btn-secondary !py-1 text-xs">＋ Nayi parchiyan</Link>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Link to={go()} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"><div className="text-xs text-slate-500">Aaj</div><div className="font-bold tabular-nums">{pkr(data.today.amount)}</div><div className="text-xs text-slate-500">{data.today.n} parchi</div></Link>
        <Link to={go()} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"><div className="text-xs text-slate-500">Is mahine</div><div className="font-bold tabular-nums">{pkr(data.month.amount)}</div><div className="text-xs text-slate-500">{data.month.n} parchi</div></Link>
        <Link to={go()} className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2"><div className="text-xs text-violet-700">Baqi (unpaid)</div><div className="font-bold tabular-nums text-violet-800">{pkr(data.unpaid)}</div><div className="text-xs text-violet-700">{data.unpaid_n} parchi</div></Link>
        <Link to={go()} className={`rounded-lg border px-3 py-2 ${data.over90 > 0.5 ? "border-rose-300 bg-rose-50" : "border-slate-200 bg-slate-50"}`}><div className={`text-xs ${data.over90 > 0.5 ? "text-rose-700" : "text-slate-500"}`}>90+ din purani</div><div className={`font-bold tabular-nums ${data.over90 > 0.5 ? "text-rose-700" : ""}`}>{pkr(data.over90)}</div><div className="text-xs text-slate-500">jaldi wasool karein</div></Link>
      </div>
      {data.top.length > 0 && <div className="mt-3">
        <div className="mb-1 text-xs font-semibold text-slate-500">Sab se zyada parchi baqi</div>
        {data.top.map((c: any) => (
          <Link key={c.id} to={`/parchi?tab=book&customer=${c.id}`} className="flex items-center justify-between gap-2 border-b border-dashed border-slate-200 py-1.5 text-sm last:border-0">
            <span className="min-w-0 truncate">{c.name} <span className="text-xs text-slate-500">· {c.n} parchi</span></span>
            <span className="flex shrink-0 items-center gap-2"><span className={`text-xs ${c.oldest_days > 90 ? "font-semibold text-rose-700" : c.oldest_days > 60 ? "text-amber-700" : "text-slate-500"}`}>{c.oldest_days} din</span><b className="tabular-nums">{pkr(c.unpaid)}</b></span>
          </Link>))}
      </div>}
    </div>
  );
}
