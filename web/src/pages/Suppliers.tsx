import { useState } from "react";
import { CancelForm, pinHeader } from "../components/CancelEntry";
import { useAuth } from "../App";
import { FullEditEntry } from "../components/FullEdit";
import { EditBypassPurchase, EditBypassPayment } from "../components/BypassEdit";
import { Plus, Printer, Wallet, Building2, Pencil, Download, Trash2 } from "lucide-react";
import { ImportExport } from "../components/ImportExport";
import { PrintListButton } from "../components/PrintList";
import { PartyAdmin } from "../components/PartyAdmin";
import { DayFeed } from "../components/DayFeed";

import { VoucherSlip } from "./Cashier";
import { api, linkToken, useApi } from "../lib/api";
import { ProofPhotos, ProofThumbs } from "../components/Capture";
import { AccountPicker } from "../components/BankParts";
import { Badge, Empty, Field, ListTools, Loading, Modal, PageHeader, Pager, PhoneInput, SearchBar, Stat, matchQuery, useAction, useListFilter, usePaged } from "../components/ui";
import { WhatsAppDoc } from "../components/WhatsAppDoc";
import { Ur } from "../components/VoiceShell";
import { PRODUCTS, ago, d, dt, num, phone, pkr, pkrShort } from "../lib/format";

const OIL_COMPANIES = ["PSO", "Shell", "Total PARCO", "Attock (APL)", "GO", "Hascol", "Byco / Puma", "Be Energy", "Askar", "Other"];
/** "Shell — Kamran", or just the name when no company is set. */
const label = (s: any) => [s.company, s.name].filter(Boolean).join(" — ");

