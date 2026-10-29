/**
 * "Aaj ki saari entries" — one live, searchable, paginated feed of the whole pump's money events for a day (sales,
 * expenses, counter receive/pay, manual khata, supply), with a per-person roll-up and a one-tap printable day report.
 * Read-only: it reads /day-feed and nothing it shows changes the books. Used on the dashboard and the cashier desk.
 */
import { useState } from "react";
import { ChevronDown, BarChart3, Fuel, Coins, Scale, MessageCircle } from "lucide-react";
import { useApi } from "../lib/api";
import { Loading, Pager, usePaged, useListFilter } from "./ui";
import { PrintListButton } from "./PrintList";
import { Ur } from "./VoiceShell";
import { num, pkr } from "../lib/format";

const today = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() + 5 * 3600_000 - n * 86_400_000).toISOString().slice(0, 10);
/** Day-book side of any row, every scope: Debit = money out / maal supply di; Credit = money in / udhaar maal aaya. The server
 *  marks wholesale rows itself; the rest follow their direction. A neutral row (hisaab barabar) sits in neither column. */
const sideOf = (r: any): "dr" | "cr" | null => r.side ?? (r.dir === "out" || r.kind === "ws_supply" ? "dr" : r.dir === "in" || r.kind === "supply_bill" ? "cr" : null);
const sumDrCr = (rs: any[], side: "dr" | "cr") => rs.reduce((a, r) => a + (sideOf(r) === side ? r.amount : 0), 0);
/** Running Dr − Cr down the list, oldest first (the feed is newest first), keyed by row id. */
function running(rs: any[]): Map<string, number> {
  const m = new Map<string, number>(); let bal = 0;
  for (const r of [...rs].reverse()) { const sd = sideOf(r); bal += sd === "dr" ? r.amount : sd === "cr" ? -r.amount : 0; m.set(r.id, bal); }
  return m;
}
/** Debit − Credit, labelled which way it leans */
const farq = (n: number) => `${pkr(Math.abs(n))} ${n > 0 ? "Dr" : n < 0 ? "Cr" : ""}`.trim();
/** share the day's summary (totals + count) on WhatsApp — opens the share sheet so any contact can be picked. */
function shareWhatsApp(title: string, data: any) {
  const T = data.totals;
  const text = data.scope === "wholesale" ? [
    `${title} — ${data.date}${data.is_today ? " (aaj, abhi tak)" : ""}`,
    `Debit (supply di + payment ki): ${pkr(T.debit)}`,
    `Credit (udhaar maal + payment aayi): ${pkr(T.credit)}`,
    `Farq: ${farq(T.net)}`,
    `Kul ${T.count} entries`,
    `— Petrol PumpAI`,
  ].join("\n") : [
    `${title} — ${data.date}${data.is_today ? " (aaj, abhi tak)" : ""}`,
    `Sales: ${pkr(T.sales)}`,
    `Kharcha: ${pkr(T.expenses)}`,
    `Aur aaya: ${pkr(T.received)}`,
    `Aur gaya: ${pkr(T.paid)}`,
    `Kul ${T.count} entries`,
    `— Petrol PumpAI`,
  ].join("\n");
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
}
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
  ws_supply: { en: "Supply di", cls: "bg-blue-100 text-blue-700" },
  ws_return: { en: "Wapas", cls: "bg-rose-100 text-rose-700" },
};
const amtCls = (dir: string) => (dir === "in" ? "text-emerald-700" : dir === "out" ? "text-rose-700" : "text-slate-700");
const sign = (dir: string) => (dir === "in" ? "+" : dir === "out" ? "−" : "");
const t12 = (s: string) => new Date(s).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" });
/** time, plus the day when the list spans more than one day (7/15 din, custom range) */
const when = (s: string, multiDay: boolean) => multiDay ? `${new Date(s).toLocaleDateString("en-PK", { day: "2-digit", month: "short" })} ${t12(s)}` : t12(s);

const RANGES = [{ k: "today", en: "Aaj", ur: "آج", span: 0 }, { k: "7d", en: "7 din", ur: "7 دن", span: 6 }, { k: "15d", en: "15 din", ur: "15 دن", span: 14 }, { k: "custom", en: "Custom", ur: "تاریخ", span: -1 }] as const;

