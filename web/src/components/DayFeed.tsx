/**
 * "Aaj ki saari entries" — one live, searchable, paginated feed of the whole pump's money events for a day (sales,
 * expenses, counter receive/pay, manual khata, supply), with a per-person roll-up and a one-tap printable day report.
 * Read-only: it reads /day-feed and nothing it shows changes the books. Used on the dashboard and the cashier desk.
 */
import { useState } from "react";
import { Printer, ChevronDown } from "lucide-react";
import { useApi } from "../lib/api";
import { Loading, Pager, usePaged, useListFilter } from "./ui";
import { PrintListButton } from "./PrintList";
import { Ur } from "./VoiceShell";
import { num, pkr } from "../lib/format";

const today = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
const KIND: Record<string, { en: string; cls: string }> = {
  sale: { en: "Sale", cls: "bg-emerald-100 text-emerald-700" },
  expense: { en: "Expense", cls: "bg-rose-100 text-rose-700" },
  receive: { en: "Received", cls: "bg-emerald-100 text-emerald-700" },
  pay: { en: "Paid", cls: "bg-rose-100 text-rose-700" },
  khata_in: { en: "Khata payment", cls: "bg-emerald-100 text-emerald-700" },
  khata_charge: { en: "Khata charge", cls: "bg-slate-100 text-slate-600" },
  refund: { en: "Advance wapas", cls: "bg-rose-100 text-rose-700" },
  supply: { en: "Supply", cls: "bg-blue-100 text-blue-700" },
  supply_bill: { en: "Udhaar maal", cls: "bg-slate-100 text-slate-600" },
  adjust: { en: "Adjustment", cls: "bg-slate-100 text-slate-600" },
};
const amtCls = (dir: string) => (dir === "in" ? "text-emerald-700" : dir === "out" ? "text-rose-700" : "text-slate-700");
const sign = (dir: string) => (dir === "in" ? "+" : dir === "out" ? "−" : "");
const t12 = (s: string) => new Date(s).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" });

export function DayFeed({ title = "Aaj ki saari entries", scope = "all" }: { title?: string; scope?: "all" | "cashier" | "supplier" }) {
  const [date, setDate] = useState(today());
  const { data } = useApi<any>(`/day-feed?date=${date}&scope=${scope}`, 60_000);
  const [q, setQ] = useState("");
  const [people, setPeople] = useState(false);
  const rows = useListFilter<any>(data?.rows, { q, text: (r) => [r.label, r.party, r.who, KIND[r.kind]?.en, Math.round(r.amount)].filter(Boolean).join(" ") });
  const paged = usePaged(rows, 10);

  return (
    <div className="card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{title} · <Ur className="text-slate-500">آج کی تمام انٹریز</Ur></h2>
        <div className="flex flex-wrap items-center gap-2">
          <input className="input w-auto" type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Din" />
          {data && <PrintListButton title={`Din ki report — ${data.date}`} subtitle={data.is_today ? "aaj (abhi tak)" : data.date} rows={rows} label="Report / Print"
            columns={[
              { label: "Waqt", v: (r: any) => t12(r.at) },
              { label: "Kism", v: (r: any) => KIND[r.kind]?.en ?? r.kind },
              { label: "Kis ne", v: (r: any) => r.who ?? "—" },
              { label: "Party / detail", v: (r: any) => [r.party, r.label].filter(Boolean).join(" · ") },
              { label: "Amount", r: true, v: (r: any) => `${sign(r.dir)}${pkr(r.amount)}`, total: (rs: any[]) => `${rs.length} entries` },
            ]} />}
        </div>
      </div>

      {!data ? <Loading /> : (
        <>
          {/* day totals */}
          <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[["Sales", data.totals.sales, "text-emerald-700"], ["Kharcha", data.totals.expenses, "text-rose-700"], ["Aur aaya", data.totals.received, "text-emerald-700"], ["Aur gaya", data.totals.paid, "text-rose-700"]].map(([k, v, c]: any) => (
              <div key={k} className="rounded-xl bg-slate-50 p-2 text-center"><div className="text-[11px] uppercase tracking-wide text-slate-500">{k}</div><div className={`font-bold tabular-nums ${c}`}>{pkr(v)}</div></div>
            ))}
          </div>

          {/* per-person roll-up (salesman / cashier daily report) */}
          {data.by_person.length > 0 && (
            <div className="mb-2 rounded-xl border border-slate-200">
              <button className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-slate-700" onClick={() => setPeople(!people)}>
                <span>Kis ne kitna · <Ur className="text-slate-500">فی بندہ</Ur> <span className="text-xs font-normal text-slate-500">{data.by_person.length} log</span></span>
                <ChevronDown size={16} className={`transition ${people ? "rotate-180" : ""}`} />
              </button>
              {people && (
                <div className="overflow-x-auto border-t border-slate-100">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-xs uppercase tracking-wide text-slate-500"><th className="px-3 py-1.5">Banda</th><th className="px-3 py-1.5 text-right">Sales</th><th className="px-3 py-1.5 text-right">Kharcha</th><th className="px-3 py-1.5 text-right">Received</th><th className="px-3 py-1.5 text-right">Paid</th><th className="px-3 py-1.5 text-right">Entries</th></tr></thead>
                    <tbody>{data.by_person.map((p: any) => (
                      <tr key={p.who} className="border-t border-slate-100 tabular-nums">
                        <td className="px-3 py-1.5 font-medium">{p.who}</td><td className="px-3 py-1.5 text-right">{p.sales ? pkr(p.sales) : "—"}</td><td className="px-3 py-1.5 text-right text-rose-700">{p.expenses ? pkr(p.expenses) : "—"}</td>
                        <td className="px-3 py-1.5 text-right text-emerald-700">{p.received ? pkr(p.received) : "—"}</td><td className="px-3 py-1.5 text-right text-rose-700">{p.paid ? pkr(p.paid) : "—"}</td><td className="px-3 py-1.5 text-right">{p.n}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <input className="input mb-2" placeholder="Dhoondein — party / kism / amount… · تلاش" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {paged.slice.map((r: any) => (
              <li key={r.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${KIND[r.kind]?.cls ?? "bg-slate-100 text-slate-600"}`}>{KIND[r.kind]?.en ?? r.kind}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{r.party ? <b>{r.party}</b> : null}{r.party ? " · " : ""}{r.label}</span>
                  <span className="text-xs text-slate-500">{t12(r.at)}{r.who ? ` · ${r.who}` : ""}</span>
                </span>
                <span className={`shrink-0 font-semibold tabular-nums ${amtCls(r.dir)}`}>{sign(r.dir)}{pkr(r.amount)}</span>
              </li>
            ))}
            {!rows.length && <li className="p-4 text-center text-sm text-slate-500">{q ? "Kuch nahi mila" : "Is din koi entry nahi"}</li>}
          </ul>
          <div className="pt-2"><Pager {...paged} /></div>
          <p className="mt-1 text-[11px] text-slate-400">Sirf dekhne ke liye — {num(data.totals.count)} entries. {scope === "cashier" ? "Sirf cashier counter ki receive/pay entries." : scope === "supplier" ? "Sirf supplier ki supply, bill aur payment entries." : "Sale = pump + khata + wholesale; counter receive/pay, khata, supply sab yahan."}</p>
        </>
      )}
    </div>
  );
}