export default function Suppliers() {
  const { data, reload } = useApi<any[]>("/suppliers");
  const depots = useApi<any[]>("/depots");
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [addDepot, setAddDepot] = useState(false);
  const [editDepot, setEditDepot] = useState<any>(null);
  const [q, setQ] = useState(() => new URLSearchParams(window.location.search).get("q") ?? ""); // global search lands here with ?q=
  const shown = (data ?? []).filter((s) => matchQuery(q, s.name, s.company, s.phone, s.depot_name, s.city));
  const paged = usePaged(shown, 10);
  if (!data) return <Loading />;
  const total = data.reduce((a, s) => a + Math.max(0, s.total_owed ?? s.owed), 0);
  const bypassTotal = data.reduce((a, s) => a + Math.max(0, s.bypass_owed ?? 0), 0);
  // the same money on two sides: pump account minus (overpaid) while the bypass account still shows the bill
  const split = data.filter((s) => (s.owed ?? 0) < -0.5 && (s.bypass_owed ?? 0) > 0.5);
  // group the contacts under their depot (only this page's rows); standalone ones go last under "No depot"
  const byDepot = new Map<string, { depot: any; rows: any[] }>();
  for (const s of paged.slice) {
    const key = s.depot_id ? `d${s.depot_id}` : "none";
    if (!byDepot.has(key)) byDepot.set(key, { depot: s.depot_id ? { id: s.depot_id, name: s.depot_name, address: s.depot_address, city: s.depot_city } : null, rows: [] });
    byDepot.get(key)!.rows.push(s);
  }
  const groups = [...byDepot.values()].sort((a, b) => (a.depot ? 0 : 1) - (b.depot ? 0 : 1) || (a.depot?.name ?? "").localeCompare(b.depot?.name ?? ""));

  return (
    <div className="space-y-5">
      {split.length > 0 && <ReclassBanner rows={split} onDone={() => reload()} />}
      <PageHeader title="Suppliers & depots" subtitle="Har depot ke andar company aur banda — order aur payment sahi aadmi ko. Tanker deliveries bhi yahan khud-ba-khud aati hain."
        actions={<div className="flex flex-wrap gap-2">
          <PrintListButton title="Suppliers & depots · سپلائرز" subtitle={q ? `search "${q}"` : "All suppliers"} rows={groups.flatMap((g) => g.rows)}
            columns={[
              { label: "Supplier", v: (s: any) => label(s), sub: (s: any) => [s.phone && phone(s.phone), s.city].filter(Boolean).join(" · ") },
              { label: "Depot", v: (s: any) => s.depot_name ?? "—", sub: (s: any) => [s.depot_address, s.depot_city].filter(Boolean).join(", ") },
              { label: "This month (L)", r: true, v: (s: any) => num(s.month_l), total: (rs: any[]) => num(rs.reduce((a, s) => a + Number(s.month_l ?? 0), 0)) },
              { label: "Last purchase", v: (s: any) => ago(s.last_purchase) },
              { label: "We owe", r: true, v: (s: any) => pkr(s.owed), total: (rs: any[]) => pkr(rs.reduce((a, s) => a + Math.max(0, s.owed ?? 0), 0)) },
            ]} />
          <WhatsAppDoc kind="supplier_list" id={0} label="WhatsApp" />
          <ImportExport kind="suppliers" onDone={reload} />
          <button className="btn-secondary" onClick={() => setAddDepot(true)}><Building2 size={16} /> Add depot</button>
          <button className="btn-primary" onClick={() => setAdding(true)}><Plus size={16} /> Add contact</button>
        </div>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="We owe suppliers" value={pkrShort(total)} tone="red" hint={bypassTotal > 0 ? `incl. bypass ${pkrShort(bypassTotal)}` : "pump + bypass"} />
        <Stat label="Depots" value={depots.data?.length ?? "—"} />
        <Stat label="Contacts" value={data.length} />
        <Stat label="Bought this month" value={`${num(data.reduce((a, s) => a + s.month_l, 0))} L`} />
      </div>
      <SearchBar value={q} onChange={setQ} placeholder="Supplier, company, phone ya depot dhoondein…" />
      {q && !groups.length && <Empty>"{q}" ke liye koi supplier nahi mila.</Empty>}

      {groups.map(({ depot, rows }) => (
        <div key={depot?.id ?? "none"} className="card overflow-hidden">
          <div className="flex items-start justify-between gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2.5">
            <div className="min-w-0">
              <h2 className="flex items-center gap-1.5 font-semibold">{depot ? <Building2 size={15} className="shrink-0 text-slate-500" /> : null}{depot?.name ?? "No depot (standalone)"}</h2>
              {depot && <div className="text-xs text-slate-500">{[depot.address, depot.city].filter(Boolean).join(" · ") || "No address"}</div>}
            </div>
            <div className="shrink-0 text-right">
              <div className="text-sm font-semibold tabular-nums">{pkr(rows.reduce((a, s) => a + Math.max(0, s.total_owed ?? s.owed), 0))}</div>
              <div className="text-[11px] text-slate-500">we owe</div>
              {depot && <button className="btn-secondary mt-1 !px-2 !py-0.5 text-xs" onClick={() => setEditDepot(depot)}><Pencil size={11} /> Edit</button>}
            </div>
          </div>
          <ul className="divide-y divide-slate-100">
            {rows.map((s) => (
              <li key={s.id} className={`flex cursor-pointer items-start justify-between gap-2 px-4 py-3 active:bg-slate-50 hover:bg-slate-50 ${s.active ? "" : "opacity-50"}`} onClick={() => setOpen(s.id)}>
                <span className="min-w-0">
                  <span className="block font-medium">{s.company ? <><span className="text-slate-900">{s.company}</span> <span className="text-slate-400">—</span> {s.name}</> : s.name}</span>
                  <span className="text-xs text-slate-500">{[s.phone ? phone(s.phone) : "", s.month_l ? `${num(s.month_l)} L this month` : "", s.last_purchase ? `bought ${ago(s.last_purchase)}` : ""].filter(Boolean).join(" · ")}</span>
                </span>
                <span className="shrink-0 text-right"><span className="block font-semibold tabular-nums">{pkr(s.total_owed ?? s.owed)}</span><span className="text-[11px] text-slate-500">we owe · <Ur>باقی</Ur></span>
                  {Math.abs(s.bypass_owed ?? 0) > 0.5 && <span className="block text-[11px] tabular-nums text-slate-500">pump {pkr(s.owed)} · bypass {pkr(s.bypass_owed)}</span>}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {groups.length > 0 && (
        <div className="card flex items-center justify-between gap-2 px-4 py-3 font-semibold">
          <span>Total — we owe all suppliers{q ? " (filtered)" : ""} · <Ur>کل باقی</Ur></span>
          <span className="tabular-nums text-rose-600">{pkr(shown.reduce((a, s) => a + Math.max(0, s.total_owed ?? s.owed ?? 0), 0))}</span>
        </div>
      )}
      <Pager {...paged} />
      {!data.length && <div className="card"><Empty>No suppliers yet. Add a depot, then add the company men inside it.</Empty></div>}

      <DayFeed scope="supplier" title="Supplier ki aaj ki entries" />

      {open && <SupplierDetail id={open} onClose={() => setOpen(null)} onChanged={reload} depots={depots.data ?? []} onDepots={depots.reload} />}
      {adding && <SupplierForm depots={depots.data ?? []} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} onDepots={depots.reload} />}
      {addDepot && <DepotForm onClose={() => setAddDepot(false)} onSaved={() => { setAddDepot(false); depots.reload(); }} />}
      {editDepot && <DepotForm initial={editDepot} onClose={() => setEditDepot(null)} onSaved={() => { setEditDepot(null); depots.reload(); reload(); }} />}
    </div>
  );
}

function DepotForm({ initial, onClose, onSaved }: { initial?: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: initial?.name ?? "", address: initial?.address ?? "", city: initial?.city ?? "", phone: initial?.phone ?? "", notes: initial?.notes ?? "" });
  const { busy, run } = useAction();
  const save = async (e: any) => {
    e.preventDefault();
    const body = { name: f.name, address: f.address || null, city: f.city || null, phone: f.phone || null, notes: f.notes || null };
    const ok = initial ? await run(() => api(`/depots/${initial.id}`, { method: "PATCH", body }), "Depot saved") : await run(() => api("/depots", { body }), "Depot added");
    if (ok) onSaved();
  };
  return (
    <Modal open onClose={onClose} title={initial ? "Edit depot" : "Add depot"}>
      <form className="space-y-3" onSubmit={save}>
        <Field label="Depot name (e.g. Kotadu Depot)"><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Address"><input className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
          <Field label="City"><input className="input" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
        </div>
        <Field label="Depot phone (optional)"><PhoneInput value={f.phone} onChange={(v) => setF({ ...f, phone: v })} /></Field>
        <Field label="Notes (optional)"><input className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <p className="text-xs text-slate-500">Depot sirf header hai — andar company aur banda (jaise Shell — Kamran) alag add karein, khata unhi par chalega.</p>
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy || !f.name}>Save</button></div>
      </form>
    </Modal>
  );
}

/** Add or edit a supplier contact (company + person) inside a depot. */
function SupplierForm({ initial, depots, onClose, onSaved, onDepots }: { initial?: any; depots: any[]; onClose: () => void; onSaved: () => void; onDepots: () => void }) {
  const [f, setF] = useState({
    name: initial?.name ?? "", company: initial?.company ?? "", companyOther: "", depot_id: initial?.depot_id ? String(initial.depot_id) : "",
    phone: initial?.phone ?? "", opening_balance: String(initial?.opening_balance ?? "0"), notes: initial?.notes ?? "",
  });
  const [newDepot, setNewDepot] = useState(false);
  const { busy, run } = useAction();
  const knownCompany = OIL_COMPANIES.includes(f.company);
  const save = async (e: any) => {
    e.preventDefault();
    const company = f.company === "Other" ? (f.companyOther || null) : (f.company || null);
    const base = { name: f.name, company, depot_id: f.depot_id ? Number(f.depot_id) : null, phone: f.phone || null, notes: f.notes || null };
    const ok = initial
      ? await run(() => api(`/suppliers/${initial.id}`, { method: "PATCH", body: base }), "Saved")
      : await run(() => api("/suppliers", { body: { ...base, opening_balance: Number(f.opening_balance) || 0 } }), "Contact added");
    if (ok) onSaved();
  };
  return (
    <Modal open onClose={onClose} title={initial ? "Edit contact" : "Add supplier contact"}>
      {newDepot && <DepotForm onClose={() => setNewDepot(false)} onSaved={() => { setNewDepot(false); onDepots(); }} />}
      <form className="space-y-3" onSubmit={save}>
        <Field label="Depot">
          <div className="flex gap-2">
            <select className="input" value={f.depot_id} onChange={(e) => setF({ ...f, depot_id: e.target.value })}>
              <option value="">— No depot —</option>
              {depots.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <button type="button" className="btn-secondary whitespace-nowrap !px-3" onClick={() => setNewDepot(true)}><Plus size={14} /> New</button>
          </div>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Company">
            <select className="input" value={knownCompany || f.company === "" ? f.company : "Other"} onChange={(e) => setF({ ...f, company: e.target.value })}>
              <option value="">— none —</option>
              {OIL_COMPANIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Person's name (e.g. Kamran)"><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        </div>
        {(f.company === "Other" || (!knownCompany && f.company !== "")) && <Field label="Write the company"><input className="input" value={f.company === "Other" ? f.companyOther : f.company} onChange={(e) => setF({ ...f, company: "Other", companyOther: e.target.value })} /></Field>}
        <Field label="Phone"><PhoneInput value={f.phone} onChange={(v) => setF({ ...f, phone: v })} /></Field>
        {!initial && <Field label="Opening balance we owe (Rs)"><input className="input" type="number" inputMode="decimal" value={f.opening_balance} onChange={(e) => setF({ ...f, opening_balance: e.target.value })} /></Field>}
        <Field label="Notes (optional)"><input className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <div className="flex items-center justify-end gap-2">
          {initial && <button type="button" className="btn-secondary mr-auto !text-amber-700" disabled={busy} onClick={() => run(() => api(`/suppliers/${initial.id}`, { method: "PATCH", body: { active: !initial.active } }), initial.active ? "Deactivated" : "Reactivated").then(onSaved)}>{initial.active ? "Deactivate" : "Reactivate"}</button>}
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy || !f.name}>Save</button>
        </div>
      </form>
    </Modal>
  );
}

/** We overpaid this supplier (they owe us) and now take the money back in cash / bank. Money comes IN; the payable climbs back toward zero. */
function SupplierRefund({ id, owed, onClose, onDone }: { id: number; owed: number; onClose: () => void; onDone: () => void }) {
  const over = Math.max(0, -owed);
  const [f, setF] = useState({ amount: over ? String(Math.round(over)) : "", method: "Cash", note: "" });
  const [photos, setPhotos] = useState<number[]>([]);
  const [account, setAccount] = useState<number | null>(null);
  const { busy, run } = useAction();
  const isCash = /^cash$/i.test(f.method.trim());
  return (
    <Modal open onClose={onClose} title="Overpayment wapas lein · ایڈوانس واپس">
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => api(`/suppliers/${id}/refund`, { body: { amount: Number(f.amount), method: f.method, note: f.note || null, photo_ids: photos, account_id: isCash ? null : account } }), (r: any) => `Refund mila. Ab ${r.owed < 0 ? `supplier ${pkr(-r.owed)} ka qarzdaar` : `we owe ${pkr(r.owed)}`}`)) onDone();
      }}>
        <p className="text-sm text-slate-600">Supplier ke paas hamara: <b>{pkr(over)}</b> (hum ne zyada diya tha)</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Amount (Rs)"><input className="input" type="number" inputMode="decimal" min={1} required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="Method"><select className="input" value={f.method} onChange={(e) => { setF({ ...f, method: e.target.value }); setAccount(null); }}>{["Cash", "Bank transfer", "Online (1LINK)", "Raast", "JazzCash", "Easypaisa"].map((m) => <option key={m}>{m}</option>)}</select></Field>
        </div>
        {!isCash && <AccountPicker method={f.method} label="Kis account mein aaya?" value={account} onChange={setAccount} required />}
        <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <ProofPhotos value={photos} onChange={setPhotos} hint="cash receipt / bank slip" />
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy || !(Number(f.amount) > 0) || (!isCash && !account)}><Wallet size={15} /> Refund record karein</button></div>
      </form>
    </Modal>
  );
}

