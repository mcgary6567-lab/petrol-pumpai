/**
 * Gari statement · گاڑی اسٹیٹمنٹ — one vehicle in one party's account (khata customer, wholesale client, supplier) between
 * two dates: every entry with litres, rate, debit, credit and a running total, plus totals by item. Print, PDF, WhatsApp.
 */
import { useEffect, useState } from "react";
import { Truck, Printer, Download } from "lucide-react";
import { useApi, linkToken } from "../lib/api";
import { num, pkr } from "../lib/format";
import { printNow } from "../lib/printNow";
import { Field, Loading, Modal } from "./ui";
import { WhatsAppDoc } from "./WhatsAppDoc";

type Party = "khata" | "wholesale" | "supplier";
const KIND = { khata: "khata_vehicle", wholesale: "wholesale_vehicle", supplier: "supplier_vehicle" } as const;
const Ur = ({ children }: { children: React.ReactNode }) => <span lang="ur" dir="rtl" className="font-urdu font-normal">{children}</span>;
const pkDay = (iso: string) => new Date(Date.parse(iso) + 5 * 3600_000).toISOString().slice(0, 10);
const dmy = (iso: string) => { const [y, m, d] = pkDay(iso).split("-"); return `${d}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]}-${y}`; };
const monthStart = () => pkDay(new Date().toISOString()).slice(0, 8) + "01";

/** The button that opens it; vehicle / dates may be handed in (e.g. the statement's own filter). */
export function VehicleStatementButton({ party, id, name, vehicle, from, to, className = "btn-secondary" }: { party: Party; id: number; name: string; vehicle?: string; from?: string; to?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} title="Ek gaari ki entries, litre, debit / credit — print / WhatsApp"><Truck size={15} /> Gari statement · <Ur>گاڑی</Ur></button>
      {open && <VehicleStatement party={party} id={id} name={name} vehicle={vehicle} from={from} to={to} onClose={() => setOpen(false)} />}
    </>
  );
}

