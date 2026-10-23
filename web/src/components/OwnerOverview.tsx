import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowDownCircle, ArrowUpCircle, Banknote, Landmark, Scale, TrendingUp, Users, FileCheck2, ChevronDown, Receipt, ArrowUpRight, ArrowDownRight, Fuel, Wallet, Coins } from "lucide-react";
import { useApi } from "../lib/api";
import { Loading, CountUp, pkDay } from "./ui";
import { Ur } from "./VoiceShell";
import { BankLogo } from "./BankParts";
import { ModuleFeeds } from "./DayFeed";
import { num, pkr, pkrShort } from "../lib/format";
import { useAuth } from "../App";

const Row = ({ label, ur, v, to, tone = "", note }: { label: string; ur: string; v: number; to?: string; tone?: string; note?: string }) => {
  const body = (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <span className="min-w-0">{label} · <Ur className="text-slate-500">{ur}</Ur>{note && <span className="block text-xs text-slate-500">{note}</span>}</span>
      <span className={`shrink-0 font-semibold tabular-nums ${tone}`}>{pkr(v)}</span>
    </div>
  );
  return to ? <Link to={to} className="block rounded-lg px-1 -mx-1 hover:bg-slate-50">{body}</Link> : body;
};

/** The owner's first look: where the money is, who owes what, today across every module, and this month's profit. */
export function OwnerOverview() {
  const { can } = useAuth();
  const { data } = useApi<any>("/owner/overview", 60_000);
  const nav = useNavigate();
  const { modules } = useAuth();
  if (!data) return <div className="card"><Loading /></div>;
  const m = data.money, o = data.owed_to_us, w = data.we_owe, t = data.today, mo = data.month;
  return (
    <div className="space-y-4">
      <VitalsStrip data={data} m={m} o={o} w={w} t={t} mo={mo} />
      {/* where the money is */}
      <div className="overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-700 p-4 text-white shadow">
        <div className="flex items-center gap-1.5 text-sm opacity-90"><Banknote size={16} /> Your money right now · <Ur>آپ کا پیسہ ابھی</Ur></div>
        <div className="text-3xl font-bold tabular-nums sm:text-4xl"><CountUp value={m.total} format={pkr} /></div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
          <Link to="/cash" className="rounded-xl bg-white/10 p-2 hover:bg-white/15"><div className="text-xs opacity-80">Office cash · <Ur>نقد</Ur></div><Amt v={m.office_cash} /></Link>
          <Link to="/shifts" className="rounded-xl bg-white/10 p-2 hover:bg-white/15"><div className="text-xs opacity-80">With salesmen · <Ur>سیلزمین</Ur></div><Amt v={m.with_salesmen} /></Link>
          <Link to="/cash" className="rounded-xl bg-white/10 p-2 hover:bg-white/15"><div className="text-xs opacity-80">Banks · <Ur>بینک</Ur></div><Amt v={m.banks} /></Link>
        </div>
        {m.cheques_in.n > 0 && <Link to="/cashier?tab=cheques" className="mt-2 flex items-center gap-1.5 text-xs opacity-90 hover:underline"><FileCheck2 size={14} /> + {pkr(m.cheques_in.amount)} in {m.cheques_in.n} cheque{m.cheques_in.n === 1 ? "" : "s"} not cleared yet · <Ur>چیک ابھی کلیئر نہیں</Ur></Link>}
        {!m.last_count && <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-400/20 px-2 py-1.5 text-xs text-amber-100"><AlertTriangle size={14} className="mt-0.5 shrink-0" />Office cash has never been counted — ask the cashier to count it once so the book starts right · <Ur>ایک بار کیش گنوائیں</Ur></p>}
        {m.accounts.length > 0 && (
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {m.accounts.map((a: any) => (
              <Link key={a.id} to="/cash" className="flex shrink-0 items-center gap-2 rounded-xl bg-white/10 px-2.5 py-1.5 text-xs hover:bg-white/15">
                <BankLogo name={a.bank} size={22} /><span><span className="block opacity-80">{a.bank.replace(/\s*\(.*\)/, "")}</span><b className="tabular-nums">{pkrShort(a.balance)}</b></span>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3 [&>*]:min-w-0">
        {/* lena / dena */}
        <div className="card p-4">
          <h2 className="mb-1 flex items-center gap-2 font-semibold"><Scale size={17} /> Owed to us / we owe · <Ur>لینا / دینا</Ur></h2>
          <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Others owe us · <Ur>لینا</Ur></div>
          <Row label="Khata customers" ur="کھاتہ" v={o.khata} to="/khata" />
          {modules.wholesale && <Row label="Wholesale clients" ur="ہول سیل" v={o.wholesale} to="/wholesale?tab=collect" />}
          {o.staff_advances > 0 && <Row label="Staff advances" ur="ملازمین" v={o.staff_advances} to="/staff" />}
          <div className="mt-2 text-xs font-semibold uppercase tracking-wide text-rose-700">We owe · <Ur>دینا</Ur></div>
          <Row label="Suppliers (depots)" ur="سپلائر" v={w.suppliers} to="/suppliers" tone="text-rose-700"
            note={w.cheques_issued.n ? `${pkr(w.cheques_issued.amount)} of it in ${w.cheques_issued.n} cheque${w.cheques_issued.n === 1 ? "" : "s"} given, not yet paid by the bank` : undefined} />
          {w.customer_advances > 0 && <Row label="Customer advances" ur="ایڈوانس" v={w.customer_advances} tone="text-rose-700" />}
          {w.unused_coupons > 0 && <Row label="Unused fuel coupons" ur="کوپن" v={w.unused_coupons} to="/prepaid" tone="text-rose-700" />}
          {w.withholding_tax > 0 && <Row label="Tax to deposit (FBR)" ur="ٹیکس" v={w.withholding_tax} to="/accounts" tone="text-rose-700" />}
          {w.pending_expenses > 0 && <Row label="Expenses waiting approval" ur="منظوری" v={w.pending_expenses} to="/expenses" tone="text-rose-700" />}
          {data.dues && <DuesDetail dues={data.dues} />}
          <div className="mt-2 flex items-baseline justify-between border-t-2 border-slate-800 pt-2">
            <span className="font-semibold">Net position · <Ur>کل مالیت</Ur><span className="block text-xs font-normal text-slate-500">money + owed to us − we owe (stock not included)</span></span>
            <span className={`shrink-0 text-xl font-bold tabular-nums ${data.net_position < 0 ? "text-red-600" : "text-emerald-700"}`}>{pkr(data.net_position)}</span>
          </div>
        </div>

        {/* today */}
        <div className="card p-4">
          <h2 className="mb-1 flex items-center gap-2 font-semibold"><TrendingUp size={17} /> Today · <Ur>آج</Ur></h2>
          <Row label={`Fuel sold (${num(t.retail_litres)} L)`} ur="فیول سیل" v={t.retail_sales} to="/reports" />
          {modules.wholesale && t.wholesale ? <Row label={`Wholesale (${num(t.wholesale_litres)} L)`} ur="ہول سیل" v={t.wholesale} to="/wholesale" /> : null}
          {t.shop ? <Row label="Shop & lubricants" ur="دکان" v={t.shop} to="/shop" /> : null}
          <div className="mt-1 grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-xl bg-emerald-50 p-2"><div className="flex items-center gap-1 text-xs text-emerald-800"><ArrowDownCircle size={13} /> Money in · <Ur>آیا</Ur></div>
              <div className="font-semibold tabular-nums text-emerald-800">{pkr(t.money_in.cash + t.money_in.bank)}</div><div className="text-[11px] text-emerald-700">cash {pkrShort(t.money_in.cash)} · bank {pkrShort(t.money_in.bank)}</div></div>
            <div className="rounded-xl bg-rose-50 p-2"><div className="flex items-center gap-1 text-xs text-rose-800"><ArrowUpCircle size={13} /> Money out · <Ur>گیا</Ur></div>
              <div className="font-semibold tabular-nums text-rose-800">{pkr(t.money_out.cash + t.money_out.bank)}</div><div className="text-[11px] text-rose-700">cash {pkrShort(t.money_out.cash)} · bank {pkrShort(t.money_out.bank)}</div></div>
          </div>
          {t.deposited > 0 && <Row label="Cash put in bank" ur="بینک میں جمع" v={t.deposited} to="/cash" />}
          {t.profit_estimate != null && <Row label="Profit on today's sales (est.)" ur="منافع" v={t.profit_estimate} to="/insights" tone="text-emerald-700"
            note={t.cost_assumed?.length ? `${t.cost_assumed.join(", ")} ki khareed rate nahi — pump price par cost mana (0 margin). Opening balances → Tank stock me rate likhein.` : t.cost_missing?.length ? `${t.cost_missing.join(", ")} ka cost pata nahi — Opening balances me rate likhein` : undefined} />}
          <Link to="/cashier?tab=daybook" className="mt-1 inline-block py-1 text-xs font-medium text-brand-700 hover:underline">Day book — every entry · <Ur>روزنامچہ</Ur> →</Link>
        </div>

        {/* this month */}
        <div className="card p-4">
          <h2 className="mb-1 flex items-center gap-2 font-semibold"><Landmark size={17} /> This month · <Ur>اس مہینے</Ur></h2>
          <Row label="Sales (all)" ur="کل سیل" v={mo.income} to="/reports" />
          <Row label="Gross profit" ur="مجموعی منافع" v={mo.gross_profit} />
          <Row label="Expenses" ur="خرچے" v={mo.expenses} to="/expenses" tone="text-rose-700" />
          <div className="mt-2 flex items-baseline justify-between border-t-2 border-slate-800 pt-2">
            <span className="font-semibold">Net profit · <Ur>خالص منافع</Ur><span className="block text-xs font-normal text-slate-500">{mo.margin_pct}% of sales</span></span>
            <span className={`shrink-0 text-xl font-bold tabular-nums ${mo.net_profit < 0 ? "text-red-600" : "text-emerald-700"}`}>{pkr(mo.net_profit)}</span>
          </div>
          <Link to="/insights" className="mt-1 inline-block py-1 text-xs font-medium text-brand-700 hover:underline">Profit & loss, balance sheet → </Link>
        </div>
      </div>

      {/* each module's own live feed — POS / cashier / wholesale — pulled up right here on the CEO dashboard */}
      <ModuleFeeds />

      {/* kharcha kis cheez par: category-wise, today / 7 days / month / any dates */}
      {can("expenses.view") && <ExpenseBreakdown />}

      {/* every module today */}
      <div className="card p-4">
        <h2 className="mb-2 flex items-center gap-2 font-semibold"><Users size={17} /> What happened today · <Ur>آج کیا ہوا</Ur></h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {data.activity.map((a: any) => (
            <Link key={a.key} to={a.to} className={`rounded-xl p-2.5 ring-1 ring-slate-200 hover:bg-slate-50 ${a.n ? "" : "opacity-60"}`}>
              <div className="text-xs text-slate-500">{a.en}<Ur className="block">{a.ur}</Ur></div>
              <div className="font-semibold tabular-nums">{a.v != null ? pkrShort(a.v) : a.l != null ? `${num(a.l)} L` : a.n}</div>
              <div className="text-[11px] text-slate-500">{a.n} {a.n === 1 ? "entry" : "entries"}</div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

/** One-glance vitals: the eight numbers a CEO wants the moment the app opens. Horizontally scrolls on a phone,
 *  an even grid on a wider screen. Each tile taps through to the page behind it; trend arrows compare today to
 *  yesterday (green up / red down). */
function VitalsStrip({ data, m, o, w, t, mo }: { data: any; m: any; o: any; w: any; t: any; mo: any }) {
  const tiles = [
    { icon: Banknote, label: "Paisa abhi", ur: "پیسہ", v: m.total, to: "/cash", tone: "text-slate-900", accent: "bg-slate-100 text-slate-700" },
    { icon: Wallet, label: "Aaj sale", ur: "آج سیل", v: t.sale ?? t.retail_sales, to: "/reports", tone: "text-slate-900", accent: "bg-emerald-100 text-emerald-700", trend: t.vs_yesterday_pct, trendNote: "vs kal" },
    { icon: TrendingUp, label: "Aaj munafa", ur: "منافع", v: t.profit_estimate, to: "/insights", tone: "text-emerald-700", accent: "bg-emerald-100 text-emerald-700" },
    { icon: Fuel, label: "Aaj litre", ur: "لیٹر", v: null, raw: `${num(t.retail_litres)} L`, to: "/reports", tone: "text-slate-900", accent: "bg-blue-100 text-blue-700" },
    { icon: ArrowDownRight, label: "Lena", ur: "لینا", v: o.total, to: "/khata", tone: "text-emerald-700", accent: "bg-emerald-100 text-emerald-700" },
    { icon: ArrowUpRight, label: "Dena", ur: "دینا", v: w.total, to: "/suppliers", tone: "text-rose-700", accent: "bg-rose-100 text-rose-700" },
    { icon: Landmark, label: "Mahine ka munafa", ur: "اس مہینے", v: mo.net_profit, to: "/insights", tone: mo.net_profit < 0 ? "text-rose-700" : "text-emerald-700", accent: "bg-violet-100 text-violet-700", note: `${mo.margin_pct}% margin` },
    { icon: Scale, label: "Kul maaliyat", ur: "کل مالیت", v: data.net_position, to: "/insights", tone: data.net_position < 0 ? "text-rose-700" : "text-slate-900", accent: "bg-amber-100 text-amber-700", note: "paisa + lena − dena" },
  ];
  return (
    <div className="-mx-1 flex gap-2.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] sm:grid sm:grid-cols-3 sm:overflow-visible lg:grid-cols-4 xl:grid-cols-8">
      {tiles.map((tl) => {
        const Icon = tl.icon;
        const up = typeof tl.trend === "number" && tl.trend > 0, down = typeof tl.trend === "number" && tl.trend < 0;
        return (
          <Link key={tl.label} to={tl.to} className="min-w-[8.5rem] shrink-0 rounded-2xl bg-white p-3 ring-1 ring-slate-200 transition hover:ring-brand-300 sm:min-w-0">
            <div className="flex items-center justify-between">
              <span className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${tl.accent}`}><Icon size={15} /></span>
              {typeof tl.trend === "number" && (
                <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${up ? "bg-emerald-50 text-emerald-700" : down ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-500"}`}>
                  {up ? <ArrowUpRight size={11} /> : down ? <ArrowDownRight size={11} /> : null}{Math.abs(tl.trend)}%
                </span>
              )}
            </div>
            <div className="mt-2 truncate text-[11px] font-medium uppercase tracking-wide text-slate-500">{tl.label} · <Ur className="normal-case">{tl.ur}</Ur></div>
            <div className={`truncate text-lg font-bold tabular-nums ${tl.tone}`}>{tl.raw ?? pkrShort(tl.v ?? 0)}</div>
            {tl.note && <div className="truncate text-[11px] text-slate-400">{tl.note}</div>}
            {tl.trendNote && typeof tl.trend === "number" && <div className="truncate text-[11px] text-slate-400">{tl.trendNote}</div>}
          </Link>
        );
      })}
    </div>
  );
}

/** Full rupees where there is room; short ("Rs 39.2 L") in the small boxes on a phone. */
const Amt = ({ v }: { v: number }) => (
  <div className="font-semibold tabular-nums"><span className="sm:hidden">{pkrShort(v)}</span><span className="hidden sm:inline"><CountUp value={v} format={pkr} /></span></div>
);

/** Named parties: who owes us and whom we owe — the figures above, person by person (tap to open the account). */
function DuesDetail({ dues }: { dues: { receivable: any[]; payable: any[]; receivable_total: number; payable_total: number } }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<"rec" | "pay" | null>(null);
  const List = ({ rows, tone, which }: { rows: any[]; tone: string; which: "rec" | "pay" }) => {
    const show = all === which ? rows : rows.slice(0, 6);
    return (
      <ul className="divide-y divide-slate-100 text-sm">
        {show.map((d) => (
          <li key={`${d.kind}-${d.id}`} className="flex items-center justify-between gap-2 py-1">
            <Link to={d.to} className="min-w-0 truncate hover:underline">{d.name}<span className="ml-1 text-[11px] text-slate-400">{KIND[d.kind] ?? d.kind}</span></Link>
            <span className={`shrink-0 tabular-nums font-medium ${tone}`}>{pkr(d.amount)}</span>
          </li>
        ))}
        {rows.length > 6 && all !== which && <li className="py-1"><button className="text-xs text-brand-700 hover:underline" onClick={() => setAll(which)}>+ {rows.length - 6} aur dekhein</button></li>}
        {!rows.length && <li className="py-1 text-xs text-slate-400">koi nahi</li>}
      </ul>
    );
  };
  return (
    <div className="mt-2 border-t border-slate-100 pt-2">
      <button className="flex w-full items-center justify-between text-sm font-medium text-brand-700" onClick={() => setOpen(!open)}>
        <span>Kis ko kitna · <Ur>کس کو کتنا</Ur> <span className="text-xs font-normal text-slate-500">{dues.receivable.length} lena · {dues.payable.length} dena</span></span>
        <ChevronDown size={16} className={`transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div><div className="mb-1 text-xs font-semibold uppercase tracking-wide text-emerald-700">Lena · {pkr(dues.receivable_total)}</div><List rows={dues.receivable} tone="text-emerald-700" which="rec" /></div>
          <div><div className="mb-1 text-xs font-semibold uppercase tracking-wide text-rose-700">Dena · {pkr(dues.payable_total)}</div><List rows={dues.payable} tone="text-rose-700" which="pay" /></div>
        </div>
      )}
    </div>
  );
}
const KIND: Record<string, string> = { khata: "khata", wholesale: "wholesale", carriage: "thekedar", staff: "staff", supplier: "supplier", khata_advance: "khata", wholesale_advance: "wholesale", carriage_advance: "thekedar", supplier_advance: "supplier" };

/** Expenses by category: today / 7 days / this month / any dates — "Tea & food par aaj itna, hafte me itna". */
function ExpenseBreakdown() {
  const today = pkDay(new Date().toISOString());
  const shift = (d: number) => pkDay(new Date(Date.now() - d * 86_400_000).toISOString());
  const [mode, setMode] = useState<"today" | "week" | "month" | "custom">("today");
  const [from, setFrom] = useState(shift(29)); const [to, setTo] = useState(today);
  const range = mode === "today" ? { from: today, to: today } : mode === "week" ? { from: shift(6), to: today } : mode === "month" ? { from: today.slice(0, 7) + "-01", to: today } : { from, to };
  const { data } = useApi<any>(`/expenses/breakdown?from=${range.from}&to=${range.to}`);
  const chip = (k: typeof mode, label: string) => <button key={k} onClick={() => setMode(k)} className={`rounded-full px-3 py-1 text-xs font-medium ring-1 transition ${mode === k ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-slate-600 ring-slate-300"}`}>{label}</button>;
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold"><Receipt size={17} /> Kharcha kis cheez par · <Ur>خرچہ کس چیز پر</Ur></h2>
        <div className="flex flex-wrap items-center gap-1.5">{chip("today", "Aaj")}{chip("week", "7 din")}{chip("month", "Is mahina")}{chip("custom", "Tareekh chunein")}</div>
      </div>
      {mode === "custom" && <div className="mt-2 flex flex-wrap items-center gap-2 text-sm"><input type="date" className="input w-auto" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /><span>se</span><input type="date" className="input w-auto" value={to} min={from} onChange={(e) => setTo(e.target.value)} /><span>tak</span></div>}
      {!data ? <div className="skel mt-3 h-24" /> : (
        <>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="text-2xl font-bold tabular-nums text-rose-700"><CountUp value={data.total} format={pkr} /></span>
            <span className="text-xs text-slate-500">{data.days} din · {pkr(data.per_day)}/din{data.pending.n ? ` · ${data.pending.n} approval me (${pkr(data.pending.amount)})` : ""}</span>
          </div>
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {data.by_category.map((c: any) => (
              <li key={c.category} className="py-1.5">
                <div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate">{c.category} <span className="text-[11px] text-slate-400">{c.n} entries</span></span><span className="shrink-0 tabular-nums font-medium">{pkr(c.total)} <span className="text-[11px] font-normal text-slate-400">{c.pct}%</span></span></div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-rose-400 transition-all" style={{ width: `${c.pct}%` }} /></div>
              </li>
            ))}
            {!data.by_category.length && <li className="py-2 text-xs text-slate-400">Is muddat me koi kharcha nahi</li>}
          </ul>
          <Link to="/expenses" className="mt-1 inline-block py-1 text-xs font-medium text-brand-700 hover:underline">Sab kharche, approvals, budget → </Link>
        </>
      )}
    </div>
  );
}
