import { useEffect, useMemo, useState } from "react";
import { api, useApi } from "../lib/api";
import { Field, Loading, PageHeader, useAction } from "../components/ui";
import { pkr, num } from "../lib/format";
import { BookOpen, Truck, Landmark, Users, Fuel, Wallet, Search, Upload, Check } from "lucide-react";

type Tab = "khata" | "parties" | "banks" | "staff" | "stock" | "cash";
const TABS: { k: Tab; en: string; ur: string; icon: any }[] = [
  { k: "khata", en: "Khata customers", ur: "کھاتہ گاہک", icon: BookOpen },
  { k: "parties", en: "Suppliers · wholesale · thekedar", ur: "پارٹیاں", icon: Truck },
  { k: "banks", en: "Banks", ur: "بینک", icon: Landmark },
  { k: "staff", en: "Staff advances", ur: "عملہ ایڈوانس", icon: Users },
  { k: "stock", en: "Tank stock", ur: "ٹینک اسٹاک", icon: Fuel },
  { k: "cash", en: "Cash in drawer", ur: "نقد", icon: Wallet },
];
const Ur = ({ children }: { children: React.ReactNode }) => <span className="font-urdu" lang="ur" dir="rtl">{children}</span>;

/**
 * CEO-only, go-live on a pump that was already running: the balances brought forward from the old register.
 * Everything here can be re-entered until the owner is happy; the ledger books it against "Opening balances (go-live)",
 * never into profit.
 */
export default function OpeningBalances() {
  // ?tab=stock etc. lets the go-live checklist land on the right section
  const [tab, setTab] = useState<Tab>(() => { const q = new URLSearchParams(window.location.search).get("tab") as Tab | null; return q && TABS.some((x) => x.k === q) ? q : "khata"; });
  const { data, reload } = useApi<any>("/opening");
  if (!data) return <Loading />;
  return (
    <div>
      <PageHeader title="Opening balances · پرانا حساب" subtitle="Purana pump, naya system: jo log aap ke maqrooz hain, jin ka aap par baqaya hai, bank, staff advance aur tank stock — go-live ke din ka hisaab yahan ek baar likhein. Profit par asar nahi parta." />
      <div className="mb-4 grid grid-cols-3 gap-1.5 sm:grid-cols-6 sm:gap-2">
        {TABS.map((x) => (
          <button key={x.k} onClick={() => setTab(x.k)} className={`flex flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 text-center text-xs font-semibold sm:py-2.5 ${tab === x.k ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600"}`}>
            <x.icon size={18} /><span>{x.en}</span><Ur>{x.ur}</Ur>
          </button>
        ))}
      </div>
      {tab === "khata" && <KhataTab data={data} reload={reload} />}
      {tab === "parties" && <PartiesTab data={data} reload={reload} />}
      {tab === "banks" && <BanksTab data={data} reload={reload} />}
      {tab === "staff" && <StaffTab data={data} reload={reload} />}
      {tab === "stock" && <StockTab data={data} reload={reload} />}
      {tab === "cash" && <CashTab data={data} />}
    </div>
  );
}