function SupplierDetail({ id, onClose, onChanged, depots, onDepots }: { id: number; onClose: () => void; onChanged: () => void; depots: any[]; onDepots: () => void }) {
  const { data: s, reload } = useApi<any>(`/suppliers/${id}`);
  const [pay, setPay] = useState({ amount: "", method: "Bank transfer", ref: "", wht: "" });
  const [photos, setPhotos] = useState<number[]>([]);
  const [account, setAccount] = useState<number | null>(null);
  const [slip, setSlip] = useState<any>(null);
  const [refund, setRefund] = useState(false);
  const [edit, setEdit] = useState(false);
  const { busy, run } = useAction();
  const { can } = useAuth();
  const title = s ? label(s) : "Supplier";
  // CEO corrections on a statement line: a pump-side purchase / payment / adjustment is edited in place (amount, ref, note) or
  // voided with a reason; a bypass purchase or payment is voided (then re-entered on the Bypass page — its client leg follows)
  const [editLine, setEditLine] = useState<any>(null);
  const [voidLine, setVoidLine] = useState<any>(null);
  // a bypass line (the wholesale officer's supplier purchase, or a payment we made) has its own editor; client legs are void + re-enter
  const [bypEdit, setBypEdit] = useState<any>(null);
  const bypId = (t: any) => Number(String(t.id).replace(/^b/, ""));
  const canEditBypass = (t: any) => t.source === "bypass" && can("entries.edit") && (t.type === "purchase" || (t.type === "payment" && t.mode === "we_pay"));
  const canEdit = (t: any) => t.source !== "bypass" && can("entries.edit") && !String(t.ref ?? "").match(/^(wtx:|claim:|shopbuy:)/) && t.method !== "WHT" && !t.delivery_id && !t.trip_id;
  const canVoid = (t: any) => t.source === "bypass" ? can("wholesale.void") : can("corrections.manage") && !String(t.ref ?? "").match(/^(wtx:|claim:|shopbuy:)/) && t.method !== "WHT" && !t.delivery_id;
  const lineActions = (t: any) => (
    <>
      {canEdit(t) && <button className="btn-secondary !px-2 !py-1" aria-label="Edit entry" title="Edit (CEO)" onClick={() => setEditLine(t)}><Pencil size={14} /></button>}
      {canEditBypass(t) && <button className="btn-secondary !px-2 !py-1" aria-label="Edit entry" title="Edit (CEO)" onClick={() => setBypEdit(t)}><Pencil size={14} /></button>}
      {canVoid(t) && <button className="btn-secondary !px-2 !py-1 !text-red-700" aria-label="Void entry" title="Void (CEO)" onClick={() => setVoidLine(t)}><Trash2 size={14} /></button>}
    </>
  );
  // on-screen ledger filters only — the printed statement and the CSV always carry the full account
  const [lq, setLq] = useState("");
  const [lrange, setLrange] = useState({ from: "", to: "" });
  const [ltype, setLtype] = useState("");
  const allLines: any[] = s?.lines ?? [];
  const typeChips = [{ k: "", label: "All", n: allLines.length }, ...["purchase", "payment", "adjustment"].map((k) => ({ k, label: k[0].toUpperCase() + k.slice(1), n: allLines.filter((t) => t.type === k).length })).filter((c) => c.n > 0),
    ...(allLines.some((t) => t.source === "bypass") ? [{ k: "pump", label: "Pump only", n: allLines.filter((t) => t.source !== "bypass").length }, { k: "bypass", label: "Bypass only", n: allLines.filter((t) => t.source === "bypass").length }] : [])];
  const lines = useListFilter(allLines, { q: lq, from: lrange.from, to: lrange.to, dateKey: "txn_date", keep: (t) => !ltype || (ltype === "pump" ? t.source !== "bypass" : ltype === "bypass" ? t.source === "bypass" : t.type === ltype),
    text: (t) => [t.ref, t.note, t.method, t.product, t.product && PRODUCTS[t.product], t.litres, t.rate, t.debit, t.credit, t.amount].filter((v) => v != null && v !== false && v !== "").join(" ") });
  const lineFiltered = lines.length !== allLines.length;
  // totals for the entries list: today's payment to this supplier + the shown (filtered) paid / purchased
  const pkToday = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
  const isPkToday = (iso: string) => new Date(Date.parse(iso) + 5 * 3600_000).toISOString().slice(0, 10) === pkToday;
  const paidToday = allLines.filter((t) => t.type === "payment" && isPkToday(t.txn_date)).reduce((a, t) => a + (t.credit || 0), 0);
  const paidShown = lines.reduce((a, t) => a + (t.credit || 0), 0);
  const boughtShown = lines.reduce((a, t) => a + (t.debit || 0), 0);
  // total litres taken from this supplier (purchase rows in the shown set) — kitna maal uthaya
  const litresShown = lines.reduce((a, t) => a + (t.type === "purchase" ? (Number(t.litres) || 0) : 0), 0);
  // the cashier's two-copy payment voucher, for a payment made from this page
  const voucherOf = (t: any, owedAfter: number | null) => ({
    prepared: true, party_type: "supplier", balance_after: owedAfter, account: t.account_name,
    voucher: { no: `SP-${String(t.id).padStart(5, "0")}`, direction: "out", amount: t.amount, party_name: label(s), method: t.method, ref: t.ref,
      note: [s.depot_name ? `Depot: ${s.depot_name}` : "", t.note, t.withholding ? `Income tax withheld ${pkr(t.withholding)} (paid to FBR)` : ""].filter(Boolean).join(" · ") || null, created_by: t.created_by, created_at: t.created_at },
  });
  const printable = (t: any) => t.type === "payment" && t.method !== "WHT";
  return (
    <Modal open onClose={onClose} title={title} wide xl>
      {slip && <VoucherSlip r={slip} onClose={() => setSlip(null)} />}
      {refund && <SupplierRefund id={id} owed={Number(s.owed)} onClose={() => setRefund(false)} onDone={() => { setRefund(false); reload(); onChanged(); }} />}
      {edit && s && <SupplierForm initial={s} depots={depots} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); reload(); onChanged(); }} onDepots={onDepots} />}
      {!s ? <Loading /> : (
        <div className="space-y-4">
          {(s.owed ?? 0) < -0.5 && (s.bypass_owed ?? 0) > 0.5 && <ReclassBanner rows={[s]} onDone={() => { reload(); onChanged(); }} />}
          {/* on paper: the supplier's account, oldest entry first, like a bank statement */}
          <div className="own-title hidden print:block">
            <div className="flex items-end justify-between border-b border-slate-300 pb-2">
              <div><div className="text-lg font-bold">{label(s)}</div><div className="text-xs text-slate-600">{[s.depot_name ? `Depot: ${s.depot_name}${s.depot_address ? `, ${s.depot_address}` : ""}` : "", s.phone ? phone(s.phone) : "", "Supplier account statement"].filter(Boolean).join(" · ")}</div></div>
              <div className="text-right text-sm">We owe: <b className="tabular-nums">{pkr(s.total_owed ?? s.owed)}</b><div className="text-xs text-slate-500">{Math.abs(s.bypass_owed ?? 0) > 0.5 ? `pump ${pkr(s.owed)} · bypass ${pkr(s.bypass_owed)} · ` : ""}as on {dt(new Date().toISOString())}</div></div>
            </div>
            <table className="mt-2 w-full">
              <thead><tr><th className="th">Date</th><th className="th">Entry</th><th className="th">Gaari</th><th className="th">Fuel</th><th className="th text-right">Litres</th><th className="th text-right">Rate</th><th className="th">Tafseel</th><th className="th text-right">Purchased</th><th className="th text-right">Paid</th><th className="th text-right">We owe</th></tr></thead>
              <tbody>
                <tr><td className="td" colSpan={9}>Opening balance</td><td className="td whitespace-nowrap text-right tabular-nums">{pkr(s.opening_balance ?? 0)}</td></tr>
                {[...s.lines].reverse().map((t: any) => (
                  <tr key={t.id}>
                    <td className="td whitespace-nowrap">{d(t.txn_date)}</td><td className="td capitalize">{t.type}{t.source === "bypass" ? " (bypass)" : ""}</td>
                    <td className="td whitespace-nowrap">{t.vehicle_no ?? ""}{t.driver_name ? <span className="block text-[10px] text-slate-500">{t.driver_name}</span> : null}</td>
                    <td className="td">{t.product ? PRODUCTS[t.product] ?? t.product : ""}</td>
                    <td className="td whitespace-nowrap text-right tabular-nums">{t.litres ? num(t.litres, t.litres % 1 ? 2 : 0) : ""}</td>
                    <td className="td whitespace-nowrap text-right tabular-nums">{t.rate ? num(t.rate, 2) : ""}</td>
                    <td className="td">{t.type === "payment" ? t.method : ""}<span className="text-[10px] text-slate-500">{[t.ref !== t.vehicle_no ? t.ref : null, t.note].filter(Boolean).map((x) => ` · ${x}`).join("")}</span></td>
                    <td className="td whitespace-nowrap text-right tabular-nums text-rose-700">{t.debit ? pkr(t.debit) : ""}</td>
                    <td className="td whitespace-nowrap text-right tabular-nums text-emerald-700">{t.credit ? pkr(t.credit) : ""}</td>
                    <td className="td whitespace-nowrap text-right tabular-nums">{pkr(t.balance)}</td>
                  </tr>))}
                <tr className="font-bold"><td className="td border-t-2 border-slate-800" colSpan={4}>Closing balance (we owe)</td>
                <td className="td border-t-2 border-slate-800 whitespace-nowrap text-right tabular-nums">{num(s.lines.reduce((a: number, t: any) => a + (t.type === "purchase" ? t.litres ?? 0 : 0), 0))} L</td>
                <td className="td border-t-2 border-slate-800" colSpan={2} />
                <td className="td border-t-2 border-slate-800 whitespace-nowrap text-right tabular-nums text-rose-700">{pkr(s.lines.reduce((a: number, t: any) => a + t.debit, 0))}</td>
                <td className="td border-t-2 border-slate-800 whitespace-nowrap text-right tabular-nums text-emerald-700">{pkr(s.lines.reduce((a: number, t: any) => a + t.credit, 0))}</td>
                <td className="td whitespace-nowrap text-right tabular-nums">{pkr(s.total_owed ?? s.owed)}</td></tr>
              </tbody>
            </table>
            <div className="mt-8 grid break-inside-avoid grid-cols-2 gap-10 text-center text-xs text-slate-600"><div className="border-t border-slate-500 pt-1">Prepared by</div><div className="border-t border-slate-500 pt-1">Supplier (confirmed) · <Ur>سپلائر</Ur></div></div>
          </div>
          {/* depot / company header on screen */}
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            {s.depot_name && <span className="badge gap-1 bg-slate-100 text-slate-700"><Building2 size={12} /> {s.depot_name}{s.depot_address ? ` · ${s.depot_address}` : ""}</span>}
            {s.company && <Badge tone="blue">{s.company}</Badge>}
            <button type="button" className="btn-secondary ml-auto min-h-9 !py-1" onClick={() => setEdit(true)}><Pencil size={14} /> Edit contact</button>
            <PartyAdmin kind="supplier" id={s.id} name={s.name} backTo="/suppliers" onDone={() => { onChanged(); onClose(); }} className="min-h-9 !py-1" />
          </div>
          <div className="flex flex-wrap items-end gap-3 print:hidden">
            <Stat label="We owe (pump + bypass)" value={pkr(s.total_owed ?? s.owed)} tone="red" hint={Math.abs(s.bypass_owed ?? 0) > 0.5 ? `pump ${pkr(s.owed)} · bypass ${pkr(s.bypass_owed)}` : undefined} />
            <a className="btn-secondary min-h-10" href={`/api/suppliers/${id}/statement.csv?token=${linkToken()}`}><Download size={15} /> Excel / CSV</a>
            <WhatsAppDoc kind="supplier" id={Number(id)} className="btn-secondary min-h-10" />
            <button type="button" className="btn-secondary min-h-10" onClick={() => window.print()}><Printer size={15} /> Print statement · <Ur>پرنٹ</Ur></button>
            {Number(s.owed) < -0.5 && <button type="button" className="btn-secondary min-h-10 !text-emerald-700" onClick={() => setRefund(true)}><Wallet size={15} /> Overpayment wapas · <Ur>ایڈوانس واپس</Ur></button>}
            <form className="grid w-full basis-full grid-cols-2 items-end gap-2 sm:flex sm:min-w-0 sm:flex-1 sm:basis-auto sm:flex-wrap" onSubmit={async (e) => {
              e.preventDefault();
              const res: any = await run(() => api(`/suppliers/${id}/payment`, { body: { amount: Number(pay.amount), method: pay.method, ref: pay.ref || null, withholding: Number(pay.wht) || 0, photo_ids: photos, account_id: account } }), (r: any) => r.pending ? r.message : `Payment saved. We now owe ${pkr(r.owed)}`);
              if (res?.pending) { alert(res.message); setPay({ ...pay, amount: "", ref: "", wht: "" }); setPhotos([]); reload(); return; }
              if (res) { setPay({ ...pay, amount: "", ref: "", wht: "" }); setPhotos([]); reload(); onChanged(); if (res.payment) setSlip(voucherOf(res.payment, res.owed)); }
            }}>
              <Field label="Pay amount (Rs)"><input className="input sm:w-40" type="number" inputMode="decimal" min={1} required value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></Field>
              <Field label="Method"><select className="input" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>{["Bank transfer", "Pay order", "Online (1LINK)", "Cheque", "Cash"].map((m) => <option key={m}>{m}</option>)}</select></Field>
              <Field label="Ref"><input className="input sm:w-32" value={pay.ref} onChange={(e) => setPay({ ...pay, ref: e.target.value })} /></Field>
              <Field label="Tax withheld (Rs)"><input className="input sm:w-32" type="number" inputMode="decimal" min={0} placeholder="0" value={pay.wht} onChange={(e) => setPay({ ...pay, wht: e.target.value })} /></Field>
              <div className="col-span-2 w-full"><AccountPicker method={pay.method} label="Paid from which bank? · کس بینک سے" value={account} onChange={setAccount} /></div>
              <button className="btn-primary col-span-2" disabled={busy || (pay.method === "Cheque" && !photos.length)}><Wallet size={15} /> Record payment</button>
              <div className="col-span-2 w-full"><ProofPhotos value={photos} onChange={setPhotos} required={pay.method === "Cheque"} hint="pay order, cheque, bank / 1LINK receipt" /></div>
            </form>
          </div>
          {allLines.length > 0 && <ListTools q={lq} onQ={setLq} placeholder="Ref / product… · ریفرنس یا پراڈکٹ" chips={typeChips} chip={ltype} onChip={setLtype}
            from={lrange.from} to={lrange.to} onFrom={(v) => setLrange({ ...lrange, from: v })} onTo={(v) => setLrange({ ...lrange, to: v })} shown={lines.length} total={allLines.length} />}
          {allLines.length > 0 && <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded-lg bg-emerald-50 px-3 py-1.5 font-semibold text-emerald-800">Aaj di payment · <Ur>آج کی ادائیگی</Ur>: {pkr(paidToday)}</span>
            <span className="rounded-lg bg-slate-100 px-3 py-1.5 tabular-nums">{lineFiltered ? "Filter mein" : "Kul"} · Paid {pkr(paidShown)}{boughtShown ? ` · Purchased ${pkr(boughtShown)}` : ""}{litresShown ? ` · ${num(litresShown)} L` : ""}</span>
          </div>}
          <div className="max-h-96 overflow-auto rounded-lg border border-slate-200 print:hidden">
            <ul className="divide-y divide-slate-100 sm:hidden">
              {lines.map((t: any) => (
                <li key={t.id} className="px-3 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0"><Badge tone={t.type === "purchase" ? "blue" : t.type === "payment" ? "green" : "violet"}>{t.type}</Badge>{t.source === "bypass" && <Badge tone="amber">bypass</Badge>} <span className="text-xs text-slate-500">{dt(t.txn_date)}</span></span>
                    <span className="shrink-0 text-right tabular-nums">{t.debit ? <span className="block font-semibold text-rose-700">{pkr(t.debit)}</span> : null}{t.credit ? <span className="block font-semibold text-emerald-700">−{pkr(t.credit)}</span> : null}<span className="text-[11px] text-slate-500">owe {pkr(t.balance)}</span></span>
                  </div>
                  {t.product && <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs tabular-nums text-slate-700">
                    {t.vehicle_no && <b className="font-semibold">🚛 {t.vehicle_no}{t.driver_name ? <span className="font-normal text-slate-500"> · {t.driver_name}</span> : null}</b>}
                    <span>{PRODUCTS[t.product] ?? t.product}</span><span>{num(t.litres, t.litres % 1 ? 2 : 0)} L</span>{t.rate ? <span>Rs {num(t.rate, 2)}/L</span> : null}</div>}
                  <div className="break-words text-xs text-slate-600">{!t.product ? t.method : null} <span className="text-slate-500">{[t.ref, t.note].filter(Boolean).join(" · ")}</span></div>
                  <div className="flex items-center justify-between gap-2"><ProofThumbs ids={t.proof_ids} />
                    <span className="ml-auto flex gap-1">{lineActions(t)}{printable(t) && <button className="btn-secondary min-h-9 !px-2 !py-1" aria-label="Print voucher" onClick={() => setSlip(voucherOf(t, t.balance))}><Printer size={14} /></button>}</span></div>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[900px]">
              <thead className="sticky top-0"><tr><th className="th">Date</th><th className="th">Entry</th><th className="th">Gaari · driver</th><th className="th">Fuel</th><th className="th text-right">Litres</th><th className="th text-right">Rate</th><th className="th">Tafseel</th><th className="th text-right">Purchased</th><th className="th text-right">Paid</th><th className="th text-right">We owe</th><th className="th" /></tr></thead>
              <tbody>{lines.map((t: any) => (
                <tr key={t.id}>
                  <td className="td whitespace-nowrap text-xs">{dt(t.txn_date)}</td>
                  <td className="td"><Badge tone={t.type === "purchase" ? "blue" : t.type === "payment" ? "green" : "violet"}>{t.type}</Badge>{t.source === "bypass" && <> <Badge tone="amber">bypass</Badge></>}</td>
                  <td className="td text-xs">{t.vehicle_no ? <b className="whitespace-nowrap font-semibold text-slate-800">🚛 {t.vehicle_no}</b> : <span className="text-slate-300">—</span>}{t.driver_name && <span className="block text-slate-500">{t.driver_name}</span>}</td>
                  <td className="td whitespace-nowrap text-xs">{t.product ? PRODUCTS[t.product] ?? t.product : ""}</td>
                  <td className="td whitespace-nowrap text-right text-xs tabular-nums">{t.litres ? `${num(t.litres, t.litres % 1 ? 2 : 0)} L` : ""}</td>
                  <td className="td whitespace-nowrap text-right text-xs tabular-nums">{t.rate ? `Rs ${num(t.rate, 2)}` : ""}</td>
                  <td className="td min-w-[180px] text-xs">{t.type === "payment" && t.method ? <span className="font-medium">{t.method}{t.account_name ? ` · ${t.account_name}` : ""}</span> : null} <span className="text-slate-500">{[t.ref !== t.vehicle_no ? t.ref : null, t.note].filter(Boolean).join(" · ")}</span> <ProofThumbs ids={t.proof_ids} /></td>
                  <td className="td whitespace-nowrap text-right tabular-nums text-rose-700">{t.debit ? pkr(t.debit) : ""}</td>
                  <td className="td whitespace-nowrap text-right tabular-nums text-emerald-700">{t.credit ? pkr(t.credit) : ""}</td>
                  <td className="td whitespace-nowrap text-right font-medium tabular-nums">{pkr(t.balance)}</td>
                  <td className="td"><div className="flex justify-end gap-1">{lineActions(t)}{printable(t) && <button className="btn-secondary !px-2 !py-1" aria-label="Print voucher" title="Print voucher" onClick={() => setSlip(voucherOf(t, t.balance))}><Printer size={14} /></button>}</div></td>
                </tr>
              ))}</tbody>
            </table>
            </div>
            {!s.lines.length && <Empty>No entries</Empty>}
            {allLines.length > 0 && !lines.length && lineFiltered && <Empty>Kuch nahi mila · کچھ نہیں ملا</Empty>}
          </div>
          {editLine && <FullEditEntry kind="supplier" id={editLine.id} onClose={() => setEditLine(null)} onDone={() => { setEditLine(null); reload(); onChanged(); }} />}
          {bypEdit && bypEdit.type === "purchase" && <EditBypassPurchase x={{ ...bypEdit, id: bypId(bypEdit), cost_rate: bypEdit.rate, supplier_name: s?.name, client_fuel: bypEdit.client_fuel || s?.client_id }} onClose={() => setBypEdit(null)} onDone={() => { setBypEdit(null); reload(); onChanged(); }} />}
          {bypEdit && bypEdit.type === "payment" && <EditBypassPayment x={{ ...bypEdit, id: bypId(bypEdit) }} onClose={() => setBypEdit(null)} onDone={() => { setBypEdit(null); reload(); onChanged(); }} />}
          {voidLine && <VoidLine t={voidLine} supplier={label(s)} onClose={() => setVoidLine(null)} onDone={() => { setVoidLine(null); reload(); onChanged(); }} />}
        </div>
      )}
    </Modal>
  );
}

/** Void one statement line with a reason (CEO). Pump-side rows go through Corrections; bypass rows through the Bypass void routes. */
function VoidLine({ t, supplier, onClose, onDone }: { t: any; supplier: string; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const isBypass = t.source === "bypass";
  const rawId = String(t.id).replace(/^b/, "");
  const url = isBypass ? (t.type === "purchase" ? `/bypass/purchases/${rawId}/void` : `/bypass/payments/${rawId}/void`) : `/corrections/supplier-txn/${t.id}/void`;
  const what = `${t.type}${isBypass ? " (bypass)" : ""} · ${t.product ? `${num(t.litres)} L ${PRODUCTS[t.product]} · ` : ""}${pkr(t.amount)}`;
  return <CancelForm title={`Entry mansookh karein — ${supplier}`} busy={busy} onClose={onClose}
    what={<><b>{what}</b><div className="text-xs">{dt(t.txn_date)}{t.ref ? ` · ${t.ref}` : ""}{t.note ? ` · ${t.note}` : ""}</div></>}
    hint={isBypass ? "Bypass entry mansookh hogi (payment ke saath client ki taraf wali entry bhi). Sahi entry Bypass page se dobara karein." : "Entry hat jayegi: supplier ka baqaya, cash/bank aur ledger sab wapas ho jayenge. Audit log me wajah ke saath record rahega."}
    onDone={async (a) => { if (await run(() => api(url, { body: { reason: a.reason }, headers: pinHeader(a) }), "Entry mansookh ho gayi")) onDone(); }} />;
}

/** Pump account minus + bypass account plus for the same supplier = a payment that was posted on the wrong account. One click
 *  moves it (a journal, no cash): both statements then read right and the total stays the same. */
function ReclassBanner({ rows, onDone }: { rows: any[]; onDone: () => void }) {
  const { can } = useAuth();
  const { busy, run } = useAction();
  const amt = (s: any) => Math.min(-(s.owed ?? 0), s.bypass_owed ?? 0);
  const total = rows.reduce((a, s) => a + amt(s), 0);
  const fix = async () => {
    if (!confirm(`${rows.length} supplier${rows.length > 1 ? "s" : ""} ka ${pkr(total)} pump account se bypass account par muntaqil karein? Cash / bank nahi hilega, sirf dono statements theek honge.`)) return;
    const r = rows.length === 1 ? await run(() => api(`/suppliers/${rows[0].id}/reclass`, { body: {} }), "Hisaab barabar — dono account theek") : await run(() => api("/suppliers-reclass/all", { body: {} }), (x: any) => `${x.done.length} suppliers ka hisaab barabar`);
    if (r) onDone();
  };
  return (
    <div className="print:hidden rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <b>Hisaab do accounts me bikhra hai</b> — {rows.length === 1 ? <>{rows[0].name}: pump account par <b>{pkr(-(rows[0].owed ?? 0))}</b> zyada diya hua, bypass account par <b>{pkr(rows[0].bypass_owed)}</b> baqi.</> : <>{rows.length} suppliers: pump account minus, bypass account plus — kul <b>{pkr(total)}</b>.</>}
          <span className="block text-xs">Wajah: adaigi pump account par likhi gayi jab ke bill bypass (client wale maal) ka tha. Ab se adaigi khud pehle bypass par lagti hai. Purani entries ek click se theek: cash / bank nahi hilta, kul "we owe" wahi rehta hai, dono statements me "Pump → bypass transfer" ki line aati hai.</span>
        </div>
        {can("entries.edit") && <button className="btn-primary !bg-amber-600" disabled={busy} onClick={fix}>Hisaab barabar karein · {pkr(total)}</button>}
      </div>
    </div>
  );
}
