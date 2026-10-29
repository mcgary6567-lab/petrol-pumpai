/**
 * Financial statements — the accountant's view of the pump, ERP style: Profit & Loss (with last month beside it),
 * Balance Sheet (assets | liabilities & equity, and the check that they balance), Trial Balance, Journal (every
 * voucher, Dr / Cr), Receivable aging, and the one-page Monthly pack for print. Every tab prints on the letterhead.
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, Printer, Send } from "lucide-react";
import { api, linkToken, useApi } from "../lib/api";
import { ErrorBox, Loading, Pager, useAction, usePaged } from "../components/ui";
import { ErpBar, ErpSearch, Ur } from "../components/WholesaleErp";
import { num, pkr } from "../lib/format";

const monthEnd = (m: string) => { const [y, mo] = m.split("-").map(Number); return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, "0")}`; };
const prevMonth = (m: string) => { const [y, mo] = m.split("-").map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`; };
const monthName = (m: string) => new Date(`${m}-15T00:00:00`).toLocaleString("en-PK", { month: "long", year: "numeric" });
const thisMonth = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 7);
const today = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
/** Accounting figure: lakh grouping, brackets for a negative, dash for zero. */
const acc = (n: number | null | undefined, zero = "—") => n == null || Math.abs(n) < 0.5 ? zero : n < 0 ? `(${num(Math.abs(n))})` : num(n);
// % change against last period; meaningless against a near-zero base, so a dash under Rs 1,000
const pct = (a: number, b: number) => (Math.abs(b) >= 1000 ? `${(((a - b) / Math.abs(b)) * 100).toFixed(1)}%` : "—");
const dl = (path: string) => `/api${path}${path.includes("?") ? "&" : "?"}token=${linkToken()}`;
const nice = (k: string) => k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

const TABS = [["pl", "Profit & Loss", "نفع و نقصان"], ["bs", "Balance Sheet", "بیلنس شیٹ"], ["tb", "Trial Balance", "ٹرائل بیلنس"], ["journal", "Journal", "جرنل"], ["aging", "Receivable aging", "وصولی کی عمر"], ["pack", "Monthly pack", "ماہانہ پیک"]] as const;
type Tab = (typeof TABS)[number][0];
const TH = "px-3 py-2 text-xs font-bold text-slate-700";
const TD = "px-3 py-1.5";