function KhataTab({ data, reload }: { data: any; reload: () => void }) {
  const { busy, run } = useAction();
  const [asOf, setAsOf] = useState<string>(data.as_of);
  const [q, setQ] = useState("");
  const [vals, setVals] = useState<Record<number, string>>({});
  const [text, setText] = useState("");
  const [imp, setImp] = useState<any>(null);
  useEffect(() => { setVals({}); }, [data]);
  const rows = useMemo(() => (data.khata as any[]).filter((c) => !q || `${c.name} ${c.phone} ${c.city ?? ""}`.toLowerCase().includes(q.toLowerCase())), [data, q]);
  const changed = Object.entries(vals).filter(([id, v]) => v !== "" && Number(v) !== Number((data.khata as any[]).find((c) => c.id === Number(id))?.opening ?? 0));
  const total = (data.khata as any[]).reduce((a, c) => a + (c.opening ?? 0), 0);
  const save = async () => {
    const r = await run(() => api("/opening/khata", { body: { as_of: asOf, rows: changed.map(([id, v]) => ({ customer_id: Number(id), amount: Number(v) })) } }), `${changed.length} khata opening saved · محفوظ`);
    if (r) reload();
  };
  const doImport = async () => {
    const r = await run(() => api("/opening/khata/import", { body: { as_of: asOf, text } }), "List imported · لسٹ درج");
    if (r) { setImp(r); setText(""); reload(); }
  };
  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200 sm:grid-cols-3">
        <Field label="Go-live date · تاریخ"><input className="input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        <div className="rounded-xl bg-slate-50 p-3 text-sm"><div className="text-slate-500">Khata customers · گاہک</div><div className="text-xl font-bold">{data.khata.length}</div></div>
        <div className="rounded-xl bg-slate-50 p-3 text-sm"><div className="text-slate-500">Total opening receivable · کل پرانا باقیہ</div><div className="text-xl font-bold tabular-nums">{pkr(total)}</div></div>
      </div>

      <div className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <div className="relative min-w-0 flex-1"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input className="input w-full pl-9" placeholder="Search name / phone · تلاش" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <button className="btn-primary min-h-10" disabled={busy || !changed.length} onClick={save}><Check size={16} /> Save {changed.length ? `(${changed.length})` : ""} · <Ur>محفوظ</Ur></button>
        </div>
        <p className="px-3 pt-2 text-xs text-slate-500">Positive = customer owes the pump (baqaya). Negative = the pump owes the customer (advance). 0 clears. Puri list ek saath likh kar Save dabayen.</p>
        <ul className="divide-y divide-slate-100">
          {rows.map((c) => {
            const v = vals[c.id] ?? String(c.opening || "");
            return (
              <li key={c.id} className="grid grid-cols-[1fr_auto] items-center gap-2 px-3 py-2 sm:grid-cols-[1fr_8rem_10rem]">
                <div className="min-w-0"><div className="truncate font-medium">{c.name} {c.credit_limit > 0 && <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">KHATA</span>}</div><div className="truncate text-xs text-slate-500">{c.phone}{c.city ? ` · ${c.city}` : ""} · now {pkr(c.balance)}</div></div>
                <div className="hidden text-right text-xs text-slate-500 sm:block">opening {pkr(c.opening ?? 0)}</div>
                <input className="input min-h-10 w-28 text-right tabular-nums sm:w-full" type="number" inputMode="numeric" step="1" placeholder="Rs" value={v} onChange={(e) => setVals({ ...vals, [c.id]: e.target.value })} aria-label={`${c.name} opening balance`} />
              </li>
            );
          })}
          {!rows.length && <li className="px-3 py-6 text-center text-sm text-slate-500">No customer yet — paste the list below.</li>}
        </ul>
      </div>

      <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
        <h3 className="flex items-center gap-2 font-semibold"><Upload size={18} /> Paste the old register · <Ur>پرانا رجسٹر پیسٹ کریں</Ur></h3>
        <p className="mt-1 text-xs text-slate-500">One line per customer: <code>name, phone, amount, credit limit (optional)</code>. Excel se copy karke yahan paste karein (tab / comma dono chalte hain). Phone se match hota hai, naya customer khud ban jata hai (khata limit = amount).</p>
        <textarea className="input mt-2 min-h-32 w-full font-mono text-sm" placeholder={"Ali Traders, 03001234567, 85000, 150000\nBismillah Goods, 03217654321, 42000"} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="mt-2 flex items-center gap-2">
          <button className="btn-primary min-h-10" disabled={busy || !text.trim()} onClick={doImport}>Import list · <Ur>درج کریں</Ur></button>
          {imp && <span className="text-sm text-slate-600">{imp.created} new · {imp.updated} updated · total {pkr(imp.total)}{imp.errors?.length ? ` · ${imp.errors.length} skipped` : ""}</span>}
        </div>
        {imp?.errors?.length > 0 && <ul className="mt-2 space-y-1 text-xs text-red-700">{imp.errors.map((e: any) => <li key={e.line}>Line {e.line}: {e.reason} — <span className="text-slate-500">{e.text}</span></li>)}</ul>}
      </div>
    </div>
  );
}

