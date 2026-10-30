import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { askCancel, pinHeader } from "../components/CancelEntry";
import { api, useApi } from "../lib/api";
import { Field, ListTools, Loading, Modal, Pager, PageHeader, Stat, useAction, useListFilter, usePaged } from "../components/ui";
import { AccountPicker } from "../components/BankParts";
import { PortalCard } from "../components/PortalCard";
import { PrintListButton } from "../components/PrintList";
import { Ur } from "../components/VoiceShell";
import { pkr, num, dt, PRODUCTS, activeProducts } from "../lib/format";
import { Plus, Pencil, Trash2, ArrowDownCircle, ArrowUpCircle, Fuel, CheckCircle2, Ban, ChevronLeft, Power, BookOpen, Percent } from "lucide-react";

/**
 * CEO-only: investors. They give money; we buy fuel with it in "deals"; when a deal is sold its profit (or loss) is split
 * (default 60% ours / 40% theirs). Each investor has a Debit / Credit ledger: money they gave + their profit share = Credit
 * (we owe them), money we paid them + their loss share = Debit. Cash / bank and the books move with every entry.
 */
const PAY = ["Cash", "Bank transfer", "Raast", "JazzCash", "Easypaisa"];
const isCash = (m: string) => /^cash$/i.test(m);
const TYPE: Record<string, { en: string; ur: string; cls: string }> = {
  capital_in: { en: "Paisa aaya (capital)", ur: "سرمایہ", cls: "bg-emerald-100 text-emerald-700" },
  profit: { en: "Munafa hissa", ur: "منافع", cls: "bg-blue-100 text-blue-700" },
  payout: { en: "Paisa diya", ur: "ادائیگی", cls: "bg-rose-100 text-rose-700" },
  loss: { en: "Nuqsan hissa", ur: "نقصان", cls: "bg-amber-100 text-amber-700" },
};