export default function OwnerReport() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "pl";
  const month = params.get("month") ?? thisMonth();
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };
  const pl = useApi<any>(`/analysis/pl?month=${month}`);
  const plPrev = useApi<any>(`/analysis/pl?month=${prevMonth(month)}`);
  const from = `${month}-01`, to = monthEnd(month) < today() ? monthEnd(month) : today();
  const ledger = useApi<any>(tab === "tb" || tab === "journal" ? `/ledger?from=${from}&to=${to}` : null);
  const aging = useApi<any>(tab === "aging" || tab === "pack" ? "/khata/aging" : null);
  const ws = useApi<any>(tab === "aging" || tab === "pack" ? "/wholesale/dashboard" : null);
  const gl = useApi<any>(tab === "pack" ? `/analysis/gain-loss?from=${from}&to=${monthEnd(month)}` : null);
  const wa = useAction();
  const title = TABS.find(([k]) => k === tab)!;

  return (
    <div className="space-y-4">
      <ErpBar root="Accounts" rootTo="/accounts" crumb="Financial statements" title="Financial statements" ur="مالی گوشوارے">
        <input type="month" className="input w-auto" aria-label="Month" value={month} max={thisMonth()} onChange={(e) => e.target.value && set("month", e.target.value)} />
        {(tab === "tb" || tab === "journal") && <a className="btn-secondary" href={dl(`/ledger.csv?from=${from}&to=${to}`)} title="Excel / QuickBooks"><Download size={15} /><span className="hidden sm:inline"> Excel</span></a>}
        {(tab === "tb" || tab === "journal") && <a className="btn-secondary" href={dl(`/ledger/tally.xml?from=${from}&to=${to}`)} title="Tally XML"><Download size={15} /><span className="hidden sm:inline"> Tally</span></a>}
        {tab === "pl" && <a className="btn-secondary" href={dl(`/analysis/pl.csv?month=${month}`)}><Download size={15} /><span className="hidden sm:inline"> Excel</span></a>}
        <button className="btn-secondary" disabled={wa.busy} onClick={() => wa.run(() => api("/reports/whatsapp", { body: { from: new Date(from + "T00:00:00+05:00").toISOString(), to: new Date(to + "T23:59:59+05:00").toISOString() } }), (x: any) => x.simulated ? "WhatsApp abhi set nahi — khulasa simulate hua" : "Report WhatsApp par bhej di")}><Send size={15} /><span className="hidden sm:inline"> WhatsApp</span></button>
        <button className="btn-primary" onClick={() => window.print()}><Printer size={15} /> Print / PDF</button>
      </ErpBar>

      <div className="flex gap-1 overflow-x-auto border-b border-slate-200 print:hidden">
        {TABS.map(([k, l, u]) => (
          <button key={k} onClick={() => set("tab", k)} className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm leading-tight ${tab === k ? "border-brand-600 font-semibold text-brand-700" : "border-transparent text-slate-600"}`}>{l}<Ur className="block text-xs">{u}</Ur></button>
        ))}
      </div>
      <div className="hidden print:block"><div className="text-lg font-bold">{title[1]}</div><div className="text-xs text-slate-600">{tab === "bs" ? `As at ${today()}` : `${monthName(month)} · ${from} to ${to}`}</div></div>

      {pl.error && <ErrorBox error={pl.error} />}
      {tab === "pl" && (pl.data ? <ProfitLoss p={pl.data.pl} q={plPrev.data?.pl} month={month} /> : <Loading />)}
      {tab === "bs" && (pl.data ? <BalanceSheet bs={pl.data.balance_sheet} p={pl.data.pl} /> : <Loading />)}
      {tab === "tb" && (ledger.error ? <ErrorBox error={ledger.error} /> : ledger.data ? <TrialBalance d={ledger.data} /> : <Loading />)}
      {tab === "journal" && (ledger.error ? <ErrorBox error={ledger.error} /> : ledger.data ? <Journal d={ledger.data} /> : <Loading />)}
      {tab === "aging" && (aging.data ? <Aging a={aging.data} w={ws.data} /> : <Loading />)}
      {tab === "pack" && (pl.data && aging.data ? <MonthlyPack p={pl.data.pl} bs={pl.data.balance_sheet} a={aging.data} w={ws.data} gl={gl.data} month={month} /> : <Loading />)}
    </div>
  );
}

/* ---------------- shared statement table bits ---------------- */
function Sec({ title, ur, children, right }: { title: string; ur?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white break-inside-avoid">
      <div className="flex items-baseline justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2"><h2 className="font-bold">{title}{ur && <> · <Ur className="font-normal">{ur}</Ur></>}</h2>{right}</div>
      {children}
    </section>
  );
}
/** One statement line: label, this period, last period, change. `level` indents; `kind` styles sub-totals and totals. */
function Line({ label, ur, v, q, level = 0, kind, neg }: { label: string; ur?: string; v: number; q?: number | null; level?: number; kind?: "sub" | "total" | "grand"; neg?: boolean }) {
  const cls = kind === "grand" ? "bg-brand-50 font-extrabold text-brand-900" : kind === "total" ? "border-t border-slate-300 bg-slate-50 font-bold" : kind === "sub" ? "font-semibold" : "";
  const tone = neg ? "text-red-700" : kind && v < 0 ? "text-red-700" : "";
  return (
    <tr className={`border-b border-slate-100 ${cls}`}>
      <td className={TD} style={{ paddingLeft: 12 + level * 18 }}>{label}{ur && <Ur className="ml-1 text-xs text-slate-500">{ur}</Ur>}</td>
      <td className={`${TD} text-right tabular-nums ${tone}`}>{acc(v)}</td>
      {q !== undefined && <td className={`${TD} text-right tabular-nums text-slate-500`}>{acc(q)}</td>}
      {q !== undefined && <td className={`${TD} text-right text-xs tabular-nums ${q && Math.abs(q) >= 1000 && v - q !== 0 ? ((v - q > 0) !== !!neg ? "text-emerald-700" : "text-red-700") : "text-slate-400"}`}>{q ? pct(v, q) : "—"}</td>}
    </tr>
  );
}
const Head = ({ cols }: { cols: (string | [string, boolean])[] }) => (
  <thead><tr className="border-b border-slate-300 bg-slate-100">{cols.map((c) => { const [l, r] = Array.isArray(c) ? c : [c, false]; return <th key={l} className={`${TH} ${r ? "text-right" : "text-left"}`}>{l}</th>; })}</tr></thead>
);

/* ---------------- Profit & Loss ---------------- */
function ProfitLoss({ p, q, month }: { p: any; q?: any; month: string }) {
  const cmp = q ? [`${monthName(month)}`, `${monthName(prevMonth(month))}`, "Change"] : [`${monthName(month)}`];
  const byCat: { category: string; amount: number }[] = p.expenses.by_category ?? [];
  const qCat = (c: string) => (q?.expenses?.by_category ?? []).find((x: any) => x.category === c)?.amount ?? 0;
  const otherIncome = p.other_income + (p.other_income_ceo ?? 0);
  const qOther = q ? q.other_income + (q.other_income_ceo ?? 0) : null;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 print:hidden">
        {[["Revenue", p.income.total, q?.income.total], ["Gross profit", p.gross_profit, q?.gross_profit, `${num(p.gross_margin_pct, 1)}% margin`], ["Expenses", p.expenses.total, q?.expenses.total, null, true], ["Net profit", p.net_profit, q?.net_profit, `${num(p.margin_pct, 1)}% net margin`]].map(([l, v, qv, sub, low]: any) => (
          <div key={l} className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-xs text-slate-500">{l}</div><div className={`text-xl font-extrabold tabular-nums ${v < 0 ? "text-red-700" : ""}`}>{pkr(v)}</div>
            <div className="text-xs text-slate-500">{sub ?? ""}{qv != null && <span className={`ml-1 ${((v - qv > 0) !== !!low) ? "text-emerald-700" : "text-red-700"}`}>{pct(v, qv)} vs last month</span>}</div></div>
        ))}
      </div>
      <Sec title="Statement of Profit & Loss" ur="نفع و نقصان" right={<span className="text-xs text-slate-500">Rupees · {p.from?.slice(0, 10)} to {p.to?.slice(0, 10)}</span>}>
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <Head cols={["Particulars", ...cmp.map((c): [string, boolean] => [c, true])]} />
          <tbody>
            <Line label="Revenue" ur="آمدن" v={p.income.total} q={q?.income.total} kind="sub" />
            <Line label="Fuel sales — retail (pump)" v={p.income.fuel_retail} q={q?.income.fuel_retail} level={1} />
            <Line label="Fuel sales — wholesale" v={p.income.fuel_wholesale} q={q?.income.fuel_wholesale} level={1} />
            <Line label="Shop & lubricants" v={p.income.shop} q={q?.income.shop} level={1} />
            <Line label="Cost of sales" ur="بیچے مال کی لاگت" v={-p.cost_of_sales.total} q={q ? -q.cost_of_sales.total : null} kind="sub" neg />
            <Line label="Fuel purchased (avg cost)" v={-p.cost_of_sales.fuel} q={q ? -q.cost_of_sales.fuel : null} level={1} neg />
            <Line label="Shop goods" v={-p.cost_of_sales.shop} q={q ? -q.cost_of_sales.shop : null} level={1} neg />
            {(p.cost_of_sales.stock_gain_loss || q?.cost_of_sales.stock_gain_loss) ? <Line label="Tank stock gain / (loss)" v={p.cost_of_sales.stock_gain_loss} q={q?.cost_of_sales.stock_gain_loss} level={1} /> : null}
            <Line label="Gross profit" ur="مجموعی منافع" v={p.gross_profit} q={q?.gross_profit} kind="total" />
            {p.wholesale_margin?.litres ? <tr className="border-b border-slate-100 text-xs text-slate-500"><td className={TD} style={{ paddingLeft: 30 }}>of which wholesale: {num(p.wholesale_margin.litres)} L · avg sell Rs {p.wholesale_margin.avg_rate} − cost Rs {p.wholesale_margin.avg_cost}</td><td className={`${TD} text-right tabular-nums`}>{acc(p.wholesale_margin.profit)}</td>{q && <><td /><td /></>}</tr> : null}
            <Line label="Other income" ur="دیگر آمدن" v={otherIncome} q={qOther} kind="sub" />
            {p.other_income_misc ? <Line label="Rent, bank profit, misc." v={p.other_income_misc} q={q?.other_income_misc} level={1} /> : null}
            {p.other_income - (p.other_income_misc ?? 0) > 0.5 ? <Line label="Carriage / kiraya" v={p.other_income - (p.other_income_misc ?? 0)} q={q ? q.other_income - (q.other_income_misc ?? 0) : null} level={1} /> : null}
            {p.other_income_ceo ? <Line label="Other income (CEO entries)" v={p.other_income_ceo} q={q?.other_income_ceo} level={1} /> : null}
            <Line label="Operating expenses" ur="اخراجات" v={-p.expenses.total} q={q ? -q.expenses.total : null} kind="sub" neg />
            {byCat.map((c) => <Line key={c.category} label={c.category} v={-c.amount} q={q ? -qCat(c.category) : null} level={1} neg />)}
            {p.other_discount_ceo ? <Line label="Discounts & concessions (CEO)" v={-p.other_discount_ceo} q={q ? -q.other_discount_ceo : null} kind="sub" neg /> : null}
            <Line label="Net profit for the period" ur="خالص منافع" v={p.net_profit} q={q?.net_profit} kind="grand" />
          </tbody>
        </table></div>
        <div className="flex flex-wrap justify-between gap-2 px-4 py-2 text-xs text-slate-500">
          <span>Litres sold: retail {num(p.litres.retail)} L · wholesale {num(p.litres.wholesale)} L · gross margin {num(p.gross_margin_pct, 1)}% · net margin {num(p.margin_pct, 1)}%</span>
          <span>Brackets ( ) = a cost or a loss</span>
        </div>
      </Sec>
    </div>
  );
}

/* ---------------- Balance Sheet ---------------- */
function BalanceSheet({ bs, p }: { bs: any; p: any }) {
  const assets = Object.entries(bs.assets).filter(([, v]) => Math.abs(v as number) >= 0.5) as [string, number][];
  const liabs = Object.entries(bs.liabilities).filter(([, v]) => Math.abs(v as number) >= 0.5) as [string, number][];
  const equity = bs.net_worth;
  const retained = equity - p.net_profit; // what the owner had before this month's result
  const col = (rows: [string, number][], total: [string, number]) => (
    <table className="w-full text-sm"><tbody>
      {rows.map(([k, v]) => <tr key={k} className="border-b border-slate-100"><td className={TD}>{nice(k)}</td><td className={`${TD} text-right tabular-nums`}>{acc(v)}</td></tr>)}
      <tr className="bg-slate-50 font-bold"><td className={TD}>{total[0]}</td><td className={`${TD} text-right tabular-nums`}>{acc(total[1])}</td></tr>
    </tbody></table>
  );
  return (
    <Sec title="Balance Sheet" ur="بیلنس شیٹ" right={<span className="text-xs text-slate-500">As at {new Date(bs.as_of).toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" })} · Rupees</span>}>
      <div className="grid grid-cols-1 divide-y divide-slate-200 md:grid-cols-2 md:divide-x md:divide-y-0">
        <div>
          <div className={`${TH} border-b border-slate-300 bg-slate-100`}>Assets · <Ur className="font-normal">اثاثے</Ur></div>
          {col(assets, ["Total assets", bs.total_assets])}
        </div>
        <div>
          <div className={`${TH} border-b border-slate-300 bg-slate-100`}>Liabilities & owner's equity · <Ur className="font-normal">واجبات اور سرمایہ</Ur></div>
          {col(liabs, ["Total liabilities", bs.total_liabilities])}
          <table className="w-full text-sm"><tbody>
            <tr className="border-b border-slate-100"><td className={TD}>Owner's equity b/f</td><td className={`${TD} text-right tabular-nums`}>{acc(retained)}</td></tr>
            <tr className="border-b border-slate-100"><td className={TD}>Add: net profit this month</td><td className={`${TD} text-right tabular-nums ${p.net_profit < 0 ? "text-red-700" : ""}`}>{acc(p.net_profit)}</td></tr>
            <tr className="bg-slate-50 font-bold"><td className={TD}>Owner's equity (net worth)</td><td className={`${TD} text-right tabular-nums ${equity < 0 ? "text-red-700" : ""}`}>{acc(equity)}</td></tr>
            <tr className="bg-brand-50 font-extrabold text-brand-900"><td className={TD}>Total liabilities & equity</td><td className={`${TD} text-right tabular-nums`}>{acc(bs.total_liabilities + equity)}</td></tr>
          </tbody></table>
        </div>
      </div>
      <div className="flex flex-wrap justify-between gap-2 px-4 py-2 text-xs text-slate-500">
        <span className="text-emerald-700">Balanced ✓ · Assets {num(bs.total_assets)} = Liabilities {num(bs.total_liabilities)} + Equity {num(equity)}</span>
        <span>{bs.note}</span>
      </div>
    </Sec>
  );
}

/* ---------------- Trial Balance ---------------- */
export function TrialBalance({ d }: { d: any }) {
  const [q, setQ] = useState("");
  const rows = (d.trial_balance as any[]).filter((a) => !q || a.account.toLowerCase().includes(q.toLowerCase()));
  const dr = rows.reduce((a, x) => a + x.debit, 0), cr = rows.reduce((a, x) => a + x.credit, 0);
  return (
    <Sec title="Trial Balance" ur="ٹرائل بیلنس" right={<span className="text-xs text-slate-500">{d.from} to {d.to} · {d.voucher_count ?? d.vouchers.length} vouchers</span>}>
      <div className="px-4 py-2 print:hidden"><ErpSearch value={q} onChange={setQ} placeholder="Account… · کھاتہ" className="w-full sm:w-72" /></div>
      <div className="overflow-x-auto"><table className="w-full text-sm tabular-nums">
        <Head cols={["Account", ["Debit", true], ["Credit", true], ["Balance Dr / (Cr)", true]]} />
        <tbody>
          {rows.map((a) => <tr key={a.account} className="border-b border-slate-100 hover:bg-slate-50"><td className={TD}>{a.account}</td><td className={`${TD} text-right`}>{acc(a.debit)}</td><td className={`${TD} text-right`}>{acc(a.credit)}</td><td className={`${TD} text-right ${a.balance < 0 ? "text-emerald-700" : ""}`}>{acc(a.balance)}</td></tr>)}
          {!rows.length && <tr><td colSpan={4} className="px-3 py-8 text-center text-slate-500">Kuch nahi mila</td></tr>}
          <tr className="border-t-2 border-slate-800 bg-slate-50 font-bold"><td className={TD}>Total</td><td className={`${TD} text-right`}>{num(dr)}</td><td className={`${TD} text-right`}>{num(cr)}</td><td className={`${TD} text-right ${Math.abs(dr - cr) < 1 ? "text-emerald-700" : "text-red-700"}`}>{Math.abs(dr - cr) < 1 ? "Balanced ✓" : acc(dr - cr)}</td></tr>
        </tbody>
      </table></div>
    </Sec>
  );
}

/* ---------------- Journal ---------------- */
export function Journal({ d }: { d: any }) {
  const [q, setQ] = useState("");
  const [acct, setAcct] = useState("");
  const all: any[] = useMemo(() => [...d.vouchers].reverse(), [d]);
  const accounts = useMemo(() => Array.from(new Set(all.flatMap((v) => v.lines.map((l: any) => String(l.account))))).sort(), [all]);
  const needle = q.trim().toLowerCase();
  const rows = all.filter((v) => (!acct || v.lines.some((l: any) => l.account === acct)) && (!needle || [v.no, v.type, v.narration, v.date, ...v.lines.flatMap((l: any) => [l.account, l.debit, l.credit])].some((x) => String(x ?? "").toLowerCase().includes(needle))));
  const paged = usePaged(rows, 10);
  useEffect(() => { paged.setPage(1); }, [needle, acct]);
  return (
    <Sec title="Journal" ur="جرنل" right={<span className="text-xs text-slate-500">{d.from} to {d.to} · {all.length} vouchers</span>}>
      <div className="flex flex-wrap gap-2 px-4 py-2 print:hidden">
        <ErpSearch value={q} onChange={setQ} placeholder="Voucher no, narration, account, raqam… · تلاش" className="w-full sm:w-80" />
        <select className="input w-auto" value={acct} onChange={(e) => setAcct(e.target.value)} aria-label="Account"><option value="">All accounts</option>{accounts.map((a) => <option key={a} value={a}>{a}</option>)}</select>
      </div>
      <div className="overflow-x-auto"><table className="w-full text-sm">
        <Head cols={["Date", "Voucher", "Account / narration", ["Debit", true], ["Credit", true]]} />
        <tbody>
          {(paged.slice as any[]).map((v) => (
            <Fragment key={v.no}>
              <tr className="border-t border-slate-200 bg-slate-50/60"><td className={`${TD} whitespace-nowrap font-medium`}>{v.date}</td><td className={`${TD} whitespace-nowrap font-semibold text-brand-800`}>{v.no}</td><td className={`${TD} text-slate-700`} colSpan={3}><span className="mr-2 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-600">{v.type}</span>{v.narration}</td></tr>
              {v.lines.map((l: any, i: number) => (
                <tr key={i} className={`border-b border-slate-100 ${acct && l.account === acct ? "bg-amber-50" : ""}`}><td /><td /><td className={TD} style={{ paddingLeft: l.credit ? 40 : 12 }}>{l.credit ? "To " : ""}{l.account}</td><td className={`${TD} text-right tabular-nums`}>{l.debit ? num(l.debit) : ""}</td><td className={`${TD} text-right tabular-nums`}>{l.credit ? num(l.credit) : ""}</td></tr>
              ))}
            </Fragment>
          ))}
          {!rows.length && <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-500">{needle || acct ? "Kuch nahi mila" : "Is muddat mein koi voucher nahi"}</td></tr>}
        </tbody>
      </table></div>
      <div className="px-4 pb-2"><Pager {...paged} /></div>
    </Sec>
  );
}

/* ---------------- Receivable aging ---------------- */
function Aging({ a, w }: { a: any; w: any }) {
  const wsA = w?.ageing ?? { d0_15: 0, d16_30: 0, d31_60: 0, d60: 0 };
  const wsRows = [["0–30 days", wsA.d0_15 + wsA.d16_30], ["31–60 days", wsA.d31_60], ["61+ days", wsA.d60]] as [string, number][];
  const wsTotal = wsRows.reduce((s, [, v]) => s + v, 0);
  const paged = usePaged((a.list as any[]).filter((c) => c.balance > 0.5), 10);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Sec title="Khata receivable by age" ur="کھاتہ">
          <table className="w-full text-sm tabular-nums"><Head cols={["Age", ["Amount", true], ["%", true]]} /><tbody>
            {a.buckets.map((b: any) => <tr key={b.bucket} className="border-b border-slate-100"><td className={TD}>{b.bucket}</td><td className={`${TD} text-right ${b.bucket.startsWith("9") ? "text-red-700" : ""}`}>{acc(b.amount)}</td><td className={`${TD} text-right text-slate-500`}>{a.total ? Math.round((b.amount / a.total) * 100) : 0}%</td></tr>)}
            <tr className="bg-slate-50 font-bold"><td className={TD}>Total khata receivable</td><td className={`${TD} text-right`}>{num(a.total)}</td><td /></tr>
            <tr className="text-red-700"><td className={TD}>of which overdue (31+ days)</td><td className={`${TD} text-right font-semibold`}>{num(a.overdue)}</td><td className={`${TD} text-right`}>{a.total ? Math.round((a.overdue / a.total) * 100) : 0}%</td></tr>
          </tbody></table>
        </Sec>
        <Sec title="Wholesale receivable by age" ur="ہول سیل">
          <table className="w-full text-sm tabular-nums"><Head cols={["Age", ["Amount", true], ["%", true]]} /><tbody>
            {wsRows.map(([l, v]) => <tr key={l} className="border-b border-slate-100"><td className={TD}>{l}</td><td className={`${TD} text-right ${l.startsWith("61") ? "text-red-700" : ""}`}>{acc(v)}</td><td className={`${TD} text-right text-slate-500`}>{wsTotal ? Math.round((v / wsTotal) * 100) : 0}%</td></tr>)}
            <tr className="bg-slate-50 font-bold"><td className={TD}>Total wholesale receivable</td><td className={`${TD} text-right`}>{num(wsTotal)}</td><td /></tr>
            <tr className="text-red-700"><td className={TD}>of which overdue (31+ days)</td><td className={`${TD} text-right font-semibold`}>{num(wsA.d31_60 + wsA.d60)}</td><td className={`${TD} text-right`}>{wsTotal ? Math.round(((wsA.d31_60 + wsA.d60) / wsTotal) * 100) : 0}%</td></tr>
          </tbody></table>
        </Sec>
      </div>
      <Sec title="Khata customers — aging detail" ur="گاہک وار" right={<span className="text-xs text-slate-500">{paged.total} customers with a balance</span>}>
        <div className="overflow-x-auto"><table className="w-full text-sm tabular-nums">
          <Head cols={["Customer", ["0–30", true], ["31–60", true], ["61–90", true], ["90+", true], ["Balance", true], ["Overdue", true]]} />
          <tbody>{(paged.slice as any[]).map((c) => (
            <tr key={c.id} className="border-b border-slate-100 hover:bg-slate-50"><td className={TD}><b>{c.name}</b>{c.phone && <span className="ml-2 text-xs text-slate-500">{c.phone}</span>}</td>
              {c.buckets.map((v: number, i: number) => <td key={i} className={`${TD} text-right ${i >= 2 && v > 0 ? "text-red-700" : ""}`}>{acc(v)}</td>)}
              <td className={`${TD} text-right font-semibold`}>{num(c.balance)}</td><td className={`${TD} text-right ${c.overdue > 0 ? "font-semibold text-red-700" : "text-slate-400"}`}>{acc(c.overdue)}</td></tr>
          ))}{!paged.total && <tr><td colSpan={7} className="px-3 py-8 text-center text-emerald-700">Koi baqaya nahi ✓</td></tr>}</tbody>
        </table></div>
        <div className="px-4 pb-2"><Pager {...paged} /></div>
      </Sec>
    </div>
  );
}

/* ---------------- Monthly pack: the one-page print ---------------- */
function MonthlyPack({ p, bs, a, w, gl, month }: { p: any; bs: any; a: any; w: any; gl: any; month: string }) {
  const R = ({ l, v, b, tone }: { l: string; v: number; b?: boolean; tone?: "red" | "green" }) => (
    <div className={`flex justify-between py-0.5 ${b ? "border-t border-slate-300 font-bold" : ""}`}><span className={b ? "" : "text-slate-600"}>{l}</span><span className={`tabular-nums ${tone === "red" ? "text-red-700" : tone === "green" ? "text-emerald-700" : ""}`}>{acc(v, "0")}</span></div>
  );
  const lossTanks = ((gl?.tanks ?? []) as any[]).filter((t) => t.gain_loss_l < 0);
  const wsA = w?.ageing;
  return (
    <div className="mx-auto max-w-4xl rounded-xl border border-slate-200 bg-white p-6 text-sm print:border-0 print:p-0">
      <div className="mb-3 text-center"><div className="text-lg font-extrabold">Monthly financial pack — {monthName(month)}</div><div className="text-xs text-slate-500">Rupees · brackets = cost / loss · prepared by Petrol PumpAI</div></div>
      <div className="grid gap-6 sm:grid-cols-2">
        <section><h3 className="mb-1 border-b-2 border-brand-700 font-bold text-brand-800">Profit & Loss</h3>
          <R l="Fuel — retail" v={p.income.fuel_retail} /><R l="Fuel — wholesale" v={p.income.fuel_wholesale} /><R l="Shop & lubricants" v={p.income.shop} /><R l="Revenue" v={p.income.total} b />
          <R l="Cost of sales" v={-p.cost_of_sales.total} /><R l="Gross profit" v={p.gross_profit} b tone={p.gross_profit >= 0 ? "green" : "red"} />
          <R l="Other income" v={p.other_income + (p.other_income_ceo ?? 0)} /><R l="Operating expenses" v={-p.expenses.total} />{p.other_discount_ceo ? <R l="Discounts (CEO)" v={-p.other_discount_ceo} /> : null}
          <R l="NET PROFIT" v={p.net_profit} b tone={p.net_profit >= 0 ? "green" : "red"} />
          <div className="mt-1 text-right text-xs text-slate-500">Net margin {num(p.margin_pct, 1)}% · {num(p.litres.retail + p.litres.wholesale)} L sold</div>
        </section>
        <section><h3 className="mb-1 border-b-2 border-brand-700 font-bold text-brand-800">Balance Sheet (today)</h3>
          <div className="text-xs font-semibold text-slate-500">Assets</div>
          {Object.entries(bs.assets).filter(([, v]) => Math.abs(v as number) >= 0.5).map(([k, v]) => <R key={k} l={nice(k)} v={v as number} />)}<R l="Total assets" v={bs.total_assets} b />
          <div className="mt-1 text-xs font-semibold text-slate-500">Liabilities</div>
          {Object.entries(bs.liabilities).filter(([, v]) => Math.abs(v as number) >= 0.5).map(([k, v]) => <R key={k} l={nice(k)} v={v as number} />)}<R l="Total liabilities" v={bs.total_liabilities} b />
          <R l="OWNER'S EQUITY" v={bs.net_worth} b tone={bs.net_worth >= 0 ? "green" : "red"} />
        </section>
        <section><h3 className="mb-1 border-b-2 border-brand-700 font-bold text-brand-800">Receivable aging</h3>
          {a.buckets.map((b: any) => <R key={b.bucket} l={`Khata ${b.bucket}`} v={b.amount} tone={b.bucket.startsWith("9") ? "red" : undefined} />)}<R l="Khata receivable" v={a.total} b />
          {wsA && <><R l="Wholesale 0–30 days" v={wsA.d0_15 + wsA.d16_30} /><R l="Wholesale 31–60 days" v={wsA.d31_60} /><R l="Wholesale 61+ days" v={wsA.d60} tone="red" /><R l="Wholesale receivable" v={wsA.d0_15 + wsA.d16_30 + wsA.d31_60 + wsA.d60} b /></>}
          {a.list.filter((c: any) => c.overdue > 0).slice(0, 5).length > 0 && <><div className="mt-1 text-xs font-semibold text-slate-500">Top overdue khata</div>{a.list.filter((c: any) => c.overdue > 0).slice(0, 5).map((c: any) => <R key={c.id} l={c.name} v={c.overdue} tone="red" />)}</>}
        </section>
        <section><h3 className="mb-1 border-b-2 border-brand-700 font-bold text-brand-800">Tank stock gain / (loss)</h3>
          {!gl ? <div className="text-slate-500">Loading…</div> : !lossTanks.length ? <div className="text-emerald-700">No notable loss — all tanks within tolerance ✓</div> : (
            <table className="w-full"><thead><tr className="text-left text-xs text-slate-500"><th>Tank</th><th className="text-right">Litres</th><th className="text-right">%</th><th className="text-right">Value</th></tr></thead>
              <tbody>{lossTanks.map((t) => <tr key={t.id} className="border-t border-slate-100"><td className="py-0.5">{t.name} <span className="text-xs text-slate-400">{t.product}</span></td><td className="text-right tabular-nums text-red-700">({num(Math.abs(t.gain_loss_l), 1)})</td><td className={`text-right tabular-nums ${t.status === "leak_suspected" ? "font-bold text-red-700" : ""}`}>{num(t.pct, 2)}%</td><td className="text-right tabular-nums">({num(Math.abs(t.value))})</td></tr>)}</tbody></table>
          )}
          <div className="mt-2 text-xs text-slate-500">Staff advances outstanding: {pkr(bs.assets.staff_advances ?? 0)}</div>
        </section>
      </div>
      <div className="mt-8 hidden grid-cols-2 gap-10 text-center text-xs text-slate-600 print:grid"><div className="border-t border-slate-400 pt-1">Prepared by</div><div className="border-t border-slate-400 pt-1">Owner / CEO</div></div>
    </div>
  );
}