function PartyRows({ title, kind, rows, dueLabel, reload }: { title: string; kind: string; rows: any[]; dueLabel: string; reload: () => void }) {
  const { busy, run } = useAction();
  const [vals, setVals] = useState<Record<number, string>>({});
  useEffect(() => { setVals({}); }, [rows]);
  const save = async (r: any) => {
    const ok = await run(() => api("/opening/party", { body: { kind, id: r.id, amount: Number(vals[r.id] ?? r.opening_balance) } }), `${r.name}: opening saved`);
    if (ok) reload();
  };
  return (
    <div className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
      <h3 className="border-b border-slate-100 px-3 py-2 font-semibold">{title}</h3>
      <ul className="divide-y divide-slate-100">
        {rows.map((r) => (
          <li key={r.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-2 px-3 py-2">
            <div className="min-w-0"><div className="truncate font-medium">{r.name}{r.business_name ? ` · ${r.business_name}` : ""}</div><div className="text-xs text-slate-500">{dueLabel} {pkr(r.due ?? r.owed ?? 0)}</div></div>
            <input className="input min-h-10 w-28 text-right tabular-nums" type="number" inputMode="numeric" value={vals[r.id] ?? String(r.opening_balance ?? 0)} onChange={(e) => setVals({ ...vals, [r.id]: e.target.value })} aria-label={`${r.name} opening`} />
            <button className="btn-secondary min-h-10 !px-3" disabled={busy || vals[r.id] === undefined || Number(vals[r.id]) === Number(r.opening_balance)} onClick={() => save(r)}><Check size={16} /></button>
          </li>
        ))}
        {!rows.length && <li className="px-3 py-4 text-center text-sm text-slate-500">None yet — add them on their own page first.</li>}
      </ul>
    </div>
  );
}
function PartiesTab({ data, reload }: { data: any; reload: () => void }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">Supplier: pump jitna depot ka maqrooz hai. Wholesale client / thekedar: jitna woh pump ke maqrooz hain. Yeh unke apne page par bhi "Opening" line mein dikhta hai.</p>
      <PartyRows title="Suppliers — we owe them · سپلائر (ہم پر باقیہ)" kind="supplier" rows={data.suppliers} dueLabel="Owed now" reload={reload} />
      <PartyRows title="Wholesale clients — they owe us · ہول سیل" kind="wholesale" rows={data.wholesale} dueLabel="Due now" reload={reload} />
      <PartyRows title="Thekedars (carriage) — they owe us · ٹھیکیدار" kind="carriage" rows={data.carriage} dueLabel="Due now" reload={reload} />
    </div>
  );
}

function BanksTab({ data, reload }: { data: any; reload: () => void }) {
  const { busy, run } = useAction();
  const [vals, setVals] = useState<Record<number, { amount: string; date: string }>>({});
  useEffect(() => { setVals({}); }, [data]);
  return (
    <div className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
      <p className="px-3 pt-3 text-sm text-slate-600">Bank statement ka balance go-live ki subah. Statement is date se shuru hota hai.</p>
      <ul className="divide-y divide-slate-100">
        {data.banks.map((a: any) => {
          const v = vals[a.id] ?? { amount: String(a.opening_balance ?? 0), date: a.opening_date ?? data.as_of };
          return (
            <li key={a.id} className="grid grid-cols-1 items-center gap-2 px-3 py-2 sm:grid-cols-[1fr_9rem_10rem_auto]">
              <div className="min-w-0"><div className="truncate font-medium">{a.bank}{a.title ? ` — ${a.title}` : ""}</div><div className="text-xs text-slate-500">{a.account_no ?? ""} · balance now {pkr(a.balance)}</div></div>
              <input className="input min-h-10 text-right tabular-nums" type="number" inputMode="numeric" value={v.amount} onChange={(e) => setVals({ ...vals, [a.id]: { ...v, amount: e.target.value } })} aria-label={`${a.bank} opening balance`} />
              <input className="input min-h-10" type="date" value={v.date} onChange={(e) => setVals({ ...vals, [a.id]: { ...v, date: e.target.value } })} aria-label={`${a.bank} opening date`} />
              <button className="btn-secondary min-h-10 !px-3" disabled={busy || !vals[a.id]} onClick={async () => { if (await run(() => api("/opening/bank", { body: { id: a.id, amount: Number(v.amount), date: v.date } }), `${a.bank}: opening saved`)) reload(); }}><Check size={16} /></button>
            </li>
          );
        })}
        {!data.banks.length && <li className="px-3 py-4 text-center text-sm text-slate-500">No bank account yet — add it under Money → Bank accounts.</li>}
      </ul>
    </div>
  );
}