export default function Investors() {
  const [sp, setSp] = useSearchParams();
  const open = Number(sp.get("id")) || null;
  const { data, reload } = useApi<any[]>("/investors");
  const { data: sum, reload: reloadSum } = useApi<any>("/investors-summary");
  const [q, setQ] = useState("");
  const [form, setForm] = useState<any>(null);
  const rows = useListFilter<any>(data, { q, text: (i) => [i.name, i.phone, i.cnic, i.city].filter(Boolean).join(" ") });
  const paged = usePaged(rows, 10);
  const refresh = () => { reload(); reloadSum(); };

  if (open) return <InvestorDetail id={open} onBack={() => { setSp({}); refresh(); }} onEdit={(i) => setForm(i)} form={form} setForm={setForm} />;

  return (
    <div>
      <PageHeader title={<>Investors · <Ur>سرمایہ کار</Ur></>} subtitle="Investor ka paisa → fuel ki deal → munafa ka hissa (har investor ka apna %). Har entry cash/bank aur books me tally."
        actions={<button className="btn-primary" onClick={() => setForm({ our_pct: 60 })}><Plus size={16} /> Naya investor</button>} />
      {sum && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Investors ka paisa (capital)" value={pkr(sum.capital_in)} hint={`${sum.count} investor · deal me ${pkr(sum.in_deals)}`} tone="blue" />
          <Stat label="Deals ka kul munafa" value={pkr(sum.deal_profit)} hint={`is mahine ${pkr(sum.month.profit)}`} tone="green" />
          <Stat label="Hamara hissa" value={pkr(sum.our_share)} hint={`is mahine ${pkr(sum.month.our_share)}`} tone="green" />
          <Stat label="Investors ko dena (baqi)" value={pkr(sum.owed)} hint={`unka munafa ${pkr(sum.investor_share)} · diya ${pkr(sum.paid_out)}`} tone="red" />
        </div>
      )}
      {!data ? <Loading /> : (
        <div className="card p-4">
          <ListTools q={q} onQ={setQ} placeholder="Naam / phone / CNIC dhoondein… · تلاش" shown={rows.length} total={data.length} />
          {!data.length && <p className="py-6 text-center text-sm text-slate-500">Abhi koi investor nahi. "Naya investor" se shuru karein.</p>}
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[820px]">
              <thead><tr>
                <th className="th">Investor</th><th className="th text-right">Capital diya</th><th className="th text-right">Deal me</th><th className="th text-right">Munafa (unka)</th>
                <th className="th text-right">Diya</th><th className="th text-right">Baqi dena</th><th className="th text-right">Hissa</th><th className="th"></th>
              </tr></thead>
              <tbody>{paged.slice.map((i: any) => (
                <tr key={i.id} className={`cursor-pointer hover:bg-slate-50 ${i.active ? "" : "opacity-60"}`} onClick={() => setSp({ id: String(i.id) })}>
                  <td className="td"><div className="font-medium">{i.name}{!i.active && <span className="ml-1 rounded bg-slate-200 px-1.5 text-[10px]">band</span>}{i.pending_requests > 0 && <span className="ml-1 rounded-full bg-amber-500 px-1.5 text-[10px] text-white">{i.pending_requests} request</span>}</div><div className="text-xs text-slate-500">{[i.phone, i.city].filter(Boolean).join(" · ")}</div></td>
                  <td className="td text-right tabular-nums">{pkr(i.capital_in)}</td>
                  <td className="td text-right tabular-nums">{i.in_deals ? pkr(i.in_deals) : "—"}{i.open_deals ? <div className="text-[11px] text-amber-700">{i.open_deals} deal chal rahi</div> : null}</td>
                  <td className="td text-right tabular-nums text-emerald-700">{pkr(i.profit_share - i.loss_share)}</td>
                  <td className="td text-right tabular-nums text-rose-700">{pkr(i.paid_out)}</td>
                  <td className="td text-right font-semibold tabular-nums">{pkr(i.balance)}</td>
                  <td className="td text-right text-xs">{i.our_pct}% / {100 - i.our_pct}%</td>
                  <td className="td text-right"><button className="btn-secondary !py-1 text-xs" onClick={(e) => { e.stopPropagation(); setForm(i); }}><Pencil size={13} /> Edit</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <ul className="divide-y sm:hidden">
            {paged.slice.map((i: any) => (
              <li key={i.id} className="flex items-center gap-2 py-2" onClick={() => setSp({ id: String(i.id) })}>
                <div className="min-w-0 flex-1"><div className="font-medium">{i.name}</div><div className="text-xs text-slate-500">capital {pkr(i.capital_in)} · munafa {pkr(i.profit_share - i.loss_share)}</div></div>
                <div className="text-right"><div className="font-semibold tabular-nums">{pkr(i.balance)}</div><div className="text-[11px] text-slate-500">baqi dena</div></div>
              </li>
            ))}
          </ul>
          <Pager {...paged} />
        </div>
      )}
      {form && <InvestorForm i={form} onClose={() => setForm(null)} onDone={refresh} />}
    </div>
  );
}

function InvestorForm({ i, onClose, onDone }: { i: any; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [f, setF] = useState({ name: i.name ?? "", phone: i.phone ?? "", cnic: i.cnic ?? "", city: i.city ?? "", address: i.address ?? "", bank_name: i.bank_name ?? "", bank_account: i.bank_account ?? "", note: i.note ?? "", our_pct: String(i.our_pct ?? 60), profit_mode: (i.profit_mode ?? "deal") as "deal" | "fixed", profit_pct: i.profit_pct != null ? String(i.profit_pct) : "" });
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const pct = Number(f.our_pct);
  const save = () => run(() => api(i.id ? `/investors/${i.id}` : "/investors", { method: i.id ? "PATCH" : "POST", body: { ...f, our_pct: pct, profit_pct: f.profit_mode === "fixed" && f.profit_pct !== "" ? Number(f.profit_pct) : null } }), i.id ? "Investor update ho gaya" : "Investor add ho gaya").then((r) => { if (r) { onDone(); onClose(); } });
  const del = () => { if (confirm(`${i.name} ko delete karein? (sirf tab hota hai jab koi entry na ho)`)) run(() => api(`/investors/${i.id}`, { method: "DELETE" }), "Delete ho gaya").then((r) => { if (r) { onDone(); onClose(); } }); };
  return (
    <Modal open wide title={i.id ? `Edit — ${i.name}` : "Naya investor · نیا سرمایہ کار"} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Naam · نام"><input className="input" autoFocus value={f.name} onChange={set("name")} /></Field>
        <Field label="Phone / WhatsApp"><input className="input" inputMode="tel" value={f.phone} onChange={set("phone")} placeholder="03xx xxxxxxx" /></Field>
        <Field label="CNIC"><input className="input" value={f.cnic} onChange={set("cnic")} placeholder="xxxxx-xxxxxxx-x" /></Field>
        <Field label="Shehar · شہر"><input className="input" value={f.city} onChange={set("city")} /></Field>
        <Field label="Address · پتہ"><input className="input" value={f.address} onChange={set("address")} /></Field>
        <Field label="Bank (us ka)"><input className="input" value={f.bank_name} onChange={set("bank_name")} placeholder="e.g. Meezan Bank" /></Field>
        <Field label="Account / IBAN"><input className="input" value={f.bank_account} onChange={set("bank_account")} /></Field>
        <div className="sm:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="mb-2 text-sm font-semibold">Munafa ka setup · <Ur>منافع کا طریقہ</Ur></div>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Munafa ka setup">
            {([["deal", "Deal ka hissa (%)"], ["fixed", "Fixed % mahana (capital par)"]] as const).map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={f.profit_mode === k} onClick={() => setF({ ...f, profit_mode: k })} className={`rounded-full px-3 py-1 text-xs font-semibold ${f.profit_mode === k ? "bg-brand-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200"}`}>{l}</button>
            ))}
          </div>
          {f.profit_mode === "deal" ? (
            <div className="mt-2 flex flex-wrap items-center gap-2"><label className="text-sm" htmlFor="inv-our-pct">Hamara %</label><input id="inv-our-pct" className="input w-24" type="number" min={0} max={100} value={f.our_pct} onChange={set("our_pct")} />
              <span className="text-sm text-slate-600">Hamara <b>{pct || 0}%</b> · investor ka <b>{100 - (pct || 0)}%</b> — har deal band hone par khud hisab.</span></div>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2"><label className="text-sm" htmlFor="inv-fixed-pct">Investor ka % mahana</label><input id="inv-fixed-pct" className="input w-24" type="number" min={0} max={100} step="0.1" value={f.profit_pct} onChange={set("profit_pct")} placeholder="e.g. 2.5" />
              <span className="text-sm text-slate-600">Capital par mahana; har mahine "Munafa darj" se Rs ya % mein likhein (ye % wahan pehle se bhara aayega).</span></div>
          )}
        </div>
        <Field label="Note"><input className="input" value={f.note} onChange={set("note")} /></Field>
      </div>
      {i.id && !!i.capital_in && <p className="mt-2 text-xs text-slate-500">% badalne se sirf nayi deals par asar hoga — purani deals apne % par rahengi.</p>}
      <div className="mt-4 flex flex-wrap justify-between gap-2">
        <div>{i.id && <button className="btn-secondary !text-rose-700" disabled={busy} onClick={del}><Trash2 size={15} /> Delete</button>}</div>
        <div className="flex gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || f.name.trim().length < 2 || !(pct >= 0 && pct <= 100)} onClick={save}>Save</button></div>
      </div>
    </Modal>
  );
}

function InvestorDetail({ id, onBack, onEdit, form, setForm }: { id: number; onBack: () => void; onEdit: (i: any) => void; form: any; setForm: (v: any) => void }) {
  const today = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
  const [range, setRange] = useState({ from: "", to: "" });
  const qs = [range.from && `from=${range.from}`, range.to && `to=${range.to}`].filter(Boolean).join("&");
  const { data, reload } = useApi<any>(`/investors/${id}${qs ? `?${qs}` : ""}`);
  const [money, setMoney] = useState<"in" | "out" | null>(null);
  const [opening, setOpening] = useState(false);
  const [profitForm, setProfitForm] = useState(false);
  const [deal, setDeal] = useState<any>(null);
  const [closing, setClosing] = useState<any>(null);
  const { busy, run } = useAction();
  if (!data) return <Loading />;
  const i = data.investor;
  const lines = [...data.lines].reverse();
  const paged = { slice: lines };
  const voidTxn = async (x: any) => {
    const a = await askCancel({ title: "Entry mansookh karein", what: <><b>{TYPE[x.type]?.en}</b> · {pkr(x.amount)} · {dt(x.created_at)}</>, hint: "Cash / bank se ye raqam wapas ho jayegi aur investor ka balance theek ho jayega." });
    if (a) run(() => api(`/investor-txns/${x.id}/void`, { body: { reason: a.reason }, headers: pinHeader(a) }), "Mansookh ho gaya").then(reload);
  };
  const voidDeal = async (d: any) => {
    const a = await askCancel({ title: `Deal #${d.id} mansookh karein`, what: <>{num(d.litres)} L {PRODUCTS[d.product] ?? d.product} · {pkr(d.cost_amount)}{d.status === "closed" ? <> · munafa {pkr(d.profit)}</> : null}</>,
      hint: d.status === "closed" ? "Deal ka munafa / nuqsan ka hissa investor ke khate se wapas ho jayega. Jo munafa pehle de diya hai woh alag se mansookh karein." : "Deal band ho jayegi aur paisa investor ke free balance me wapas aa jayega." });
    if (a) run(() => api(`/investor-deals/${d.id}/void`, { body: { reason: a.reason }, headers: pinHeader(a) }), "Deal mansookh").then(reload);
  };
  const toggle = () => run(() => api(`/investors/${i.id}/${i.active ? "inactive" : "active"}`, { body: {} }), i.active ? "Investor band" : "Investor chalu").then(reload);
  return (
    <div>
      <button className="mb-3 inline-flex items-center gap-1 text-sm text-brand-700" onClick={onBack}><ChevronLeft size={16} /> Sab investors</button>
      <PageHeader title={<>{i.name}{!i.active && <span className="ml-2 rounded bg-slate-200 px-2 py-0.5 text-xs">band</span>}</>}
        subtitle={[i.phone, i.cnic && `CNIC ${i.cnic}`, i.city, i.bank_name && `${i.bank_name} ${i.bank_account ?? ""}`].filter(Boolean).join(" · ") || "Investor"}
        actions={<div className="flex flex-wrap gap-2">
          <button className="btn-primary !bg-emerald-600" disabled={!i.active} onClick={() => setMoney("in")}><ArrowDownCircle size={16} /> Paisa aaya</button>
          <button className="btn-secondary !text-rose-700" disabled={!i.active} onClick={() => setMoney("out")}><ArrowUpCircle size={16} /> Paisa diya</button>
          <button className="btn-secondary" disabled={!i.active || i.free <= 0} title={i.free <= 0 ? "Free paisa nahi" : ""} onClick={() => setDeal({})}><Fuel size={16} /> Nayi deal</button>
          <button className="btn-secondary !text-blue-700" disabled={!i.active} onClick={() => setProfitForm(true)}><Percent size={15} /> Munafa darj</button>
          {!data.lines.some((x: any) => !x.voided && x.method === "Opening") && <button className="btn-secondary" disabled={!i.active} onClick={() => setOpening(true)} title="Purana investor: go-live se pehle ka hisab"><BookOpen size={15} /> Opening balance</button>}
          <button className="btn-secondary" onClick={() => onEdit(i)}><Pencil size={15} /> Edit</button>
          <button className="btn-secondary" disabled={busy} onClick={toggle}><Power size={15} /> {i.active ? "Band karein" : "Chalu karein"}</button>
        </div>} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Baqi dena (balance)" value={pkr(i.balance)} hint={`deal me ${pkr(i.in_deals)} · free ${pkr(i.free)}`} tone="blue" />
        <Stat label="Capital diya" value={pkr(i.capital_in)} hint={`${i.deals} deals · ${num(i.litres)} L`} />
        <Stat label="Unka munafa" value={pkr(i.profit_share - i.loss_share)} hint={`${i.profit_mode === "fixed" ? `${i.profit_pct ?? "—"}% mahana (fixed)` : `${100 - i.our_pct}% hissa`}${i.loss_share ? ` · nuqsan ${pkr(i.loss_share)}` : ""}`} tone="green" />
        <Stat label="Hamara munafa" value={pkr(i.our_share)} hint={`${i.our_pct}% · kul deal munafa ${pkr(i.deal_profit)}`} tone="green" />
      </div>

      {data.requests?.length > 0 && <Requests i={i} list={data.requests} onDone={reload} />}

      {/* deals */}
      <div className="card mb-4 p-4">
        <h2 className="mb-2 font-semibold">Deals · <Ur>سودے</Ur> <span className="text-xs font-normal text-slate-500">investor ke paise se liya gaya fuel</span></h2>
        {!data.deals.length ? <p className="py-3 text-center text-sm text-slate-500">Abhi koi deal nahi.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead><tr><th className="th">#</th><th className="th">Tareekh</th><th className="th">Fuel</th><th className="th text-right">Litre</th><th className="th text-right">Khareed</th><th className="th text-right">Becha</th><th className="th text-right">Kharche</th><th className="th text-right">Munafa</th><th className="th text-right">Hamara</th><th className="th text-right">Investor</th><th className="th"></th></tr></thead>
              <tbody>{data.deals.map((d: any) => (
                <tr key={d.id} className="border-t">
                  <td className="td">{d.id}</td><td className="td whitespace-nowrap text-xs">{d.deal_date}{d.supplier ? <div className="text-slate-500">{d.supplier}</div> : null}</td>
                  <td className="td">{PRODUCTS[d.product] ?? d.product}{d.ref ? <div className="text-xs text-slate-500">{d.ref}</div> : null}</td>
                  <td className="td text-right tabular-nums">{num(d.litres)} L{d.status === "closed" && d.sold_litres < d.litres ? <div className="text-[11px] text-amber-700">bika {num(d.sold_litres)} L</div> : null}</td>
                  <td className="td text-right tabular-nums">{pkr(d.cost_amount)}<div className="text-[11px] text-slate-500">@ {num(d.cost_rate, 2)}</div></td>
                  <td className="td text-right tabular-nums">{d.status === "closed" ? <>{pkr(d.sale_amount)}<div className="text-[11px] text-slate-500">@ {num(d.sale_rate, 2)}</div></> : "—"}</td>
                  <td className="td text-right tabular-nums">{d.status === "closed" ? pkr(d.expenses) : "—"}</td>
                  <td className={`td text-right font-semibold tabular-nums ${d.profit < 0 ? "text-rose-700" : "text-emerald-700"}`}>{d.status === "closed" ? pkr(d.profit) : <span className="rounded bg-amber-100 px-1.5 text-[11px] font-semibold text-amber-800">chal rahi</span>}</td>
                  <td className="td text-right tabular-nums">{d.status === "closed" ? pkr(d.our_share) : "—"}</td>
                  <td className="td text-right tabular-nums">{d.status === "closed" ? pkr(d.investor_share) : "—"}</td>
                  <td className="td whitespace-nowrap text-right">
                    {d.status === "open" && <>
                      <button className="btn-primary !py-1 text-xs" onClick={() => setClosing(d)}><CheckCircle2 size={13} /> Bik gaya — band karein</button>{" "}
                      <button className="btn-secondary !py-1 text-xs" onClick={() => setDeal(d)}><Pencil size={13} /></button>{" "}
                    </>}
                    <button className="btn-secondary !py-1 text-xs !text-rose-700" onClick={() => voidDeal(d)} aria-label="Mansookh"><Ban size={13} /></button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>

      {/* ledger */}
      <div className="card mb-4 p-4">
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <h2 className="font-semibold">Ledger · <Ur>کھاتہ</Ur> <span className="text-xs font-normal text-slate-500">Credit = hum par barha · Debit = hum ne diya / nuqsan</span></h2>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Se"><input type="date" className="input w-auto" max={today} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
            <Field label="Tak"><input type="date" className="input w-auto" max={today} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
            <PrintListButton title={`Investor statement — ${i.name}`} subtitle={`${range.from || "shuru"} → ${range.to || "aaj"} · opening ${pkr(data.opening)} · closing ${pkr(data.closing)}`} rows={data.lines.filter((x: any) => !x.voided)} label="Statement print"
              note={`Capital ${pkr(i.capital_in)} · Unka munafa ${pkr(i.profit_share - i.loss_share)} · Diya ${pkr(i.paid_out)} · Baqi dena ${pkr(i.balance)} · Hissa ${i.our_pct}% / ${100 - i.our_pct}%`}
              columns={[
                { label: "Tareekh", v: (x: any) => dt(x.created_at) },
                { label: "Kism", v: (x: any) => TYPE[x.type]?.en ?? x.type, total: (rs: any[]) => `${rs.length} entries` },
                { label: "Tafseel", v: (x: any) => describe(x) },
                { label: "Debit", r: true, v: (x: any) => (x.debit ? pkr(x.debit) : ""), tone: () => "neg" as const, total: (rs: any[]) => pkr(rs.reduce((a, x) => a + x.debit, 0)), totalTone: "neg" as const },
                { label: "Credit", r: true, v: (x: any) => (x.credit ? pkr(x.credit) : ""), tone: () => "pos" as const, total: (rs: any[]) => pkr(rs.reduce((a, x) => a + x.credit, 0)), totalTone: "pos" as const },
                { label: "Balance", r: true, v: (x: any) => pkr(x.balance) },
              ]} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead><tr><th className="th">Tareekh</th><th className="th">Kism</th><th className="th">Tafseel</th><th className="th text-right">Debit</th><th className="th text-right">Credit</th><th className="th text-right">Balance</th><th className="th"></th></tr></thead>
            <tbody>
              <tr className="bg-slate-50 text-xs"><td className="td" colSpan={5}>Opening balance</td><td className="td text-right font-semibold tabular-nums">{pkr(data.opening)}</td><td className="td"></td></tr>
              {paged.slice.map((x: any) => (
                <tr key={x.id} className={`border-t ${x.voided ? "text-slate-400 line-through" : ""}`}>
                  <td className="td whitespace-nowrap text-xs">{dt(x.created_at)}</td>
                  <td className="td"><span className={`whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${TYPE[x.type]?.cls ?? ""}`}>{TYPE[x.type]?.en ?? x.type}</span></td>
                  <td className="td text-xs text-slate-600">{describe(x)}{x.voided ? ` — mansookh: ${x.void_reason ?? ""}` : ""}</td>
                  <td className="td text-right tabular-nums text-rose-700">{x.debit ? pkr(x.debit) : ""}</td>
                  <td className="td text-right tabular-nums text-emerald-700">{x.credit ? pkr(x.credit) : ""}</td>
                  <td className="td text-right font-semibold tabular-nums">{x.voided ? "" : pkr(x.balance)}</td>
                  <td className="td text-right">{!x.voided && (x.type === "capital_in" || x.type === "payout" || x.method === "Opening" || x.method === "Manual") && <button className="text-slate-400 hover:text-rose-600" onClick={() => voidTxn(x)} aria-label="Mansookh"><Ban size={15} /></button>}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold tabular-nums">
              <td className="td" colSpan={3}>Kul · closing balance</td>
              <td className="td text-right text-rose-700">{pkr(data.totals.debit)}</td><td className="td text-right text-emerald-700">{pkr(data.totals.credit)}</td>
              <td className="td text-right">{pkr(data.closing)}</td><td className="td"></td>
            </tr></tfoot>
          </table>
        </div>
      </div>

      <div className="print:hidden"><PortalCard base={`/investors/${i.id}/portal`} name={i.name} phone={i.phone} canManage /></div>

      {money && <MoneyForm i={i} dir={money} onClose={() => setMoney(null)} onDone={reload} />}
      {opening && <OpeningForm i={i} onClose={() => setOpening(false)} onDone={reload} />}
      {profitForm && <ProfitForm i={i} onClose={() => setProfitForm(false)} onDone={reload} />}
      {deal && <DealForm i={i} d={deal} onClose={() => setDeal(null)} onDone={reload} />}
      {closing && <CloseDeal i={i} d={closing} onClose={() => setClosing(null)} onDone={reload} />}
      {form && <InvestorForm i={form} onClose={() => setForm(null)} onDone={reload} />}
    </div>
  );
}

/** what an entry was, in words */
function describe(x: any) {
  if (x.method === "Manual") return [x.type === "profit" ? "Manual munafa" : "Manual nuqsan", x.note].filter(Boolean).join(" · ");
  if (x.method === "Opening") return [x.type === "profit" ? "Opening — munafa baqi (go-live se pehle)" : "Opening — capital (go-live se pehle)", x.note].filter(Boolean).join(" · ");
  if (x.type === "capital_in") return [x.method, x.acc_bank, x.note].filter(Boolean).join(" · ");
  if (x.type === "payout") return [x.purpose === "capital" ? "Asal raqam wapas" : "Munafa diya", x.method, x.acc_bank, x.note].filter(Boolean).join(" · ");
  // profit / loss share: the deal in words + the investor's % (the stored note only repeats the deal number)
  const d = x.deal_id ? `Deal #${x.deal_id}${x.product ? ` · ${num(x.sold_litres ?? x.litres ?? 0)} L ${PRODUCTS[x.product] ?? x.product}` : ""}${x.deal_profit != null ? ` · deal ${x.deal_profit < 0 ? "nuqsan" : "munafa"} ${pkr(Math.abs(x.deal_profit))}` : ""}${x.deal_pct != null ? ` · ${100 - x.deal_pct}% hissa` : ""}` : "";
  return d || x.note || "";
}

/** Manual profit / loss share — Rs figure or % of a base (default: capital still with us). Books it like a deal's share, without a deal. */
function ProfitForm({ i, onClose, onDone }: { i: any; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const today = new Date().toISOString().slice(0, 10);
  const fixed = i.profit_mode === "fixed";
  const [kind, setKind] = useState<"profit" | "loss">("profit");
  const [mode, setMode] = useState<"amount" | "percent">(fixed ? "percent" : "amount");
  const [amount, setAmount] = useState("");
  const [pct, setPct] = useState(fixed && i.profit_pct != null ? String(i.profit_pct) : "");
  const [base, setBase] = useState(String(i.capital_net ?? 0));
  const [period, setPeriod] = useState(today.slice(0, 7));
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  const baseN = Number(base) || 0, pctN = Number(pct) || 0;
  const amt = mode === "percent" ? Math.round(((baseN * pctN) / 100) * 100) / 100 : Number(amount) || 0;
  const bad = amt <= 0 || date > today || (kind === "loss" && amt > i.balance + 0.5);
  const save = () => run(() => api(`/investors/${i.id}/profit`, { body: { kind, mode, amount: mode === "amount" ? Number(amount) : undefined, pct: mode === "percent" ? pctN : undefined, base: mode === "percent" ? baseN : undefined, period: period || null, date, note: note || null } }),
    kind === "profit" ? "Munafa darj — investor ke khate me credit" : "Nuqsan darj — investor ke khate me debit").then((r) => { if (r) { onDone(); onClose(); } });
  const Pill = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: any }) => (
    <button type="button" role="radio" aria-checked={on} onClick={onClick} className={`rounded-full px-3 py-1 text-xs font-semibold ${on ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600"}`}>{children}</button>);
  return (
    <Modal open title={`Munafa darj karein — ${i.name}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="rounded-xl bg-blue-50 p-2.5 text-sm text-blue-900">Bina deal ke munafa (ya nuqsan) ka hissa — fixed return wale investor ke liye ya koi tay shuda raqam. Cash nahi hilta: investor ke khate me <b>{kind === "profit" ? "Credit" : "Debit"}</b>, books me {kind === "profit" ? "investor profit share expense" : "expense wapas"}. Dene ke liye baad me "Paisa diya".</p>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Kism"><Pill on={kind === "profit"} onClick={() => setKind("profit")}>Munafa</Pill><Pill on={kind === "loss"} onClick={() => setKind("loss")}>Nuqsan</Pill></div>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Tareeqa"><Pill on={mode === "amount"} onClick={() => setMode("amount")}>Rs raqam</Pill><Pill on={mode === "percent"} onClick={() => setMode("percent")}>% se hisab</Pill></div>
        {mode === "amount" ? (
          <Field label="Raqam (Rs)"><input className="input text-lg font-semibold" type="number" inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Fisad (%)"><input className="input text-lg font-semibold" type="number" inputMode="decimal" step="0.1" autoFocus value={pct} onChange={(e) => setPct(e.target.value)} placeholder={fixed ? "" : "e.g. 2.5"} /></Field>
            <Field label="Kis raqam par (base)"><input className="input" type="number" inputMode="decimal" value={base} onChange={(e) => setBase(e.target.value)} /></Field>
            <p className="col-span-2 -mt-1 text-xs text-slate-500">Base pehle se = capital jo abhi hamare paas hai ({pkr(i.capital_net ?? 0)}). Pump ke mahine ke munafe par % dena ho to base me woh raqam likhein.</p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Field label="Kis mahine ka"><input type="month" className="input" max={today.slice(0, 7)} value={period} onChange={(e) => setPeriod(e.target.value)} /></Field>
          <Field label="Entry ki tareekh"><input type="date" className="input" max={today} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className={`rounded-xl p-2.5 text-sm ${kind === "profit" ? "bg-emerald-50" : "bg-rose-50"}`}>Khate me {kind === "profit" ? "credit" : "debit"}: <b>{pkr(amt)}</b>{mode === "percent" && amt > 0 ? <span className="text-xs text-slate-600"> ({pctN}% × {pkr(baseN)})</span> : null}</div>
        {kind === "loss" && amt > i.balance + 0.5 && <p className="text-sm text-rose-700">Nuqsan investor ke balance ({pkr(i.balance)}) se zyada nahi ho sakta.</p>}
        <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || bad} onClick={save}>Save</button></div>
      </div>
    </Modal>
  );
}

/** Old pump, investor already on board: what we held of theirs on the go-live day. No cash moves — booked against go-live opening equity. */
function OpeningForm({ i, onClose, onDone }: { i: any; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const today = new Date().toISOString().slice(0, 10);
  const [asOf, setAsOf] = useState(today);
  const [capital, setCapital] = useState("");
  const [profit, setProfit] = useState("");
  const [note, setNote] = useState("");
  const cap = Number(capital) || 0, pr = Number(profit) || 0;
  const save = () => run(() => api(`/investors/${i.id}/opening`, { body: { as_of: asOf, capital: cap, profit_due: pr, note: note || null } }), "Opening balance darj — investor ke khate me credit")
    .then((r) => { if (r) { onDone(); onClose(); } });
  return (
    <Modal open title={`Opening balance — ${i.name}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="rounded-xl bg-amber-50 p-2.5 text-sm text-amber-900">Purana investor: software se <b>pehle</b> ka hisab yahan likhein. Cash / bank nahi hilta — sirf investor ka khata <b>Credit</b> hota hai (go-live opening ke muqabil). Aaj se aage ka sab kuch "Paisa aaya / diya" aur deals se chalega.</p>
        <Field label="Kis tareekh tak ka hisab (as of)"><input type="date" className="input w-auto" max={today} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        <Field label="Capital jo pump ke paas hai (Rs)"><input className="input text-lg font-semibold" type="number" inputMode="decimal" autoFocus value={capital} onChange={(e) => setCapital(e.target.value)} /></Field>
        <p className="-mt-2 text-xs text-slate-500">Nakad ho ya pehle se fuel me laga ho — kul asal raqam. Jo fuel abhi bika nahi, uski deal baad me purani tareekh se banayen.</p>
        <Field label="Munafa jo banta hai magar diya nahi (Rs)"><input className="input" type="number" inputMode="decimal" value={profit} onChange={(e) => setProfit(e.target.value)} /></Field>
        <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. purane register ke mutabiq" /></Field>
        <div className="rounded-xl bg-slate-50 p-2.5 text-sm">Khate me credit: <b>{pkr(cap + pr)}</b></div>
        <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || cap + pr <= 0 || cap < 0 || pr < 0 || asOf > today} onClick={save}>Save</button></div>
      </div>
    </Modal>
  );
}

function MoneyForm({ i, dir, onClose, onDone }: { i: any; dir: "in" | "out"; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("Cash");
  const [account, setAccount] = useState<number | null>(null);
  const [purpose, setPurpose] = useState<"profit" | "capital">("profit");
  const [note, setNote] = useState("");
  useEffect(() => { setAccount(null); }, [method]);
  const amt = Number(amount);
  const tooMuch = dir === "out" && amt > i.free + 0.5;
  const save = () => run(() => api(`/investors/${i.id}/money`, { body: { dir, amount: amt, method, account_id: isCash(method) ? null : account, purpose: dir === "out" ? purpose : undefined, note: note || null } }),
    dir === "in" ? "Paisa darj — investor ke khate me credit" : "Payment darj — investor ke khate me debit").then((r) => { if (r) { onDone(); onClose(); } });
  return (
    <Modal open title={dir === "in" ? `Paisa aaya — ${i.name}` : `Paisa diya — ${i.name}`} onClose={onClose}>
      <div className="space-y-3">
        <p className={`rounded-xl p-2.5 text-sm ${dir === "in" ? "bg-emerald-50 text-emerald-900" : "bg-rose-50 text-rose-900"}`}>{dir === "in"
          ? <>Investor ne paisa diya — khate me <b>Credit</b> (hum par barha), {isCash(method) ? "office cash" : "bank"} me jama.</>
          : <>Investor ko paisa diya — khate me <b>Debit</b>. Free balance: <b>{pkr(i.free)}</b>{i.in_deals ? <> (deal me {pkr(i.in_deals)} laga hai)</> : null}.</>}</p>
        {dir === "out" && (
          <div className="flex gap-1.5">{(["profit", "capital"] as const).map((p) => (
            <button key={p} onClick={() => setPurpose(p)} className={`rounded-full px-3 py-1 text-xs font-semibold ${purpose === p ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600"}`}>{p === "profit" ? "Munafa diya" : "Asal raqam wapas"}</button>
          ))}</div>
        )}
        <Field label="Amount (Rs)"><input className="input text-lg font-semibold" type="number" inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        {tooMuch && <p className="text-sm text-rose-700">Free balance se zyada nahi de sakte.</p>}
        <Field label="Kaise · طریقہ"><div className="flex flex-wrap gap-1.5">{PAY.map((m) => <button key={m} onClick={() => setMethod(m)} className={`rounded-full px-3 py-1 text-xs font-semibold ${method === m ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600"}`}>{m}</button>)}</div></Field>
        <AccountPicker value={account} onChange={setAccount} method={method} required />
        <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !(amt > 0) || tooMuch || (!isCash(method) && !account)} onClick={save}>Save</button></div>
      </div>
    </Modal>
  );
}

function DealForm({ i, d, onClose, onDone }: { i: any; d: any; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const { data: sups } = useApi<any>("/suppliers");
  const list: any[] = Array.isArray(sups) ? sups : sups?.suppliers ?? [];
  const [f, setF] = useState({ product: d.product ?? activeProducts.find((p) => p.code === "HSD")?.code ?? activeProducts[0]?.code ?? "HSD", litres: d.litres ? String(d.litres) : "", cost_rate: d.cost_rate ? String(d.cost_rate) : "", supplier_id: d.supplier_id ? String(d.supplier_id) : "", ref: d.ref ?? "", note: d.note ?? "", deal_date: d.deal_date ?? "" });
  const cost = (Number(f.litres) || 0) * (Number(f.cost_rate) || 0);
  const free = i.free + (d.id ? d.cost_amount : 0);
  const save = () => run(() => api(d.id ? `/investor-deals/${d.id}` : `/investors/${i.id}/deals`, { method: d.id ? "PATCH" : "POST",
    body: { product: f.product, litres: Number(f.litres), cost_rate: Number(f.cost_rate), supplier_id: f.supplier_id ? Number(f.supplier_id) : null, ref: f.ref || null, note: f.note || null, deal_date: f.deal_date || null } }),
    d.id ? "Deal update" : "Deal ban gayi").then((r) => { if (r) { onDone(); onClose(); } });
  return (
    <Modal open wide title={d.id ? `Deal #${d.id} edit` : `Nayi deal — ${i.name}`} onClose={onClose}>
      <p className="mb-3 rounded-xl bg-blue-50 p-2.5 text-sm text-blue-900">Investor ke paise se fuel liya. Free paisa: <b>{pkr(free)}</b>. Fuel bikne par "Bik gaya — band karein" se munafa {i.our_pct}% / {100 - i.our_pct}% batega.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Fuel"><select className="input" value={f.product} onChange={(e) => setF({ ...f, product: e.target.value })}>{activeProducts.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Field>
        <Field label="Supplier (optional)"><select className="input" value={f.supplier_id} onChange={(e) => setF({ ...f, supplier_id: e.target.value })}><option value="">—</option>{list.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Litre"><input className="input" type="number" inputMode="decimal" value={f.litres} onChange={(e) => setF({ ...f, litres: e.target.value })} /></Field>
        <Field label="Khareed rate (Rs/litre)"><input className="input" type="number" inputMode="decimal" step="0.01" value={f.cost_rate} onChange={(e) => setF({ ...f, cost_rate: e.target.value })} /></Field>
        <Field label="Bilty / ref"><input className="input" value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} /></Field>
        <Field label="Tareekh"><input className="input" type="date" value={f.deal_date} onChange={(e) => setF({ ...f, deal_date: e.target.value })} /></Field>
      </div>
      <div className={`mt-3 rounded-xl p-2.5 text-sm ${cost > free + 0.5 ? "bg-rose-50 text-rose-800" : "bg-slate-50 text-slate-700"}`}>Deal ki raqam: <b>{pkr(cost)}</b>{cost > free + 0.5 ? " — free paisa se zyada" : ""}</div>
      <div className="mt-4 flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy || !(cost > 0) || cost > free + 0.5} onClick={save}>Save</button></div>
    </Modal>
  );
}

function CloseDeal({ i, d, onClose, onDone }: { i: any; d: any; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const { data: sug } = useApi<any>(`/investor-deals/${d.id}/suggest`);
  const [f, setF] = useState({ sold_litres: String(d.litres), sale_rate: "", exp_carriage: "", exp_overhead: "", exp_other: "", note: "" });
  const [payNow, setPayNow] = useState(true);
  const [method, setMethod] = useState("Cash");
  const [account, setAccount] = useState<number | null>(null);
  useEffect(() => { if (sug?.sale_rate && !f.sale_rate) setF((x) => ({ ...x, sale_rate: String(sug.sale_rate) })); }, [sug]);
  useEffect(() => { setAccount(null); }, [method]);
  const n = (v: string) => Number(v) || 0;
  const sale = n(f.sold_litres) * n(f.sale_rate), exp = n(f.exp_carriage) + n(f.exp_overhead) + n(f.exp_other);
  const profit = sale - d.cost_amount - exp, theirs = profit * (100 - d.our_pct) / 100, ours = profit - theirs;
  const save = () => run(() => api(`/investor-deals/${d.id}/close`, { body: {
    sold_litres: n(f.sold_litres), sale_rate: n(f.sale_rate), exp_carriage: n(f.exp_carriage), exp_overhead: n(f.exp_overhead), exp_other: n(f.exp_other), note: f.note || null,
    pay_now: payNow && theirs > 0 ? { method, account_id: isCash(method) ? null : account } : null } }), "Deal band — munafa batt gaya").then((r) => { if (r) { onDone(); onClose(); } });
  return (
    <Modal open wide title={`Deal #${d.id} band karein — ${num(d.litres)} L ${PRODUCTS[d.product] ?? d.product}`} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={`Kitna bika (litre) — deal ${num(d.litres)} L`}><input className="input" type="number" value={f.sold_litres} onChange={(e) => setF({ ...f, sold_litres: e.target.value })} /></Field>
        <Field label="Sale rate (Rs/litre)"><input className="input" type="number" step="0.01" value={f.sale_rate} onChange={(e) => setF({ ...f, sale_rate: e.target.value })} />
          {sug && <span className="mt-1 block text-xs text-slate-500">{sug.from_sales ? `Deal ke baad ${PRODUCTS[d.product] ?? d.product} ki average sale rate` : "Aaj ka rate"}: Rs {num(sug.sale_rate ?? 0, 2)}</span>}</Field>
        <Field label="Kiraya / carriage (Rs)"><input className="input" type="number" value={f.exp_carriage} onChange={(e) => setF({ ...f, exp_carriage: e.target.value })} /></Field>
        <Field label="Staff / bijli ka hissa (Rs)"><input className="input" type="number" value={f.exp_overhead} onChange={(e) => setF({ ...f, exp_overhead: e.target.value })} /></Field>
        <Field label="Doosre kharche (Rs)"><input className="input" type="number" value={f.exp_other} onChange={(e) => setF({ ...f, exp_other: e.target.value })} /></Field>
        <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </div>
      <div className="mt-3 overflow-hidden rounded-xl border">
        <table className="w-full text-sm tabular-nums">
          <tbody>
            <tr><td className="td">Sale · {num(n(f.sold_litres))} L × Rs {num(n(f.sale_rate), 2)}</td><td className="td text-right">{pkr(sale)}</td></tr>
            <tr><td className="td">− Khareed · {num(d.litres)} L × Rs {num(d.cost_rate, 2)}{n(f.sold_litres) < d.litres ? <span className="text-amber-700"> (kami {num(d.litres - n(f.sold_litres))} L)</span> : null}</td><td className="td text-right">{pkr(d.cost_amount)}</td></tr>
            <tr><td className="td">− Kharche</td><td className="td text-right">{pkr(exp)}</td></tr>
            <tr className="border-t-2 font-semibold"><td className="td">{profit >= 0 ? "Munafa" : "Nuqsan"}</td><td className={`td text-right ${profit < 0 ? "text-rose-700" : "text-emerald-700"}`}>{pkr(profit)}</td></tr>
            <tr><td className="td">Hamara {d.our_pct}%</td><td className="td text-right">{pkr(ours)}</td></tr>
            <tr className="bg-blue-50 font-semibold"><td className="td">{i.name} ka {100 - d.our_pct}% → khate me {theirs >= 0 ? "Credit" : "Debit"}</td><td className="td text-right">{pkr(theirs)}</td></tr>
          </tbody>
        </table>
      </div>
      {theirs > 0 && (
        <div className="mt-3 space-y-2 rounded-xl bg-emerald-50 p-3">
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={payNow} onChange={(e) => setPayNow(e.target.checked)} /> Investor ka munafa {pkr(theirs)} abhi de diya (har deal ke baad)</label>
          {payNow && <>
            <div className="flex flex-wrap gap-1.5">{PAY.map((m) => <button key={m} onClick={() => setMethod(m)} className={`rounded-full px-3 py-1 text-xs font-semibold ${method === m ? "bg-brand-600 text-white" : "bg-white text-slate-600"}`}>{m}</button>)}</div>
            <AccountPicker value={account} onChange={setAccount} method={method} required />
          </>}
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy || !(n(f.sale_rate) > 0) || n(f.sold_litres) > d.litres || (payNow && theirs > 0 && !isCash(method) && !account)} onClick={save}>Deal band karein</button></div>
    </Modal>
  );
}

/** What the investor asked for from their own page: money out (pay it right here) or a message — answer is shown to them. */
function Requests({ i, list, onDone }: { i: any; list: any[]; onDone: () => void }) {
  const [act, setAct] = useState<any>(null);
  const pending = list.filter((r) => r.status === "pending");
  const ST: Record<string, string> = { pending: "bg-amber-100 text-amber-800", done: "bg-emerald-100 text-emerald-700", rejected: "bg-rose-100 text-rose-700", cancelled: "bg-slate-100 text-slate-500" };
  const LB: Record<string, string> = { pending: "Pending", done: "Ho gaya", rejected: "Mana", cancelled: "Investor ne wapas li" };
  return (
    <div className={`card mb-4 p-4 ${pending.length ? "ring-2 ring-amber-300" : ""}`}>
      <h2 className="mb-2 font-semibold">Investor ki requests · <Ur>درخواستیں</Ur> {pending.length > 0 && <span className="ml-1 rounded-full bg-amber-500 px-2 text-xs text-white">{pending.length} pending</span>}</h2>
      <ul className="divide-y">
        {list.slice(0, 10).map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{r.kind === "withdraw" ? <>💰 {pkr(r.amount)} nikalna — {r.purpose === "capital" ? "asal raqam" : "munafa"}{r.method_pref ? ` · ${r.method_pref}` : ""}</> : <>✉️ Paigham</>}</div>
              <div className="text-xs text-slate-500">{dt(r.created_at)}{r.note ? ` · ${r.note}` : ""}{r.reply ? ` · jawab: ${r.reply}` : ""}</div>
            </div>
            <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${ST[r.status] ?? ""}`}>{LB[r.status] ?? r.status}</span>
            {r.status === "pending" && <button className="btn-primary !py-1 text-xs" onClick={() => setAct(r)}>Jawab / pay</button>}
          </li>
        ))}
      </ul>
      {act && <DecideRequest i={i} r={act} onClose={() => setAct(null)} onDone={onDone} />}
    </div>
  );
}

function DecideRequest({ i, r, onClose, onDone }: { i: any; r: any; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [reply, setReply] = useState("");
  const [amount, setAmount] = useState(String(r.amount ?? ""));
  const [method, setMethod] = useState(/bank/i.test(r.method_pref ?? "") ? "Bank transfer" : "Cash");
  const [account, setAccount] = useState<number | null>(null);
  useEffect(() => { setAccount(null); }, [method]);
  const go = (status: "done" | "rejected") => run(() => api(`/investor-requests/${r.id}/decide`, { body: { status, reply: reply || null,
    pay: status === "done" && r.kind === "withdraw" ? { amount: Number(amount), method, account_id: isCash(method) ? null : account } : null } }),
    status === "done" ? (r.kind === "withdraw" ? "Paisa de diya — investor ke khate me Debit" : "Jawab bhej diya") : "Request mana kar di").then((x) => { if (x) { onDone(); onClose(); } });
  return (
    <Modal open title={r.kind === "withdraw" ? `${i.name}: ${pkr(r.amount)} nikalna` : `${i.name} ka paigham`} onClose={onClose}>
      <div className="space-y-3">
        {r.note && <p className="rounded-xl bg-slate-50 p-2.5 text-sm">"{r.note}"</p>}
        {r.kind === "withdraw" && <>
          <p className="rounded-xl bg-rose-50 p-2.5 text-sm text-rose-900">{r.purpose === "capital" ? "Asal raqam" : "Munafa"} · free balance <b>{pkr(i.free)}</b>. Pay karne par cash/bank se nikal kar investor ke khate me <b>Debit</b> hoga.</p>
          <Field label="Kitna dena hai (Rs)"><input className="input" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Kaise"><div className="flex flex-wrap gap-1.5">{PAY.map((m) => <button key={m} onClick={() => setMethod(m)} className={`rounded-full px-3 py-1 text-xs font-semibold ${method === m ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600"}`}>{m}</button>)}</div></Field>
          <AccountPicker value={account} onChange={setAccount} method={method} required />
        </>}
        <Field label="Jawab (investor ko apne page par dikhega)"><input className="input" value={reply} onChange={(e) => setReply(e.target.value)} placeholder={r.kind === "withdraw" ? "e.g. Cash le jayein / bank me bhej diya" : "e.g. Theek hai, kal baat karte hain"} /></Field>
        <div className="flex flex-wrap justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-secondary !text-rose-700" disabled={busy} onClick={() => go("rejected")}>Mana karein</button>
          <button className="btn-primary" disabled={busy || (r.kind === "withdraw" && (!(Number(amount) > 0) || Number(amount) > i.free + 0.5 || (!isCash(method) && !account)))} onClick={() => go("done")}>{r.kind === "withdraw" ? "Pay karein" : "Jawab bhejein"}</button>
        </div>
      </div>
    </Modal>
  );
}