export function DayFeed({ title = "Aaj ki saari entries", scope = "all" }: { title?: string; scope?: "all" | "pos" | "cashier" | "supplier" | "wholesale" }) {
  const [range, setRange] = useState<(typeof RANGES)[number]["k"]>("today");
  const [cFrom, setCFrom] = useState(daysAgo(6));
  const [cTo, setCTo] = useState(today());
  const span = RANGES.find((r) => r.k === range)!.span;
  const from = range === "custom" ? cFrom : range === "today" ? today() : daysAgo(span);
  const to = range === "custom" ? cTo : today();
  const { data } = useApi<any>(`/day-feed?from=${from}&to=${to}&scope=${scope}`, 300_000);
  const [q, setQ] = useState("");
  const [people, setPeople] = useState(false);
  const ws = scope === "wholesale"; // the wholesale officer's desk reads as a Debit / Credit statement
  const rows = useListFilter<any>(data?.rows, { q, text: (r) => [r.label, r.party, r.who, KIND[r.kind]?.en, Math.round(r.amount)].filter(Boolean).join(" ") });
  const paged = usePaged(rows, 10);

  return (
    <div className="card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{title} · <Ur className="text-slate-500">آج کی تمام انٹریز</Ur></h2>
        <div className="flex flex-wrap items-center gap-2">
          {/* quick ranges: Aaj / 7 din / 15 din / Custom (date se date) */}
          <div className="flex overflow-hidden rounded-lg border border-slate-300 text-sm">
            {RANGES.map((r, i) => (
              <button key={r.k} type="button" onClick={() => setRange(r.k)}
                className={`px-2.5 py-1.5 ${i ? "border-l border-slate-300" : ""} ${range === r.k ? "bg-brand-600 text-white" : "bg-white text-slate-700 hover:bg-slate-50"}`}>
                {r.en} <Ur className="text-[11px] opacity-80">{r.ur}</Ur>
              </button>
            ))}
          </div>
          {range === "custom" && (
            <div className="flex items-center gap-1 text-sm">
              <input className="input w-auto" type="date" max={today()} value={cFrom} onChange={(e) => e.target.value && setCFrom(e.target.value)} aria-label="Se" />
              <span className="text-slate-400">→</span>
              <input className="input w-auto" type="date" max={today()} value={cTo} onChange={(e) => e.target.value && setCTo(e.target.value)} aria-label="Tak" />
            </div>
          )}
          {data && <button type="button" className="btn-secondary !text-emerald-700" onClick={() => shareWhatsApp(title, data)} title="Is report ka khulasa WhatsApp par bhejein"><MessageCircle size={15} /> WhatsApp</button>}
          {data && <PrintListButton title={`Day Book — ${title}`} subtitle={`${data.is_today ? "aaj (abhi tak)" : data.date}${data.from !== data.to ? ` · ${data.from} → ${data.to}` : ""}`} rows={[...rows].reverse()} label="Report / Print"
            note={`Debit (gaya / supply di) ${pkr(sumDrCr(rows, "dr"))} · Credit (aaya / udhaar maal) ${pkr(sumDrCr(rows, "cr"))} · Farq ${farq(sumDrCr(rows, "dr") - sumDrCr(rows, "cr"))} · ${rows.length} entries`}
            columns={(() => { const bal = running(rows); return [
              { label: "Waqt", v: (r: any) => when(r.at, data.from !== data.to) },
              { label: "Voucher", v: (r: any) => KIND[r.kind]?.en ?? r.kind, sub: (r: any) => r.ref ?? null },
              { label: "Particulars", v: (r: any) => [r.party, r.label].filter(Boolean).join(" — ") || "—", sub: (r: any) => [r.who && `by ${r.who}`, r.vehicle && `🚛 ${r.vehicle}`].filter(Boolean).join(" · ") || null, total: (rs: any[]) => `Totals · ${rs.length} entries` },
              ...(rows.some((r: any) => r.litres || r.rate) ? [
                { label: "Litre", r: true, v: (r: any) => (r.litres ? num(r.litres, r.litres % 1 ? 2 : 0) : ""), total: (rs: any[]) => num(rs.reduce((x: number, r: any) => x + (r.litres ?? 0), 0)) },
                { label: "Rate", r: true, v: (r: any) => (r.rate ? num(r.rate, 2) : "") },
              ] : []),
              { label: "Debit", r: true, v: (r: any) => (sideOf(r) === "dr" ? num(r.amount) : ""), tone: () => "neg" as const, total: (rs: any[]) => num(sumDrCr(rs, "dr")), totalTone: "neg" as const },
              { label: "Credit", r: true, v: (r: any) => (sideOf(r) === "cr" ? num(r.amount) : ""), tone: () => "pos" as const, total: (rs: any[]) => num(sumDrCr(rs, "cr")), totalTone: "pos" as const },
              { label: "Balance (Dr − Cr)", r: true, v: (r: any) => farq(bal.get(r.id) ?? 0), total: (rs: any[]) => farq(sumDrCr(rs, "dr") - sumDrCr(rs, "cr")) },
            ]; })()} />}
        </div>
      </div>

      {!data ? <Loading /> : (
        <>
          {/* day totals */}
          <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(ws ? [["Debit (Dr)", data.totals.debit, "text-rose-700"], ["Credit (Cr)", data.totals.credit, "text-emerald-700"], ["Farq (Dr − Cr)", data.totals.net, "text-slate-800", farq(data.totals.net)], ["Entries", data.totals.count, "text-slate-800", num(data.totals.count)]]
              : [["Sales", data.totals.sales, "text-emerald-700"], ["Kharcha", data.totals.expenses, "text-rose-700"], ["Debit (gaya)", sumDrCr(data.rows, "dr"), "text-rose-700"], ["Credit (aaya)", sumDrCr(data.rows, "cr"), "text-emerald-700"]]).map(([k, v, c, shown]: any) => (
              <div key={k} className="rounded-xl bg-slate-50 p-2 text-center"><div className="text-[11px] uppercase tracking-wide text-slate-500">{k}</div><div className={`font-bold tabular-nums ${c}`}>{shown ?? pkr(v)}</div></div>
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
          {(() => {
            const fuelCols = rows.some((r: any) => r.litres || r.rate), vehCol = rows.some((r: any) => r.vehicle);
            const multi = data.from !== data.to;
            return (
              <div className="hidden overflow-x-auto rounded-lg border border-slate-200 sm:block">
                <table className="w-full min-w-[860px]">
                  <thead><tr>
                    <th className="th">Waqt</th><th className="th">Kism</th><th className="th">Kis ne</th><th className="th">Party</th><th className="th">Tafseel</th>
                    {vehCol && <th className="th">Gaari</th>}{fuelCols && <><th className="th text-right">Litre</th><th className="th text-right">Rate</th></>}
                    <th className="th text-right">Debit</th><th className="th text-right">Credit</th>
                  </tr></thead>
                  <tbody>{paged.slice.map((r: any) => (
                    <tr key={r.id}>
                      <td className="td whitespace-nowrap text-xs text-slate-600">{when(r.at, multi)}</td>
                      <td className="td"><span className={`whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${KIND[r.kind]?.cls ?? "bg-slate-100 text-slate-600"}`}>{KIND[r.kind]?.en ?? r.kind}</span></td>
                      <td className="td text-xs text-slate-600">{r.who ?? "—"}</td>
                      <td className="td text-sm font-medium">{r.party ?? "—"}</td>
                      <td className="td text-xs text-slate-600">{r.label}</td>
                      {vehCol && <td className="td whitespace-nowrap text-xs">{r.vehicle ? <b className="font-semibold text-slate-800">🚛 {r.vehicle}</b> : <span className="text-slate-300">—</span>}</td>}
                      {fuelCols && <>
                        <td className="td whitespace-nowrap text-right text-xs tabular-nums">{r.litres ? `${num(r.litres, r.litres % 1 ? 2 : 0)} L` : ""}</td>
                        <td className="td whitespace-nowrap text-right text-xs tabular-nums">{r.rate ? `Rs ${num(r.rate, 2)}` : ""}</td>
                      </>}
                      <td className="td whitespace-nowrap text-right tabular-nums text-rose-700">{sideOf(r) === "dr" ? pkr(r.amount) : ""}</td>
                      <td className="td whitespace-nowrap text-right tabular-nums text-emerald-700">{sideOf(r) === "cr" ? pkr(r.amount) : !sideOf(r) ? <span className="text-slate-400" title="Hisaab barabar kiya — paisa nahi hila">({pkr(r.amount)})</span> : ""}</td>
                    </tr>
                  ))}</tbody>
                  {rows.length > 0 && (
                    <tfoot><tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold tabular-nums">
                      <td className="td" colSpan={5 + (vehCol ? 1 : 0) + (fuelCols ? 2 : 0)}>Kul ({rows.length} entries) · Farq (Dr − Cr): <span className="text-slate-900">{farq(sumDrCr(rows, "dr") - sumDrCr(rows, "cr"))}</span></td>
                      <td className="td whitespace-nowrap text-right text-rose-700">{pkr(sumDrCr(rows, "dr"))}</td>
                      <td className="td whitespace-nowrap text-right text-emerald-700">{pkr(sumDrCr(rows, "cr"))}</td>
                    </tr></tfoot>
                  )}
                </table>
                {!rows.length && <p className="p-4 text-center text-sm text-slate-500">{q ? "Kuch nahi mila" : "Is din koi entry nahi"}</p>}
              </div>
            );
          })()}
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 sm:hidden">
            {paged.slice.map((r: any) => (
              <li key={r.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${KIND[r.kind]?.cls ?? "bg-slate-100 text-slate-600"}`}>{KIND[r.kind]?.en ?? r.kind}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{r.party ? <b>{r.party}</b> : null}{r.party ? " · " : ""}{r.label}</span>
                  <span className="text-xs text-slate-500">
                    {when(r.at, data.from !== data.to)}{r.who ? ` · ${r.who}` : ""}
                    {r.vehicle ? <> · <b className="font-semibold text-slate-700">🚛 {r.vehicle}</b></> : null}
                    {r.litres ? <> · <span className="font-medium text-slate-600">{num(r.litres, r.litres % 1 ? 2 : 0)} L</span></> : null}
                    {r.rate ? <> · <span className="font-medium text-slate-600">Rs {num(r.rate, 2)}/L</span></> : null}
                  </span>
                </span>
                {ws ? <span className={`shrink-0 text-right font-semibold tabular-nums ${r.side === "dr" ? "text-rose-700" : r.side === "cr" ? "text-emerald-700" : "text-slate-500"}`}>{pkr(r.amount)}<span className="block text-[10px] font-normal">{r.side === "dr" ? "Debit" : r.side === "cr" ? "Credit" : ""}</span></span>
                  : <span className={`shrink-0 font-semibold tabular-nums ${amtCls(r.dir)}`}>{sign(r.dir)}{pkr(r.amount)}</span>}
              </li>
            ))}
            {!rows.length && <li className="p-4 text-center text-sm text-slate-500">{q ? "Kuch nahi mila" : "Is din koi entry nahi"}</li>}
          </ul>
          <div className="pt-2"><Pager {...paged} /></div>
          <p className="mt-1 text-[11px] text-slate-400">Debit = paisa gaya / maal supply di · Credit = paisa aaya / udhaar maal aaya · Sirf dekhne ke liye — {num(data.totals.count)} entries. {scope === "pos" ? "Sirf POS ki sale aur kharch entries." : scope === "cashier" ? "Sirf cashier counter ki receive/pay entries." : scope === "supplier" ? "Sirf supplier ki supply, bill aur payment entries." : scope === "wholesale" ? "Wholesale officer ki entries — Debit: clients ko supply di + supplier ko payment; Credit: supplier se udhaar maal + client payment / wapsi." : "Sale = pump + khata + wholesale; counter receive/pay, khata, supply sab yahan."}</p>
        </>
      )}
    </div>
  );
}

/**
 * CEO can pull up each module's own live feed — the same "aaj ki entries" the POS, cashier and wholesale desks
 * see on their own screens. Buttons switch which module's feed is shown; whole-pump is the default.
 */
export function ModuleFeeds() {
  const tabs = [
    { k: "all" as const, en: "Poora pump", ur: "پورا پمپ", Icon: BarChart3, title: "Poore pump ki aaj ki entries" },
    { k: "pos" as const, en: "POS", ur: "پی او ایس", Icon: Fuel, title: "POS ki aaj ki entries" },
    { k: "cashier" as const, en: "Cashier", ur: "کیشیئر", Icon: Coins, title: "Cashier ki aaj ki entries" },
    { k: "wholesale" as const, en: "Wholesale", ur: "ہول سیل", Icon: Scale, title: "Wholesale ki aaj ki entries" },
  ];
  const [scope, setScope] = useState<(typeof tabs)[number]["k"]>("all");
  const active = tabs.find((t) => t.k === scope)!;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button key={t.k} onClick={() => setScope(t.k)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm ${scope === t.k ? "bg-brand-600 text-white" : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}>
            <t.Icon size={15} /> {t.en} <Ur className="text-[11px] opacity-80">{t.ur}</Ur>
          </button>
        ))}
      </div>
      <DayFeed key={scope} scope={scope} title={active.title} />
    </div>
  );
}