function StaffTab({ data, reload }: { data: any; reload: () => void }) {
  const { busy, run } = useAction();
  const [vals, setVals] = useState<Record<number, string>>({});
  useEffect(() => { setVals({}); }, [data]);
  return (
    <div className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
      <p className="px-3 pt-3 text-sm text-slate-600">Jo advance pehle se kisi staff ke paas hai. Cash abhi nahi nikalta; salary se kat-ta rahega.</p>
      <ul className="divide-y divide-slate-100">
        {data.staff.map((u: any) => (
          <li key={u.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-2 px-3 py-2">
            <div className="min-w-0"><div className="truncate font-medium">{u.name} <span className="text-xs text-slate-500">· {u.role}</span></div><div className="text-xs text-slate-500">owes now {pkr(u.balance)}</div></div>
            <input className="input min-h-10 w-28 text-right tabular-nums" type="number" inputMode="numeric" min={0} value={vals[u.id] ?? String(u.opening ?? 0)} onChange={(e) => setVals({ ...vals, [u.id]: e.target.value })} aria-label={`${u.name} opening advance`} />
            <button className="btn-secondary min-h-10 !px-3" disabled={busy || vals[u.id] === undefined || Number(vals[u.id]) === Number(u.opening)} onClick={async () => { if (await run(() => api("/opening/staff", { body: { user_id: u.id, amount: Number(vals[u.id]) } }), `${u.name}: opening advance saved`)) reload(); }}><Check size={16} /></button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StockTab({ data, reload }: { data: any; reload: () => void }) {
  const { busy, run } = useAction();
  const [vals, setVals] = useState<Record<number, string>>({});
  const [rates, setRates] = useState<Record<string, string>>({});
  useEffect(() => { setVals({}); setRates({}); }, [data]);
  const fuels: any[] = data.fuel_values ?? [];
  const tanks: any[] = data.stock ?? [];
  // litres as they will be after save: typed value where there is one, else the book
  const litresOf = (t: any) => (vals[t.id] !== undefined && vals[t.id] !== "" ? Number(vals[t.id]) : Number(t.current_l) || 0);
  const litresByProduct = (p: string) => tanks.filter((t) => t.product === p).reduce((a, t) => a + litresOf(t), 0);
  const tankChanged = (t: any) => vals[t.id] !== undefined && vals[t.id] !== "" && Math.round(Number(vals[t.id])) !== Math.round(Number(t.current_l));
  const changedTanks = tanks.filter(tankChanged);
  const rateOf = (f: any) => rates[f.product] ?? String(f.opening?.rate ?? f.last_purchase_rate ?? "");
  const rateChanged = (f: any) => rates[f.product] !== undefined && Number(rates[f.product]) !== Number(f.opening?.rate ?? 0);
  const changedRates = fuels.filter(rateChanged);
  const anyChange = changedTanks.length > 0 || changedRates.length > 0;
  const totalValue = fuels.reduce((a, f) => a + (Number(rateOf(f)) || 0) * litresByProduct(f.product), 0);
  const overCap = tanks.find((t) => tankChanged(t) && Number(vals[t.id]) > Number(t.capacity_l) * 1.001);

  // one save: litres first (tank by tank), then the rates — so a rate typed for a tank that was empty lands on the new litres
  const saveAll = async () => {
    const r = await run(async () => {
      for (const t of changedTanks) await api("/opening/stock", { body: { tank_id: t.id, litres: Number(vals[t.id]) } });
      // every fuel whose litres moved gets its rate re-booked too (the server does this itself; sending the rate covers a fuel that had none)
      const rows = fuels.filter((f) => rateChanged(f) || (changedTanks.some((t) => t.product === f.product) && Number(rateOf(f)) > 0 && !f.opening))
        .map((f) => ({ product: f.product, rate: Number(rateOf(f)) || 0 }));
      if (rows.length) await api("/opening/fuel-rates", { body: { rows } });
      return { tanks: changedTanks.length, rates: rows.length };
    }, (x) => `Save ho gaya · ${x.tanks} tank ka stock${x.rates ? `, ${x.rates} fuel ka rate` : ""}`);
    if (r) reload();
  };

  return (
    <div className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
      <p className="px-3 pt-3 text-sm text-slate-600">Go-live ki subah har tank ka dip (litre) likhein, neeche us fuel ka khareed rate, phir ek baar <b>Save karein</b>. Stock register yahin se shuru hota hai.</p>
      <div className="px-3 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">1 · Tank me kitna fuel hai · <span lang="ur" className="font-urdu normal-case tracking-normal">ٹینک میں کتنا تیل</span></div>
      <ul className="divide-y divide-slate-100">
        {tanks.map((t: any) => (
          <li key={t.id} className={`grid grid-cols-[1fr_auto] items-center gap-2 px-3 py-2 ${tankChanged(t) ? "bg-emerald-50/60" : ""}`}>
            <div className="min-w-0"><div className="truncate font-medium">{t.name} <span className="text-xs text-slate-500">· {t.product} · {t.station}</span></div>
              <div className="text-xs text-slate-500">book {num(t.current_l, 0)} L of {num(t.capacity_l, 0)} L{tankChanged(t) ? <span className="ml-1 font-semibold text-emerald-700">→ {num(Number(vals[t.id]), 0)} L (save baqi)</span> : null}</div></div>
            <div className="relative"><input className={`input min-h-10 w-32 pr-7 text-right tabular-nums ${tankChanged(t) && Number(vals[t.id]) > Number(t.capacity_l) * 1.001 ? "!border-rose-400" : ""}`} type="number" inputMode="numeric" min={0} value={vals[t.id] ?? String(Math.round(t.current_l))} onChange={(e) => setVals({ ...vals, [t.id]: e.target.value })} aria-label={`${t.name} litres`} />
              <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-slate-400">L</span></div>
          </li>
        ))}
      </ul>
      {fuels.length > 0 && (
        <div className="m-3 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="font-medium">2 · Is fuel ki khareed rate · <span lang="ur" className="font-urdu">خریداری ریٹ</span></div>
            <div className="text-sm tabular-nums">Stock value: <b>{pkr(totalValue)}</b></div>
          </div>
          <p className="mb-2 text-xs text-slate-600">Jo fuel tank me hai wo kis rate (Rs/L) par mila tha. Litre × rate = opening stock ki value, jo ledger me "Fuel stock (go-live)" ban kar aati hai aur profit sirf margin par nikalta hai. Ek fuel ka ek rate.</p>
          <ul className="divide-y divide-amber-100">
            {fuels.map((f) => { const L = litresByProduct(f.product); return (
              <li key={f.product} className="grid grid-cols-[1fr_auto_auto] items-center gap-2 py-1.5 text-sm">
                <div className="min-w-0"><div className="truncate font-medium">{f.name}</div>
                  <div className="text-xs text-slate-500">{num(L, 0)} L in tanks{f.opening ? ` · booked ${num(f.opening.litres, 0)} L @ Rs ${f.opening.rate} = ${pkr(f.opening.amount)}` : f.last_purchase_rate ? ` · last purchase Rs ${f.last_purchase_rate}/L` : " · rate nahi"}
                    {L <= 0 && Number(rateOf(f)) > 0 ? <span className="ml-1 font-semibold text-rose-700">· pehle upar tank ka litre likhein</span> : null}</div></div>
                <div className="relative"><input className="input min-h-10 w-32 pr-10 text-right tabular-nums" type="number" inputMode="decimal" min={0} step="0.01" placeholder="Rs / L" value={rateOf(f)} onChange={(e) => setRates({ ...rates, [f.product]: e.target.value })} aria-label={`${f.name} opening rate`} />
                  <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-slate-400">Rs/L</span></div>
                <div className="w-28 text-right text-xs tabular-nums text-slate-600">= {pkr((Number(rateOf(f)) || 0) * L)}</div>
              </li>
            ); })}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 p-3">
        {overCap && <span className="text-xs text-rose-700">{overCap.name}: capacity {num(overCap.capacity_l, 0)} L se zyada nahi ho sakta</span>}
        {!anyChange && <span className="text-xs text-slate-500">Litre ya rate badlein, phir save</span>}
        <button className="btn-primary min-h-11" disabled={busy || !anyChange || !!overCap} onClick={saveAll} aria-label="Save opening stock">
          <Check size={16} /> {busy ? "Save ho raha…" : `Save karein${changedTanks.length ? ` · ${changedTanks.length} tank` : ""}${changedRates.length ? ` · ${changedRates.length} rate` : ""}`}
        </button>
      </div>
    </div>
  );
}

function CashTab({ data }: { data: any }) {
  return (
    <div className="space-y-3 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200 text-sm">
      <p>Drawer / office ka cash go-live ke din: <b>Cash book → Count cash</b> par pehli ginti karein. Pehli ginti hi opening cash ban jati hai (ledger mein owner's capital ke muqabil).</p>
      <div className="rounded-xl bg-slate-50 p-3">
        {data.cash.first_count
          ? <>First count: <b>{pkr(data.cash.first_count.amount)}</b> by {data.cash.first_count.counted_by} on {new Date(data.cash.first_count.created_at).toLocaleDateString("en-PK")} · cash in hand now <b>{pkr(data.cash.cash_in_hand)}</b></>
          : <>No cash count yet · <Ur>ابھی گنتی نہیں ہوئی</Ur></>}
      </div>
      <a className="btn-primary inline-flex min-h-10" href="/cash">Go to Cash book · <Ur>کیش بک</Ur></a>
    </div>
  );
}