export function VehicleStatement({ party, id, name, vehicle: v0, from: f0, to: t0, onClose }: { party: Party; id: number; name: string; vehicle?: string; from?: string; to?: string; onClose: () => void }) {
  const vehicles = useApi<{ vehicle: string; entries: number }[]>(`/vehicle-statement/vehicles?party=${party}&id=${id}`);
  const [vehicle, setVehicle] = useState(v0 ?? "");
  const [range, setRange] = useState({ from: f0 ?? monthStart(), to: t0 ?? "" });
  useEffect(() => { if (!vehicle && vehicles.data?.length) setVehicle(vehicles.data[0].vehicle); }, [vehicles.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const qs = new URLSearchParams(Object.entries({ vehicle, from: range.from, to: range.to }).filter(([, x]) => x) as [string, string][]).toString();
  const { data, loading } = useApi<any>(vehicle ? `/vehicle-statement?party=${party}&id=${id}&${qs}` : null);
  const pdf = `/api/docs/${KIND[party]}/${id}/pdf?${qs}&token=${linkToken()}`;
  const t = data?.totals;
  const sup = party === "supplier";
  const period = `${range.from ? dmy(`${range.from}T07:00:00Z`) : "shuru"} — ${range.to ? dmy(`${range.to}T07:00:00Z`) : "aaj"}`;
  return (
    <Modal open onClose={onClose} title={`🚛 Gari statement · ${name}`} wide>
      <div className="grid gap-3 print:hidden sm:grid-cols-[1.3fr_1fr_1fr]">
        <Field label="Gaari no. · گاڑی">
          <input className="input uppercase" list="vs-vehicles" value={vehicle} onChange={(e) => setVehicle(e.target.value.toUpperCase())} placeholder="LEH-453" aria-label="Gaari no." />
          <datalist id="vs-vehicles">{(vehicles.data ?? []).map((x) => <option key={x.vehicle} value={x.vehicle}>{x.entries ? `${x.entries} entries` : "saved"}</option>)}</datalist>
        </Field>
        <Field label="From"><input className="input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
        <Field label="To"><input className="input" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
      </div>
      {(vehicles.data?.length ?? 0) > 0 && <div className="mt-2 flex flex-wrap gap-1.5 print:hidden">{vehicles.data!.slice(0, 12).map((x) => (
        <button key={x.vehicle} type="button" onClick={() => setVehicle(x.vehicle)} className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${x.vehicle === vehicle ? "border-violet-400 bg-violet-50 text-violet-700" : "border-slate-200 text-slate-600"}`}>{x.vehicle}{x.entries ? ` · ${x.entries}` : ""}</button>))}</div>}
      {!vehicle ? <p className="p-6 text-center text-sm text-slate-500">Gaari no. likhein ya upar se chunein.</p> : loading && !data ? <Loading /> : data && (
        <div className="mt-3">
          <div className="mb-2 hidden print:block"><div className="text-lg font-bold">Gari statement — {data.vehicle}</div><div className="text-sm">{name} · {period}</div></div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {[["Gaari", data.vehicle], ["Entries", String(t.entries)], ["Fuel litre", num(t.litres, 2)], [sup ? "Khareed" : "Debit", pkr(t.debit)], [sup ? "Paid" : "Credit", pkr(t.credit)]].map(([l, v]) => (
              <div key={l} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"><div className="text-xs text-slate-500">{l}</div><div className="font-bold tabular-nums">{v}</div></div>))}
          </div>
          {t.by_item.length > 0 && <div className="mt-2 flex flex-wrap gap-2 text-xs">{t.by_item.map((x: any) => <span key={x.item} className="rounded-lg bg-violet-50 px-2 py-1 text-violet-900"><b>{x.item}</b> · {x.entries} · {x.litres ? `${num(x.litres, 2)} L · ` : ""}{pkr(x.amount)}</span>)}</div>}
          <div className="mt-2 max-h-[50vh] overflow-auto print:max-h-none">
            <table className="w-full min-w-[720px] text-sm">
              <thead><tr>{["Date", "No.", "Slip", "Tafseel", "Litre", "Rate", "Debit", "Credit", "Running"].map((h) => <th key={h} className={`th ${["Litre", "Rate", "Debit", "Credit", "Running"].includes(h) ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
              <tbody>
                {data.lines.map((l: any) => (
                  <tr key={`${l.no}-${l.id}`}>
                    <td className="td whitespace-nowrap text-xs">{dmy(l.at)}</td><td className="td whitespace-nowrap font-mono text-xs">{l.no}</td><td className="td text-xs">{l.slip ?? ""}</td>
                    <td className="td text-xs">{l.item}{l.note ? <span className="text-slate-500"> · {l.note}</span> : null}</td>
                    <td className="td text-right tabular-nums">{l.litres ? num(l.litres, 2) : ""}</td><td className="td text-right tabular-nums">{l.rate ? num(l.rate, 2) : ""}</td>
                    <td className="td text-right tabular-nums">{l.debit ? pkr(l.debit) : ""}</td><td className="td text-right tabular-nums text-emerald-700">{l.credit ? pkr(l.credit) : ""}</td>
                    <td className="td text-right font-semibold tabular-nums">{pkr(l.running)}</td>
                  </tr>))}
                {!data.lines.length && <tr><td className="td py-6 text-center text-slate-500" colSpan={9}>Is gaari ki is muddat mein koi entry nahi</td></tr>}
              </tbody>
              {data.lines.length > 0 && <tfoot><tr className="font-bold"><td className="td" colSpan={4}>Total · {t.entries} entries</td><td className="td text-right tabular-nums">{num(t.litres, 2)}</td><td className="td" />
                <td className="td text-right tabular-nums">{pkr(t.debit)}</td><td className="td text-right tabular-nums">{pkr(t.credit)}</td><td className="td text-right tabular-nums">{pkr(t.net)}</td></tr></tfoot>}
            </table>
          </div>
        </div>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3 print:hidden">
        {vehicle && <WhatsAppDoc kind={KIND[party]} id={id} vehicle={vehicle} from={range.from || undefined} to={range.to || undefined} />}
        {vehicle && <a className="btn-secondary" href={pdf} target="_blank" rel="noreferrer"><Download size={15} /> PDF</a>}
        {vehicle && <button className="btn-primary" onClick={() => printNow({ title: `Gari statement — ${vehicle}`, pdf })}><Printer size={15} /> Print</button>}
      </div>
    </Modal>
  );
}
