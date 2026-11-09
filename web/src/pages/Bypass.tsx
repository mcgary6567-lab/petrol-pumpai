import { BypassPnl } from "../components/BypassPnl";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { askCancel, pinHeader } from "../components/CancelEntry";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from "recharts";
import { Plus, Truck, Fuel, Factory, Download, Printer, HandCoins, Ban, Pencil } from "lucide-react";
import { api, linkToken, useApi } from "../lib/api";
import { Empty, ErrorBox, Field, ListTools, Loading, Modal, Pager, Stat, useAction, useListFilter, usePaged } from "../components/ui";
import { PRODUCTS, activeProducts, dt, num, phone, pkr, pkrShort } from "../lib/format";
import { useAuth } from "../App";
import { ProofPhotos, ProofThumbs } from "../components/Capture";
import { AccountPicker } from "../components/BankParts";
import { supplierOpts } from "../components/SupplierSelect";
import { FleetPicker, fleetBody } from "../components/WholesaleFleet";
import { EditBypassPurchase, SupplierClientLink } from "../components/BypassEdit";
import { challanPages, printPages, tripSheetPage } from "../components/TripPrint";
import { VoucherVoidButton } from "../components/VoucherVoid";

const Ur = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => <span lang="ur" dir="rtl" className={`font-urdu ${className}`}>{children}</span>;

/** Bypass delivery — shown inside the Wholesale "Tanker trips" tab: buy fuel from suppliers at the depot and deliver straight to wholesale clients. */
export type BypassSection = "all" | "kpis" | "deliveries" | "suppliers" | "stock" | "tank" | "profit";
export function BypassPanel({ section = "all" }: { section?: BypassSection }) {
  const show = (k: Exclude<BypassSection, "all">) => section === "all" || section === k;
  const sups = useApi<any[]>("/bypass/suppliers");
  const [dq, setDq] = useState("");
  const [dqDebounced, setDqDebounced] = useState("");
  const [dRange, setDRange] = useState({ from: "", to: "" });
  const [dLimit, setDLimit] = useState(60);
  useEffect(() => { const t = setTimeout(() => setDqDebounced(dq.trim()), 300); return () => clearTimeout(t); }, [dq]);
  const delsQs = new URLSearchParams({ ...(dqDebounced ? { q: dqDebounced } : {}), ...(dRange.from ? { from: dRange.from } : {}), ...(dRange.to ? { to: dRange.to } : {}), limit: String(dLimit) }).toString();
  const dels = useApi<any[]>(`/bypass/deliveries?${delsQs}`);
  const delsPaged = usePaged((dels.data ?? []) as any[], 10);
  const delsFiltered = Boolean(dqDebounced || dRange.from || dRange.to);
  const stock = useApi<any>("/bypass/stock");
  const monthly = useApi<any[]>("/bypass/monthly?months=6");
  const [openSup, setOpenSup] = useState<number | null>(null);
  const [voucher, setVoucher] = useState<number | null>(null);
  const refresh = () => { sups.reload(); dels.reload(); stock.reload(); monthly.reload(); };
  const owedTotal = (sups.data ?? []).reduce((a, s) => a + (s.bypass_owed > 0 ? s.bypass_owed : 0), 0);
  const stockLines = (stock.data?.by_product ?? []) as any[];
  return (
    <div className="space-y-4">
      {section === "all" && <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="flex items-center gap-2 text-lg font-semibold"><Truck size={18} className="text-slate-500" /> Bypass supplier accounts · <Ur>بائی پاس</Ur></h2>
          <p className="text-sm text-slate-500">Depot se seedha client ko — naya bypass "New trip" button se banayein (Depot bypass mode)</p></div>
      </div>
      <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900">Hum supplier se cost par maal lete hain aur client ko unke rate par dete hain — farq (margin) humara munafa. Supplier ka bypass khata pump-stock se bilkul alag hai, aur jitna maal liya usse zyada deliver nahi ho sakta. <Ur className="block">سپلائر کا بائی پاس کھاتہ پمپ اسٹاک سے الگ</Ur></p>
      </>}

      {show("kpis") && (() => {
        const m = stock.data?.month, tone = (v: number) => (v >= 0 ? "text-emerald-700" : "text-rose-700");
        const tiles: { l: string; v: string; h?: string; cls?: string }[] = [
          { l: "We owe bypass suppliers", v: pkrShort(owedTotal), cls: owedTotal > 0 ? "text-rose-700" : "" },
          { l: "Bypass stock on hand", v: pkrShort(stock.data?.total?.value ?? 0), h: stockLines.length ? stockLines.map((p) => `${num(p.litres)} L ${PRODUCTS[p.product]}`).join(" · ") : "koi stock nahi" },
          { l: "Is mahine ka munafa", v: pkrShort(m?.profit ?? 0), h: m ? `bika ${pkrShort(m.billed)} − cost ${pkrShort(m.cost)}` : "—", cls: tone(m?.profit ?? 0) },
          { l: "Pichle mahine", v: pkrShort(m?.last?.profit ?? 0), h: m?.last ? `${m.last.month} · bika ${pkrShort(m.last.billed)}` : "—", cls: tone(m?.last?.profit ?? 0) },
          { l: `${m?.year?.year ?? ""} ka munafa`, v: pkrShort(m?.year?.profit ?? 0), h: m?.year ? `bika ${pkrShort(m.year.billed)} − cost ${pkrShort(m.year.cost)}` : "—", cls: tone(m?.year?.profit ?? 0) },
        ];
        // one compact strip (the old page had five tall cards here, then every section stacked below)
        return <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">{tiles.map((t) => (
          <div key={t.l} className="rounded-xl border border-slate-200 bg-white px-3 py-2">
            <div className="truncate text-[10.5px] font-semibold uppercase tracking-wide text-slate-500" title={t.l}>{t.l}</div>
            <div className={`text-lg font-bold tabular-nums ${t.cls ?? ""}`}>{t.v}</div>
            {t.h && <div className="truncate text-[11px] text-slate-500" title={t.h}>{t.h}</div>}
          </div>
        ))}</div>;
      })()}
      {show("tank") && <LeftoverToTank stock={stockLines} onChanged={refresh} always={section === "tank"} />}

      {/* Bacha hua maal: supplier se jitna liya − client ko jitna diya = jo abhi humare paas ruka hai */}
      {show("stock") && <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 p-4">
          <h2 className="flex items-center gap-2 font-semibold"><Truck size={16} className="text-slate-500" /> Bacha hua maal (ruka hua stock) · <Ur>باقی مال</Ur></h2>
          <span className="text-sm font-semibold tabular-nums text-slate-700">{num(stock.data?.total?.litres ?? 0)} L · {pkr(stock.data?.total?.value ?? 0)}</span>
        </div>
        {(stock.data?.total?.litres ?? 0) < -0.01 && <p className="border-b bg-rose-50 px-4 py-2 text-sm text-rose-900"><b>Stock minus me hai</b> — jitna khareeda us se zyada maal nikal chuka hai (kisi delivery me khareed likhna reh gayi). <Link className="underline" to="/wholesale?tab=stock">Baqi stock tab</Link> me fuel-wise hisaab aur ghalat entries dekhein.</p>}
        {!stockLines.length ? (
          <Empty>Koi maal ruka hua nahi — supplier se jitna liya utna client ko de diya.</Empty>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead><tr><th className="th">Fuel</th><th className="th text-right">Ruke litre</th><th className="th text-right">Average cost (Rs/L)</th><th className="th text-right">Value (cost par)</th></tr></thead>
              <tbody className="tabular-nums">
                {stockLines.map((p) => (
                  <tr key={p.product} className="border-t border-slate-100">
                    <td className="td font-medium">{PRODUCTS[p.product] ?? p.product}</td>
                    <td className="td text-right font-semibold">{num(p.litres)} L</td>
                    <td className="td text-right">Rs {num(p.avg_cost, 2)}</td>
                    <td className="td text-right">{pkr(p.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="border-t border-slate-100 bg-sky-50 px-4 py-2.5 text-xs text-sky-900">
              Yeh maal supplier se liya ja chuka hai (uska bill chadh gaya) par abhi kisi client ko nahi diya — humare paas ruka hai. Jab rate upar jaye, <b>New trip → 📦 Balance stock</b> kholein — client ko us din ka rate card lagega, cost yahi purani; sirf client drop daalein — yeh isi ruke stock se chala jayega aur munafa = us din ka rate − yeh average cost. <Ur className="block mt-0.5">ریٹ بڑھنے پر خریداری خالی چھوڑ کر صرف ڈراپ کریں — یہ رُکے اسٹاک سے جائے گا</Ur>
            </p>
          </>
        )}
      </div>}

      {show("profit") && (section === "profit" ? <BypassPnl /> : <MonthlyProfitChart data={monthly.data ?? []} />)}

      {show("suppliers") && <div className="card overflow-hidden">
        <h2 className="border-b p-4 font-semibold"><Factory size={15} className="mr-1 inline text-slate-500" /> Bypass suppliers · <Ur>سپلائر</Ur></h2>
        {sups.loading ? <Loading /> : sups.error ? <ErrorBox error={sups.error} /> : !(sups.data ?? []).length ? <Empty>Koi supplier nahi.</Empty> : (
          <ul className="divide-y divide-slate-100">
            {(sups.data ?? []).map((s) => (
              <li key={s.id}><button className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-slate-50" onClick={() => setOpenSup(s.id)}>
                <div><div className="font-medium">{[s.company, s.name].filter(Boolean).join(" — ")}</div><div className="text-xs text-slate-400">{s.depot_name ?? "—"}</div></div>
                <div className={`text-right font-bold tabular-nums ${s.bypass_owed > 0 ? "text-rose-600" : s.bypass_owed < 0 ? "text-emerald-600" : "text-slate-400"}`}>{pkr(s.bypass_owed)}<div className="text-xs font-normal text-slate-400">{s.bypass_owed > 0 ? "we owe (bypass)" : s.bypass_owed < 0 ? "advance" : "clear"}</div>
                  {Math.abs(s.pump_owed ?? 0) > 0.5 && <div className="text-xs font-normal tabular-nums text-slate-500">+ pump {pkr(s.pump_owed)} = total {pkr(s.total_owed)}</div>}</div>
              </button></li>
            ))}
          </ul>
        )}
      </div>}

      {show("deliveries") && <div className="card overflow-hidden">
        <h2 className="border-b p-4 font-semibold">{section === "deliveries" ? "Bypass deliveries" : "Recent deliveries"} · <Ur>حالیہ</Ur></h2>
        <div className="px-4 pt-3"><ListTools q={dq} onQ={setDq} placeholder="Tanker / client / supplier / fuel… · تلاش" from={dRange.from} to={dRange.to} onFrom={(v) => setDRange({ ...dRange, from: v })} onTo={(v) => setDRange({ ...dRange, to: v })}
          right={delsFiltered ? <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => { setDq(""); setDRange({ from: "", to: "" }); }}>Clear</button> : null} /></div>
        {dels.loading && !dels.data ? <Loading /> : !(dels.data ?? []).length ? <Empty>{delsFiltered ? "Kuch nahi mila · کچھ نہیں ملا" : "Abhi tak koi delivery nahi."}</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-sm">
              <thead><tr><th className="th">Tareekh</th><th className="th">Delivery</th><th className="th">Tanker · driver</th><th className="th text-right">Khareeda</th><th className="th text-right">Client ko</th><th className="th text-right">Apne tank</th><th className="th text-right">Cost</th><th className="th text-right">Billed</th><th className="th text-right">Munafa</th><th className="th">Proof</th><th className="th"></th></tr></thead>
              <tbody className="tabular-nums">
                {delsPaged.slice.map((d: any) => {
                  const tankers: any[] = (() => { try { return d.tankers ? JSON.parse(d.tankers) : []; } catch { return []; } })();
                  const who = tankers.length ? tankers.map((x) => [x.vehicle_no, x.driver_name].filter(Boolean).join(" · ")).join(" + ") : [d.vehicle_no, d.driver_name].filter(Boolean).join(" · ");
                  return (
                    <tr key={d.id} className="border-t border-slate-100">
                      <td className="td whitespace-nowrap text-xs">{dt(d.txn_date)}</td>
                      <td className="td whitespace-nowrap"><button className="font-mono text-xs text-brand-700 underline" onClick={() => setVoucher(d.id)}>BYP-{d.id}</button>{d.note ? <div className="max-w-[160px] truncate text-xs text-slate-500" title={d.note}>{d.note}</div> : null}</td>
                      <td className="td text-xs">{who || "—"}</td>
                      <td className="td text-right">{d.litres ? `${num(d.litres)} L` : <span className="text-amber-700">—</span>}</td>
                      <td className="td text-right">{d.drop_litres ? `${num(d.drop_litres)} L` : ""}</td>
                      <td className="td text-right">{d.to_tank_litres ? `${num(d.to_tank_litres)} L` : ""}</td>
                      <td className="td text-right">{d.cost ? pkr(d.cost) : <span className="text-amber-700" title="Is delivery me supplier wali khareed darj nahi">cost nahi</span>}</td>
                      <td className="td text-right">{d.billed ? pkr(d.billed) : ""}</td>
                      <td className={`td text-right font-semibold ${d.margin == null ? "text-amber-700" : d.margin > 0 ? "text-emerald-700" : d.margin < 0 ? "text-rose-700" : "text-slate-500"}`}>{d.margin == null ? "—" : pkr(d.margin)}</td>
                      <td className="td"><ProofThumbs ids={d.proof_ids} onChanged={() => dels.reload()} /></td>
                      <td className="td text-right">{d.drop_litres > 0 && <button className="btn-secondary !px-2 !py-1" title="Voucher / challan" onClick={() => setVoucher(d.id)}><Printer size={14} /></button>}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot><tr className="border-t-2 bg-slate-50 font-semibold tabular-nums">
                <td className="td" colSpan={3}>Kul · {(dels.data ?? []).length} deliveries{delsFiltered ? " (filter)" : ""}</td>
                <td className="td text-right">{num((dels.data ?? []).reduce((a: number, d: any) => a + (d.litres || 0), 0))} L</td>
                <td className="td text-right">{num((dels.data ?? []).reduce((a: number, d: any) => a + (d.drop_litres || 0), 0))} L</td>
                <td className="td text-right">{num((dels.data ?? []).reduce((a: number, d: any) => a + (d.to_tank_litres || 0), 0))} L</td>
                <td className="td text-right">{pkr((dels.data ?? []).reduce((a: number, d: any) => a + (d.cost || 0), 0))}</td>
                <td className="td text-right">{pkr((dels.data ?? []).reduce((a: number, d: any) => a + (d.billed || 0), 0))}</td>
                <td className="td text-right">{pkr((dels.data ?? []).reduce((a: number, d: any) => a + (d.margin || 0), 0))}</td>
                <td className="td" colSpan={2}></td>
              </tr></tfoot>
            </table>
          </div>
        )}
        {(dels.data ?? []).length > 10 && <div className="border-t px-3 py-2"><Pager page={delsPaged.page} pages={delsPaged.pages} setPage={delsPaged.setPage} total={delsPaged.total} size={delsPaged.size} /></div>}
        {(dels.data ?? []).length >= dLimit && dLimit < 500 && <div className="p-3"><button type="button" className="btn-secondary w-full" onClick={() => setDLimit((n) => Math.min(500, n + 60))}>Show more · <Ur>مزید دکھائیں</Ur></button></div>}
      </div>}

      {openSup && <SupplierStatement id={openSup} onClose={() => setOpenSup(null)} onChanged={refresh} />}
      {voucher != null && <BypassVoucher id={voucher} onClose={() => setVoucher(null)} />}
    </div>
  );
}

/** Printable voucher + delivery challan for one bypass delivery. Each client's line shows the per-litre
 *  rate from that client's own rate card (the rate the CEO set) and the amount billed to their khata. */
export function BypassVoucher({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, error, reload } = useApi<any>(`/bypass/deliveries/${id}`);
  const { can } = useAuth();
  const voidDrop = async (x: any) => {
    const a = await askCancel({ title: "Bypass drop mansookh karein", what: <><b>{x.client_name}</b> · {num(x.litres, 0)} L</>, hint: "Litre wapas bypass stock me chale jayenge aur client ka bill cancel ho jayega." });
    if (!a) return;
    try { await api(`/bypass/drops/${x.id}/void`, { body: { reason: a.reason }, headers: pinHeader(a) }); reload(); } catch (e: any) { alert(e.message); }
  };
  const vehicle = data
    ? (data.tankers?.length ? data.tankers : [{ tanker_no: data.vehicle_no, driver_name: data.driver_name }])
        .map((tk: any) => [tk.tanker_no ? `🚛 ${tk.tanker_no}` : "", tk.driver_name ? `👤 ${tk.driver_name}` : ""].filter(Boolean).join(" ")).filter(Boolean).join(" · ") || "—"
    : "—";
  return (
    <Modal open onClose={onClose} title={`Bypass delivery #${id} · voucher`} wide>
      {error ? (
        <div className="space-y-3 py-4 text-center text-sm"><p className="text-red-600">Could not open this delivery: {error}</p><button className="btn-secondary" onClick={reload}>Try again</button></div>
      ) : !data ? <Loading /> : (
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div><b>{dt(data.trip_date)}</b> · 🏭 depot se seedha client ko{data.supplier_name ? <> · from <b>{data.supplier_name}</b></> : ""}{data.depot_ref ? ` (${data.depot_ref})` : ""} · {data.station_name}'s books</div>
            <div>{vehicle}</div>
          </div>

          {/* phone: one card per drop */}
          <ul className="divide-y divide-slate-100 rounded-lg ring-1 ring-slate-200 sm:hidden print:hidden">
            {data.drops.map((x: any, i: number) => (
              <li key={x.id} className={`space-y-0.5 p-3 ${x.voided ? "text-slate-400 line-through print:hidden" : ""}`}>
                <div className="flex justify-between gap-2"><b className="min-w-0">{i + 1}. {x.client_name}</b><b className="shrink-0 tabular-nums">{pkr(x.amount)}</b></div>
                <div className="flex justify-between gap-2 text-xs text-slate-600"><span>{PRODUCTS[x.product]} · {num(x.litres, 2)} L × Rs {x.rate}/L</span><span className="shrink-0">{x.ref ?? ""}</span></div>
                {x.balance != null && <div className="text-xs text-slate-500">Khata balance ab: {pkr(x.balance)}</div>}
                {!x.voided && <button className="mt-1 inline-flex min-h-9 items-center gap-1 text-xs font-medium text-brand-700 underline" onClick={() => printPages(`Challan ${x.client_name}`, challanPages(data, x.id), data.business?.color)}><Printer size={13} /> Client voucher</button>}
                {!x.voided && can("wholesale.void") && <button className="ml-3 mt-1 inline-flex min-h-9 items-center text-xs font-medium text-rose-600 underline" onClick={() => voidDrop(x)}>Mansookh · منسوخ</button>}
              </li>
            ))}
            <li className="flex justify-between p-3 font-semibold"><span>Total ({data.drops.filter((x: any) => !x.voided).length} drops)</span><span className="text-right tabular-nums">{num(data.delivered_l, 2)} L<span className="block">{pkr(data.billed)}</span></span></li>
          </ul>

          {/* desktop / print: full table */}
          <div className="hidden overflow-x-auto sm:block print:block"><table className="w-full min-w-[640px]">
            <thead><tr><th className="th">#</th><th className="th">Client</th><th className="th">Fuel</th><th className="th text-right">Litres</th><th className="th text-right">Rate (Rs/L)</th><th className="th text-right">Amount</th><th className="th text-right">Khata balance</th><th className="th print:hidden"></th></tr></thead>
            <tbody>{data.drops.map((x: any, i: number) => (
              <tr key={x.id} className={x.voided ? "text-slate-400 line-through" : ""}>
                <td className="td">{i + 1}</td><td className="td">{x.client_name}{x.phone ? <div className="text-xs text-slate-500">{phone(x.phone)}</div> : null}</td>
                <td className="td">{PRODUCTS[x.product]}</td><td className="td text-right tabular-nums">{num(x.litres, 2)}</td><td className="td text-right tabular-nums font-medium">{x.rate}</td>
                <td className="td text-right tabular-nums">{pkr(x.amount)}</td><td className="td text-right tabular-nums text-slate-500">{x.balance != null ? pkr(x.balance) : "—"}</td>
                <td className="td print:hidden whitespace-nowrap">{!x.voided && <button className="text-brand-700 underline" title="Print this client's voucher" onClick={() => printPages(`Challan ${x.client_name}`, challanPages(data, x.id), data.business?.color)}>voucher</button>}
                  {!x.voided && can("wholesale.void") && <button className="ml-2 text-rose-600 underline" title="Void this drop (stock back, client bill cancelled)" onClick={() => voidDrop(x)}>mansookh</button>}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr className="font-semibold"><td className="td" colSpan={3}>Total ({data.drops.filter((x: any) => !x.voided).length} drops)</td><td className="td text-right tabular-nums">{num(data.delivered_l, 2)} L</td><td className="td" /><td className="td text-right tabular-nums">{pkr(data.billed)}</td><td className="td" colSpan={2} /></tr></tfoot>
          </table></div>

          <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900">Har client ka rate uske apne rate card (jo CEO ne set kiya) se liya gaya hai — litre × rate = amount, aur yeh us client ke khata me chadh gaya. <Ur className="block">ہر کلائنٹ کا اپنا ریٹ · CEO کا مقرر کردہ</Ur></p>
          {data.note && <p className="text-slate-600">Note: {data.note}</p>}
          {data.proof_ids && <div className="flex items-center gap-2 text-slate-600">Photos: <ProofThumbs ids={data.proof_ids} /></div>}

          <div className="flex flex-wrap justify-end gap-2 print:hidden">
            <VoucherVoidButton kind="bypass" id={data.id} voided={!!data.voided} onDone={() => { reload(); onClose(); }} />
            <button className="btn-secondary" onClick={() => printPages(`Bypass ${data.id} sheet`, tripSheetPage(data), data.business?.color)}><Printer size={15} /> Delivery sheet (driver)</button>
            <button className="btn-primary" disabled={!data.drops.some((x: any) => !x.voided)} onClick={() => printPages(`Bypass ${data.id} vouchers`, challanPages(data), data.business?.color)}><Printer size={15} /> Print client vouchers · چالان</button>
          </div>
          <p className="text-xs text-slate-500 print:hidden">Client voucher: har client ke liye ek page — upar wali copy client rakhta hai, neeche wali signed wapas aati hai. Humari cost aur munafa client ko kabhi print nahi hota.</p>
        </div>
      )}
    </Modal>
  );
}

/** Monthly bypass munafa — a small bar chart (green = faida, red = nuqsan) over the last few months. */
export function MonthlyProfitChart({ data }: { data: any[] }) {
  if (!data.length || data.every((d) => !d.profit && !d.billed)) return null;
  const GRID = "#e5e7eb", AXIS = "#6b7280";
  const label = (ym: string) => { const [, m] = (ym ?? "").split("-"); return ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m)] ?? ym; };
  return (
    <div className="card p-4">
      <h2 className="font-semibold">Mahine ka munafa · <Ur>ماہانہ منافع</Ur></h2>
      <p className="mb-2 text-xs text-slate-500">Client se mila − delivered cost, har mahine</p>
      <div className="h-56"><ResponsiveContainer>
        <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="month" tickFormatter={label} tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRID }} />
          <YAxis tickFormatter={(v) => (Math.abs(v) >= 100_000 ? `${Math.round(v / 100_000)}L` : Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : v)} tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={false} width={44} />
          <Tooltip cursor={{ fill: "rgba(15,23,42,.05)" }} formatter={(v: number) => [pkr(v), "Munafa"]} labelFormatter={(ym) => label(ym) + " " + String(ym).slice(0, 4)} />
          <Bar dataKey="profit" radius={[4, 4, 0, 0]} maxBarSize={40}>
            {data.map((d, i) => <Cell key={i} fill={d.profit >= 0 ? "#1baf7a" : "#e11d48"} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer></div>
    </div>
  );
}

/** The bypass delivery form body (no Modal wrapper) — shown inside the "New trip" form's Depot-bypass mode. */
/** `preset`: deliver one held lot (Baqi stock → "Client ko dein"): its fuel, litres and tanker filled in. */
export function BypassDeliveryForm({ onClose, onDone, fromHeld = false, fromClient = false, preset }: { onClose: () => void; onDone: (r?: any) => void; fromHeld?: boolean; fromClient?: boolean; preset?: { product: string; litres: number; vehicle_no?: string | null } }) {
  const { can } = useAuth();
  const suppliers = useApi<any[]>("/bypass/suppliers");
  const clients = useApi<any[]>("/wholesale/clients");
  const stations = useApi<any[]>("/stations");
  const orders = useApi<any>("/wholesale/orders");
  const [station, setStation] = useState("");
  const [txnDate, setTxnDate] = useState(() => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10));
  const [fleets, setFleets] = useState<any[]>([{ tanker_id: preset?.vehicle_no ? "other" : "", driver_id: "", vehicle_no: preset?.vehicle_no ?? "" }]);
  // a preset tanker number: pick the registered tanker (and its driver) when there is one, else keep it typed
  const fleetApi = useApi<any>("/wholesale/fleet");
  useEffect(() => {
    const tk = (fleetApi.data?.tankers ?? []).find((x: any) => String(x.number).replace(/\s/g, "").toLowerCase() === String(preset?.vehicle_no ?? "").replace(/\s/g, "").toLowerCase());
    if (tk) setFleets((fs) => [{ ...fs[0], tanker_id: String(tk.id), vehicle_no: "", driver_id: tk.driver_id ? String(tk.driver_id) : fs[0].driver_id }, ...fs.slice(1)]);
  }, [fleetApi.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [note, setNote] = useState("");
  const [buys, setBuys] = useState([{ supplier_id: "", product: "HSD", litres: "", amount: "" }]);
  const [drops, setDrops] = useState<any[]>([{ client_id: "", product: preset?.product ?? "HSD", litres: preset ? String(preset.litres) : "", amount: "", order_id: undefined, location: "" }]);
  const [photos, setPhotos] = useState<number[]>([]);
  const { busy, run } = useAction();
  const stock = useApi<any>("/bypass/stock");
  const lotsApi = useApi<any>("/bypass/lots"); // open lots with the tanker they sit on (same-voucher first, then FIFO)
  const held = (p: string) => (stock.data?.by_product ?? []).find((x: any) => x.product === p)?.litres ?? 0;
  const heldAvg = (p: string) => Number((stock.data?.by_product ?? []).find((x: any) => x.product === p)?.avg_cost ?? 0);
  // tanks across all stations, for the "unload into our own tank" rows
  const stTanks = useMemo(() => (stations.data ?? []).flatMap((s: any) => (s.tanks ?? []).map((tk: any) => ({ ...tk, station: s.name }))), [stations.data]);
  const [toTank, setToTank] = useState<any[]>([]);
  const [lotVoucher, setLotVoucher] = useState<number | null>(null); // BYP voucher opened from the balance-stock lot table
  // a lot button in the balance-stock table: fill a drop / own-tank line with that lot's fuel + litres, and put its tanker
  // on the trip (when none is chosen yet) so the server draws from THAT gaari's lot at its own rate
  const pickLot = (l: any, mode: "client" | "tank") => {
    const veh = l.vehicles?.[0] ?? l.vehicle_no ?? null;
    if (veh) setFleets((fs) => {
      if (fs[0].tanker_id && fs[0].tanker_id !== "other" || fs[0].vehicle_no) return fs;
      const tk = (fleetApi.data?.tankers ?? []).find((x: any) => String(x.number).replace(/\s/g, "").toLowerCase() === String(veh).replace(/\s/g, "").toLowerCase());
      return [tk ? { ...fs[0], tanker_id: String(tk.id), vehicle_no: "", driver_id: tk.driver_id ? String(tk.driver_id) : fs[0].driver_id } : { ...fs[0], tanker_id: "other", vehicle_no: String(veh) }, ...fs.slice(1)];
    });
    const litres = String(Math.round(Number(l.left) * 100) / 100);
    if (mode === "client") setDrops((ds) => { const i = ds.findIndex((d) => !d.client_id && !Number(d.litres)); const row = { client_id: "", product: l.product, litres, amount: "", order_id: undefined, location: "" }; return i >= 0 ? ds.map((d, j) => j === i ? row : d) : [...ds, row]; });
    else setToTank((ts) => [...ts, { product: l.product, litres, tank_id: "" }]);
    setTimeout(() => document.getElementById(mode === "client" ? "byp-drops" : "byp-totank")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };

  const sumBy = (rows: { product: string; litres: string }[]) => rows.reduce((m, r) => { const p = r.product; m[p] = (m[p] ?? 0) + (Number(r.litres) || 0); return m; }, {} as Record<string, number>);
  const bought = useMemo(() => sumBy(buys), [buys]);
  const dropped = useMemo(() => sumBy(drops), [drops]);
  const toTankSum = useMemo(() => sumBy(toTank), [toTank]);
  // a drop can draw from the stock already held plus what is being bought right now
  const needBy = useMemo(() => { const m: Record<string, number> = { ...dropped }; for (const [p, l] of Object.entries(toTankSum)) m[p] = (m[p] ?? 0) + l; return m; }, [dropped, toTankSum]);
  const overBy = useMemo(() => Object.entries(needBy).filter(([p, l]) => l > held(p) + (bought[p] ?? 0) + 0.01).map(([p, l]) => ({ p, l, have: held(p) + (bought[p] ?? 0) })), [needBy, bought, stock.data]);
  // the client's price comes from their own rate card (CRM): drop amount = litres × card rate
  const clientById = (id: string) => (clients.data ?? []).find((c: any) => String(c.id) === String(id));
  const clientRate = (d: any) => Number(clientById(d.client_id)?.rates?.[d.product] ?? 0);
  const dropLineAmt = (d: any) => Math.round(Number(d.litres || 0) * clientRate(d) * 100) / 100;
  const buyAmt = buys.reduce((a, b) => a + (Number(b.amount) || 0), 0);
  const dropAmt = drops.reduce((a, d) => a + dropLineAmt(d), 0);
  // Same-voucher costing (mirrors the server): each out-line is costed first from the fuel bought on THIS voucher at the
  // bill's own rate, and only litres beyond that from the held stock at its average. Blending today's bill with old held
  // stock showed a false munafa.
  const buyValBy = useMemo(() => buys.reduce((m: Record<string, number>, b) => { m[b.product] = (m[b.product] ?? 0) + (Number(b.amount) || 0); return m; }, {}), [buys]);
  const lineCosts = useMemo(() => {
    const left: Record<string, number> = { ...bought };
    const ownRate = (p: string) => (bought[p] ?? 0) > 0 ? (buyValBy[p] ?? 0) / bought[p] : 0;
    const take = (p: string, L: number) => { const own = Math.min(L, left[p] ?? 0); left[p] = (left[p] ?? 0) - own; return own * ownRate(p) + (L - own) * heldAvg(p); };
    return { drops: drops.map((d) => take(d.product, Number(d.litres) || 0)), tank: toTank.map((r) => take(r.product, Number(r.litres) || 0)) };
  }, [drops, toTank, bought, buyValBy, stock.data]);
  const toTankL = toTank.reduce((a, r) => a + (Number(r.litres) || 0), 0);
  // value of fuel put into our own tank: a typed amount wins, else its same-voucher cost
  const toTankCost = toTank.reduce((a, r, i) => a + (Number(r.amount) > 0 ? Number(r.amount) : lineCosts.tank[i]), 0);
  // client profit = what the clients pay − cost of ONLY the litres dropped to clients (own-tank fuel is stock, not a loss)
  const clientCost = lineCosts.drops.reduce((a, c) => a + c, 0);
  const clientProfit = Math.round((dropAmt - clientCost) * 100) / 100;
  const validBuys = buys.filter((b) => b.supplier_id && Number(b.litres) > 0 && Number(b.amount) > 0);
  const validDrops = drops.filter((d) => d.client_id && d.client_id !== "__new__" && Number(d.litres) > 0 && clientRate(d) > 0);
  // a chosen client+product with litres but no rate card set yet
  const noRate = drops.filter((d) => d.client_id && d.client_id !== "__new__" && Number(d.litres) > 0 && clientRate(d) <= 0);
  const tankOf = (id: any) => stTanks.find((tk: any) => String(tk.id) === String(id));
  const validToTank = toTank.filter((r) => r.tank_id && Number(r.litres) > 0 && tankOf(r.tank_id)?.product === r.product);
  const badTank = toTank.filter((r) => r.tank_id && Number(r.litres) > 0 && tankOf(r.tank_id) && tankOf(r.tank_id).product !== r.product);
  const valid = !!station && (validBuys.length > 0 || validDrops.length > 0 || validToTank.length > 0) && overBy.length === 0 && noRate.length === 0 && badTank.length === 0;

  return (
    <>
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault();
        const body = {
          station_id: Number(station), ...fleetBody(fleets[0]), tankers: fleets.filter((f) => f.tanker_id || f.vehicle_no).map(fleetBody), note: note || null, photo_ids: photos, txn_date: txnDate,
          purchases: validBuys.map((b) => ({ ...(fromClient ? { client_id: Number(b.supplier_id) } : { supplier_id: Number(b.supplier_id) }), product: b.product, litres: Number(b.litres), amount: Number(b.amount) })),
          drops: validDrops.map((d) => ({ client_id: Number(d.client_id), product: d.product, litres: Number(d.litres), order_id: d.order_id ?? null, location: d.location || null })),
          to_tank: validToTank.map((r) => ({ tank_id: Number(r.tank_id), product: r.product, litres: Number(r.litres), ...(Number(r.amount) > 0 ? { amount: Number(r.amount) } : {}), note: null })),
        };
        const saved = await run(() => api("/bypass/deliveries", { body }), (r: any) => `Delivery #${r.id} saved. Bought ${pkr(r.bought)}, billed ${pkr(r.billed)}, munafa ${pkr(r.margin)}${r.to_tank_litres ? `, apne tank ${num(r.to_tank_litres)} L` : ""}`);
        if (saved) onDone(saved);
      }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tareekh · تاریخ"><input className="input" type="date" value={txnDate} max={new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10)} onChange={(e) => setTxnDate(e.target.value)} /></Field>
          <Field label="Station (books under) *"><select className="input" required value={station} onChange={(e) => setStation(e.target.value)}>
            <option value="">— choose —</option>{(stations.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        </div>

        {/* Balance stock: what is held from earlier depot purchases — delivered today at each client's rate card of today */}
        {(fromHeld || (stock.data?.by_product ?? []).some((x: any) => x.litres > 0.01)) && (
          <div className={`rounded-xl p-3 ring-1 ${fromHeld ? "bg-amber-50 ring-amber-200" : "bg-slate-50 ring-slate-200"}`}>
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-sm font-semibold">📦 Balance stock (pehle ka khareeda, abhi humare paas) · <Ur>باقی اسٹاک</Ur></div>
              {fromHeld && <span className="text-xs text-amber-800">Client ko <b>aaj ka rate card</b> lagega; cost purane bill ki — farq munafa.</span>}
            </div>
            {!(stock.data?.by_product ?? []).some((x: any) => x.litres > 0.01) ? <p className="text-xs text-slate-500">Abhi koi balance stock nahi — Depot direct tab se zyada khareed kar kam dein to baqi yahan aata hai.</p> : (() => {
              // one row per open lot: which tanker it is sitting on, from whom, since when, how much is left and at what cost
              const fuels: any[] = lotsApi.data?.fuels ?? [];
              const rows = fuels.flatMap((f) => (f.lots ?? []).map((l: any) => ({ ...l, product: f.product })));
              const totalL = rows.reduce((a, l) => a + l.left, 0), totalV = rows.reduce((a, l) => a + l.value_left, 0);
              return (
                <div className="overflow-x-auto rounded-lg bg-white ring-1 ring-slate-200">
                  <table className="w-full min-w-[760px] text-[11px] [&_.td]:!px-2 [&_.td]:!py-1.5 [&_.th]:!px-2 [&_.th]:!py-1.5">
                    <thead><tr>{can("wholesale.manage") && <th className="th">Karein</th>}<th className="th">Fuel</th><th className="th">Gaari</th><th className="th">Supplier</th><th className="th">Tareekh</th><th className="th">Bill</th><th className="th text-right">Baqi</th><th className="th text-right">Rs/L</th><th className="th text-right">Value</th><th className="th text-right">Din</th></tr></thead>
                    <tbody>
                      {rows.map((l) => (
                        <tr key={l.id}>
                          {can("wholesale.manage") && <td className="td"><div className="flex flex-col gap-1">
                            <button type="button" className="btn-primary min-h-9 whitespace-nowrap !px-2 !py-1 text-[11px]" title="Is lot ka maal client ko dein" onClick={() => pickLot(l, "client")}><Truck size={13} /> Client ko dein</button>
                            <button type="button" className="btn-secondary min-h-9 whitespace-nowrap !px-2 !py-1 text-[11px]" title="Is lot ka maal apne pump ke tank mein" onClick={() => pickLot(l, "tank")}><Fuel size={13} /> Apne tank mein</button>
                          </div></td>}
                          <td className="td font-semibold">{PRODUCTS[l.product] ?? l.product}</td>
                          <td className="td whitespace-nowrap">{l.vehicle_no ? <>🚛 <b>{l.vehicle_no}</b></> : <span className="text-slate-400">—</span>}{l.driver_name ? <span className="block text-[10px] text-slate-500">{l.driver_name}</span> : null}</td>
                          <td className="td">{l.supplier}</td>
                          <td className="td whitespace-nowrap">{String(l.txn_date).slice(0, 10)}</td>
                          <td className="td whitespace-nowrap">{l.delivery_id ? <button type="button" className="font-mono text-brand-700 underline" title="Bill / voucher kholein" onClick={() => setLotVoucher(l.delivery_id)}>BYP-{l.delivery_id}</button> : ""}{l.ref ? <span className="text-slate-500"> · {l.ref}</span> : ""}</td>
                          <td className="td whitespace-nowrap text-right tabular-nums font-semibold">{num(l.left)} L<span className="block text-[10px] font-normal text-slate-400">/ {num(l.litres)}</span></td>
                          <td className="td text-right tabular-nums">{num(l.cost_rate, 2)}</td>
                          <td className="td text-right tabular-nums">{pkr(l.value_left)}</td>
                          <td className="td text-right tabular-nums">{l.days}</td>
                        </tr>
                      ))}
                      {!rows.length && <tr><td className="td text-slate-500" colSpan={can("wholesale.manage") ? 10 : 9}>{lotsApi.data ? "Koi khula lot nahi" : "…"}</td></tr>}
                    </tbody>
                    {rows.length > 0 && <tfoot><tr><td className="td" colSpan={can("wholesale.manage") ? 6 : 5}>Kul baqi · {rows.length} lot{fuels.filter((f) => f.balance > 0.01).map((f) => ` · ${PRODUCTS[f.product] ?? f.product} ${num(f.balance)} L`).join("")}</td><td className="td text-right tabular-nums">{num(totalL)} L</td><td className="td"></td><td className="td text-right tabular-nums">{pkr(totalV)}</td><td className="td"></td></tr></tfoot>}
                  </table>
                </div>
              );
            })()}
          </div>
        )}

        {/* Tanker(s) + driver(s) — 2 jagah se maal to 2 tanker, har ek ka apna driver */}
        <div className="rounded-xl bg-slate-50 p-3">
          <div className="mb-2 text-sm font-semibold">Tanker &amp; driver <span className="font-normal text-slate-400">— 2 jagah se maal to har tanker add karein</span> · <Ur>ٹینکر و ڈرائیور</Ur></div>
          <div className="space-y-3">
            {fleets.map((f, i) => (
              <div key={i} className="rounded-lg border border-slate-200 bg-white p-2">
                <div className="grid gap-3 sm:grid-cols-2"><FleetPicker f={f} setF={(nf: any) => setFleets(fleets.map((x, j) => j === i ? nf : x))} /></div>
                {fleets.length > 1 && <button type="button" className="mt-1 text-xs text-red-600" onClick={() => setFleets(fleets.filter((_, j) => j !== i))}>Remove tanker</button>}
              </div>
            ))}
          </div>
          <button type="button" className="mt-2 inline-flex items-center gap-1 rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-100 active:scale-95" onClick={() => setFleets([...fleets, { tanker_id: "", driver_id: "", vehicle_no: "" }])}><Plus size={14} /> Add tanker</button>
        </div>

        {!fromHeld && <>
        {/* Supplier purchase lines — supplier + litre + full amount */}
        <div className="rounded-xl bg-slate-50 p-3">
          {fromClient ? <>
            <div className="mb-1 text-sm font-semibold">🤝 Kis client se maal liya (client + litre + amount) · <Ur>کلائنٹ سے خریداری</Ur></div>
            <p className="mb-2 text-xs text-slate-500">Is maal ki qeemat us client ke khate se <b>minus</b> ho jayegi (agar woh humein kam deta hai to uska khata credit me chala jayega). Maal neeche wale clients ko jata hai ya apne tank me — baqi balance stock me rehta hai.</p>
          </> : <div className="mb-2 text-sm font-semibold">Maal kahan se liya (supplier + litre + amount) <span className="font-normal text-slate-400">— optional, sirf stock se bechna hai to khaali</span> · <Ur>خریداری</Ur></div>}
          <div className="space-y-2">
            {buys.map((b, i) => (
              <div key={i} className="grid grid-cols-12 gap-2">
                <div className="col-span-5">
                  {fromClient ? <select className="input w-full" aria-label="Client jis se maal liya" value={b.supplier_id} onChange={(e) => setBuys(buys.map((x, j) => j === i ? { ...x, supplier_id: e.target.value } : x))}>
                    <option value="">— client —</option>{(clients.data ?? []).filter((c: any) => c.active).map((c: any) => <option key={c.id} value={c.id}>{c.name}{c.city ? ` · ${c.city}` : ""}</option>)}</select>
                  : <select className="input w-full" value={b.supplier_id} onChange={(e) => setBuys(buys.map((x, j) => j === i ? { ...x, supplier_id: e.target.value } : x))}>
                    <option value="">— supplier —</option>{supplierOpts(suppliers.data ?? [])}{can("suppliers.manage") && <option value="__new__">+ Naya supplier add karein</option>}</select>}
                  {b.supplier_id === "__new__" && <QuickAdd placeholder="Supplier ka naam" onCancel={() => setBuys(buys.map((x, j) => j === i ? { ...x, supplier_id: "" } : x))}
                    onAdd={async (name) => { const s = await api("/suppliers", { body: { name } }); await suppliers.reload(); setBuys(buys.map((x, j) => j === i ? { ...x, supplier_id: String(s.id) } : x)); }} />}
                </div>
                <select className="input col-span-3" value={b.product} onChange={(e) => setBuys(buys.map((x, j) => j === i ? { ...x, product: e.target.value } : x))}>{activeProducts.map((pr) => <option key={pr.code} value={pr.code}>{pr.name}</option>)}</select>
                <input className="input col-span-2" type="number" inputMode="decimal" min={0} step="0.01" placeholder="litre" value={b.litres} onChange={(e) => setBuys(buys.map((x, j) => j === i ? { ...x, litres: e.target.value } : x))} />
                <input className="input col-span-2" type="number" inputMode="decimal" min={0} placeholder="Rs amount" value={b.amount} onChange={(e) => setBuys(buys.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} />
                {buys.length > 1 && <button type="button" className="col-span-12 -mt-1 text-right text-xs text-red-600" onClick={() => setBuys(buys.filter((_, j) => j !== i))}>Remove line</button>}
              </div>
            ))}
          </div>
          <button type="button" className="mt-2 inline-flex items-center gap-1 rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-100 active:scale-95" onClick={() => setBuys([...buys, { supplier_id: "", product: "HSD", litres: "", amount: "" }])}><Plus size={14} /> {fromClient ? "Add client" : "Add supplier"}</button>
          <div className="mt-1 text-xs text-slate-500">Khareeda: {Object.entries(bought).map(([p, l]) => `${num(l)} L ${PRODUCTS[p]}`).join(" · ") || "—"} · {fromClient ? "Client ke khate se minus" : "Supplier ko dene hain"} {pkr(buyAmt)}</div>
        </div>

        </>}
        {/* Booked orders — one tap adds the order as a drop (same as a pump trip) */}
        {(() => {
          const avail = (orders.data?.open ?? []).filter((o: any) => PRODUCTS[o.product] && !drops.some((x) => x.order_id === o.id));
          if (!avail.length) return null;
          return (
            <div className="rounded-lg bg-amber-50 p-3 ring-1 ring-amber-200">
              <div className="mb-2 text-sm font-semibold text-amber-900">📋 Booked orders — tap to add as a drop</div>
              <div className="flex flex-wrap gap-2">{avail.map((o: any) => (
                <button type="button" key={o.id} className={`rounded-lg bg-white px-3 py-1.5 text-left text-sm ring-1 ${o.late ? "ring-red-300" : o.today ? "ring-amber-400" : "ring-slate-200"} hover:bg-amber-100`}
                  onClick={() => {
                    const d = { client_id: String(o.client_id), product: o.product, litres: String(o.litres), amount: "", order_id: o.id, location: o.location ?? "" };
                    const free = drops.findIndex((x) => !x.client_id && !x.litres && !x.amount);
                    setDrops(free >= 0 ? drops.map((x, j) => (j === free ? d : x)) : [...drops, d]);
                  }}>
                  <b>{o.client_name}</b> · {PRODUCTS[o.product]} {num(o.litres)} L<span className="block text-xs text-slate-500">{o.late ? "late · " : o.today ? "today · " : ""}{o.needed_on}{o.location ? ` · ${o.location}` : ""}</span>
                </button>))}</div>
            </div>
          );
        })()}

        {/* Client drops — client + litre + full amount client pays */}
        <div id="byp-drops" className="rounded-xl bg-slate-50 p-3">
          <div className="mb-2 text-sm font-semibold">Kahan drop kiya (client + litre) <span className="font-normal text-slate-400">— rate client ke apne card se, amount khud ban jaega</span> · <Ur>ڈراپ</Ur></div>
          <div className="space-y-2">
            {drops.map((d, i) => {
              const rate = clientRate(d);
              const lineAmt = dropLineAmt(d);
              return (
              <div key={i} className="grid grid-cols-12 gap-2">
                <div className="col-span-5">
                  <select className="input w-full" value={d.client_id} onChange={(e) => setDrops(drops.map((x, j) => j === i ? { ...x, client_id: e.target.value } : x))}>
                    <option value="">— client —</option>{(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}{can("wholesale.manage") && <option value="__new__">+ Naya client add karein</option>}</select>
                  {d.client_id === "__new__" && <QuickAdd placeholder="Client ka naam" onCancel={() => setDrops(drops.map((x, j) => j === i ? { ...x, client_id: "" } : x))}
                    onAdd={async (name) => { const c = await api("/wholesale/clients", { body: { name } }); await clients.reload(); setDrops(drops.map((x, j) => j === i ? { ...x, client_id: String(c.id) } : x)); }} />}
                </div>
                <select className="input col-span-3" value={d.product} onChange={(e) => setDrops(drops.map((x, j) => j === i ? { ...x, product: e.target.value } : x))}>{activeProducts.map((pr) => <option key={pr.code} value={pr.code}>{pr.name}</option>)}</select>
                <input className="input col-span-2" type="number" inputMode="decimal" min={0} step="0.01" placeholder="litre" value={d.litres} onChange={(e) => setDrops(drops.map((x, j) => j === i ? { ...x, litres: e.target.value } : x))} />
                <div className="col-span-2 flex items-center justify-end rounded-lg bg-white px-2 text-right text-sm tabular-nums ring-1 ring-slate-200" title={rate > 0 ? `Rate Rs ${rate}/L (card)` : "Rate card nahi"}>
                  {d.client_id && d.client_id !== "__new__" ? (rate > 0 ? pkr(lineAmt) : <span className="text-rose-600">rate?</span>) : <span className="text-slate-400">Rs</span>}
                </div>
                <div className="col-span-12 -mt-1 flex items-center justify-between">
                  <span className="text-xs text-slate-500">{d.order_id ? "📋 booked order · " : ""}{rate > 0 ? `Rate Rs ${rate}/L (card)` : d.client_id && d.client_id !== "__new__" ? <span className="text-rose-600">Is client ka {PRODUCTS[d.product]} rate card nahi — pehle rate set karein</span> : ""}</span>
                  {drops.length > 1 && <button type="button" className="text-xs text-red-600" onClick={() => setDrops(drops.filter((_, j) => j !== i))}>Remove drop</button>}
                </div>
              </div>
            );})}
          </div>
          <button type="button" className="mt-2 inline-flex items-center gap-1 rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-100 active:scale-95" onClick={() => setDrops([...drops, { client_id: "", product: "HSD", litres: "", amount: "", order_id: undefined, location: "" }])}><Plus size={14} /> Add drop</button>
          <div className="mt-1 text-xs text-slate-500">Diya: {Object.entries(dropped).map(([p, l]) => `${num(l)} L ${PRODUCTS[p]}`).join(" · ") || "—"} · Client se lene hain {pkr(dropAmt)}{Object.keys({ ...dropped }).map((p) => held(p) > 0 ? ` · ${PRODUCTS[p]} held stock ${num(held(p))} L` : "").join("")}</div>
          {validDrops.length > 0 && <ul className="mt-1 space-y-0.5 text-xs">{validDrops.map((d, i) => { const L = Number(d.litres) || 0; const c = L > 0 ? lineCosts.drops[drops.indexOf(d)] / L : 0; const m = (clientRate(d) - c) * L; return (
            <li key={i} className="flex justify-between gap-2"><span className="truncate">{clientById(d.client_id)?.name} · {num(Number(d.litres))} L × <b>Rs {num(clientRate(d), 2)}</b> (aaj ka rate card){c > 0 && <span className="text-slate-400"> · cost Rs {num(c, 2)}/L</span>}</span>
              <span className="shrink-0 tabular-nums">{pkr(dropLineAmt(d))}{c > 0 && <span className={m >= 0 ? "text-emerald-700" : "text-rose-600"}> · munafa {pkr(m)}</span>}</span></li>); })}</ul>}
          {(() => { const left = Object.fromEntries([...new Set([...Object.keys(bought), ...Object.keys(dropped), ...(stock.data?.by_product ?? []).map((x: any) => x.product)])]
              .map((p) => [p, Math.round((held(p) + (bought[p] ?? 0) - (dropped[p] ?? 0) - (toTankSum[p] ?? 0)) * 100) / 100]).filter(([, l]) => (l as number) > 0.01));
            return Object.keys(left).length ? <div className="mt-1 rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-900">📦 Baqi rahega (balance stock me): {Object.entries(left).map(([p, l]) => `${num(l as number)} L ${PRODUCTS[p]}`).join(" · ")} — baad me kisi bhi din, us din ke rate par.</div> : null; })()}
          <p className="mt-1 text-xs text-slate-400">Client ka rate uske apne rate card (CRM) se uthta hai — litre × rate = amount. Rate badalna ho to client ke rate card me badlein. Jitna khareeda + held stock se zyada drop nahi ho sakta.</p>
        </div>

        {/* Unload part of the load into OUR own pump tank (not sold to a client) */}
        <div id="byp-totank" className="rounded-xl bg-sky-50 p-3 ring-1 ring-sky-100">
          <div className="mb-1 text-sm font-semibold">Apne pump ke tank mein (optional) <span className="font-normal text-slate-400">— jo maal client ko nahi diya, apne tank mein khali kiya</span> · <Ur>اپنے ٹینک میں</Ur></div>
          <div className="space-y-2">
            {toTank.map((r, i) => { const tk = tankOf(r.tank_id); const bad = r.tank_id && tk && tk.product !== r.product; return (
              <div key={i} className="grid grid-cols-12 gap-2">
                <select className="input col-span-3" value={r.product} onChange={(e) => setToTank(toTank.map((x, j) => j === i ? { ...x, product: e.target.value, tank_id: "" } : x))}>{activeProducts.map((pr) => <option key={pr.code} value={pr.code}>{pr.name}</option>)}</select>
                <select className="input col-span-5" value={r.tank_id} onChange={(e) => setToTank(toTank.map((x, j) => j === i ? { ...x, tank_id: e.target.value } : x))}>
                  <option value="">— apna tank —</option>{stTanks.filter((tk: any) => tk.product === r.product).map((tk: any) => <option key={tk.id} value={tk.id}>{tk.name} · {tk.station} ({num(tk.current_l)}/{num(tk.capacity_l)} L)</option>)}</select>
                <input className="input col-span-2" type="number" inputMode="decimal" min={0} step="0.01" placeholder="litre" value={r.litres} onChange={(e) => setToTank(toTank.map((x, j) => j === i ? { ...x, litres: e.target.value } : x))} />
                <input className="input col-span-2" type="number" inputMode="numeric" min={0} step="0.01" placeholder="Rs amount" value={r.amount ?? ""} onChange={(e) => setToTank(toTank.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} />
                <div className="col-span-12 -mt-1 flex items-center justify-between">
                  <span className="text-xs text-slate-500">{bad ? <span className="text-rose-600">Yeh {PRODUCTS[r.product]} tank nahi</span>
                    : Number(r.amount) > 0 && Number(r.litres) > 0 ? `Rs ${num(Math.round((Number(r.amount) / Number(r.litres)) * 100) / 100, 2)}/L — ye stock hai, loss nahi`
                    : Number(r.litres) > 0 && lineCosts.tank[i] > 0 ? `Amount khali chhoden to cost Rs ${num(Math.round((lineCosts.tank[i] / Number(r.litres)) * 100) / 100, 2)}/L lagegi — ye stock hai, loss nahi` : ""}</span>
                  <button type="button" className="text-xs text-red-600" onClick={() => setToTank(toTank.filter((_, j) => j !== i))}>Remove</button>
                </div>
              </div>
            ); })}
          </div>
          <button type="button" className="mt-2 inline-flex items-center gap-1 rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-100 active:scale-95" onClick={() => setToTank([...toTank, { product: buys[0]?.product ?? "HSD", litres: "", tank_id: "" }])}><Plus size={14} /> Apne tank mein khali karein</button>
          {stTanks.length === 0 && <p className="mt-1 text-xs text-slate-400">Koi tank nahi mila — pehle Settings me tank add karein.</p>}
        </div>

        {/* Live result: client profit (real), own-tank (stock, not a loss), and what we owe the supplier */}
        {(buyAmt > 0 || dropAmt > 0 || toTankL > 0) && <div className="space-y-1">
          {dropAmt > 0 && <div className={`flex items-center justify-between rounded-xl px-3 py-2 text-sm font-semibold ${clientProfit >= 0 ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>
            <span>Client munafa (sale − bike maal ki cost) · <Ur>کلائنٹ منافع</Ur></span><span className="tabular-nums">{pkr(clientProfit)}</span>
          </div>}
          {toTankL > 0 && <div className="flex items-center justify-between rounded-xl bg-sky-50 px-3 py-2 text-sm font-medium text-sky-900">
            <span>Apne tank mein daala (stock, loss nahi) · <Ur>اپنے ٹینک میں</Ur></span><span className="tabular-nums">{num(toTankL)} L · {pkr(toTankCost)}</span>
          </div>}
          <div className="flex items-center justify-between px-3 text-xs text-slate-500"><span>Supplier ko dene hain · <Ur>سپلائر کو</Ur></span><span className="tabular-nums">{pkr(buyAmt)}</span></div>
        </div>}

        {overBy.length > 0 && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
          {overBy.map((o) => `${PRODUCTS[o.p]}: ${num(o.l)} L (drop + apne tank) nikaal rahe hain lekin sirf ${num(o.have)} L available (held + abhi khareeda) — itna stock nahi.`).join(" ")} <Ur className="block">دستیاب سے زیادہ ڈیلیور نہیں ہو سکتا</Ur>
        </div>}

        <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ProofPhotos value={photos} onChange={setPhotos} hint="depot invoice / bilty" />
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy || !valid}><Truck size={15} /> Save delivery</button></div>
      </form>
      {lotVoucher != null && <BypassVoucher id={lotVoucher} onClose={() => setLotVoucher(null)} />}
    </>
  );
}

/** Inline "tap to add" a new party (supplier / client) without leaving the bypass form. */
function QuickAdd({ placeholder, onAdd, onCancel }: { placeholder: string; onAdd: (name: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async () => {
    if (name.trim().length < 2) { setErr("Naam chhota hai"); return; }
    setBusy(true); setErr("");
    try { await onAdd(name.trim()); } catch (e: any) { setErr(e?.message ?? "Save nahi hua"); setBusy(false); }
  };
  return (
    <div className="mt-1 flex gap-1">
      <input autoFocus className="input flex-1" placeholder={placeholder} value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }} />
      <button type="button" className="btn-primary !px-2" disabled={busy} onClick={save}><Plus size={14} /></button>
      <button type="button" className="btn-secondary !px-2" onClick={onCancel}>✕</button>
      {err && <span className="self-center text-xs text-rose-600">{err}</span>}
    </div>
  );
}

function SupplierStatement({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const [range, setRange] = useState({ from: "", to: "" });
  const qs = [range.from && `from=${range.from}`, range.to && `to=${range.to}`].filter(Boolean).join("&");
  const { data, reload } = useApi<any>(`/bypass/suppliers/${id}/statement${qs ? `?${qs}` : ""}`);
  const [pay, setPay] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const refresh = () => { reload(); onChanged(); };
  const csvUrl = `/api/bypass/suppliers/${id}/statement.csv?${qs ? qs + "&" : ""}token=${linkToken()}`;
  const s = data?.supplier;
  const allLines: any[] = data?.lines ?? [];
  const KIND_LABEL: Record<string, string> = { purchase: "Fuel bought", payment: "Payment", adjustment: "Adjustment" };
  const kindChips = [{ k: "", label: "All", n: allLines.length }, ...Array.from(new Set(allLines.map((l) => String(l.kind)))).map((k) => ({ k, label: KIND_LABEL[k] ?? k, n: allLines.filter((l) => l.kind === k).length }))];
  const lines = useListFilter(allLines, { q, keep: (l) => !kind || l.kind === kind,
    text: (l) => [l.ref, l.note, l.method, l.mode, l.vehicle_no, l.product, l.product && PRODUCTS[l.product], l.litres, l.cost_rate, l.debit, l.credit, l.amount].filter((v) => v != null && v !== false && v !== "").join(" ") });
  return (
    <Modal open onClose={onClose} title={s ? [s.company, s.name].filter(Boolean).join(" — ") : "Bypass supplier"} wide>
      {!data ? <Loading /> : (
        <div className="space-y-4">
          <div className="own-title hidden print:block">
            <div className="flex items-end justify-between border-b border-slate-300 pb-2">
              <div><div className="text-lg font-bold">{[s.company, s.name].filter(Boolean).join(" — ")}</div><div className="text-xs text-slate-600">{[s.depot_name ? `Depot: ${s.depot_name}` : "", "Bypass supplier statement"].filter(Boolean).join(" · ")}</div></div>
              <div className="text-right text-sm">We owe: <b className="tabular-nums">{pkr(s.bypass_owed)}</b></div>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3 print:hidden">
            <Stat label="We owe (bypass)" value={pkr(s.bypass_owed)} tone="red" hint={Math.abs(s.pump_owed ?? 0) > 0.5 ? `+ pump ${pkr(s.pump_owed)} = total ${pkr(s.total_owed)}` : undefined} />
            {can("wholesale.manage") && <button className="btn-primary min-h-10" onClick={() => setPay(true)}><HandCoins size={15} /> Pay supplier</button>}
            {can("entries.edit") && <SupplierClientLink supplier={s} onDone={refresh} />}
            <Field label="From"><input className="input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
            <Field label="To"><input className="input" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
            <a className="btn-secondary min-h-10" href={csvUrl}><Download size={15} /> Excel / CSV</a>
            <button className="btn-secondary min-h-10" onClick={() => window.print()}><Printer size={15} /> Print</button>
          </div>
          <ListTools q={q} onQ={setQ} placeholder="Ref / fuel / method… · تلاش" chips={kindChips} chip={kind} onChip={setKind} shown={lines.length} total={allLines.length} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-xs text-slate-500"><th className="py-2">Date</th><th>Entry</th><th className="text-right">We owe</th><th className="text-right">Paid</th><th className="text-right">Balance</th>{can("wholesale.void") && <th></th>}</tr></thead>
              <tbody>
                <tr className="border-b bg-slate-50"><td className="py-2" colSpan={4}>Opening</td><td className="text-right tabular-nums">{pkr(data.opening_balance)}</td>{can("wholesale.void") && <td></td>}</tr>
                {allLines.length > 0 && !lines.length && <tr><td colSpan={5} className="py-4 text-center text-slate-500">Kuch nahi mila · کچھ نہیں ملا</td></tr>}
                {lines.map((l: any) => (
                  <tr key={`${l.kind}-${l.id}`} className="border-b">
                    <td className="py-2 whitespace-nowrap">{dt(l.txn_date)}</td>
                    <td><span className="flex flex-wrap items-center gap-1">{l.kind === "purchase" ? `Bypass fuel${l.litres ? ` · ${num(l.litres)} L ${PRODUCTS[l.product] ?? l.product} @ ${l.cost_rate}` : ""}` : `Payment${l.mode && l.mode !== "we_pay" ? ` · ${l.mode}` : ""}${l.method ? ` · ${l.method}` : ""}`}{l.ref ? <span className="text-xs text-slate-400"> · {l.ref}</span> : ""}<ProofThumbs ids={l.proof_ids} onChanged={refresh} /></span></td>
                    <td className="text-right tabular-nums text-rose-600">{l.debit ? pkr(l.debit) : ""}</td>
                    <td className="text-right tabular-nums text-emerald-600">{l.credit ? pkr(l.credit) : ""}</td>
                    <td className="text-right font-medium tabular-nums">{pkr(l.balance)}</td>
                    {can("wholesale.void") && <td className="whitespace-nowrap text-right">
                      {l.kind === "purchase" && can("entries.edit") && <button className="mr-2 text-slate-500 hover:text-brand-700" title="Edit" onClick={() => setEdit(l)}><Pencil size={14} /></button>}
                      <button className="text-rose-600 hover:underline" title="Void" onClick={async () => { if (confirm("Void this entry?")) { await api(`/bypass/${l.kind === "purchase" ? "purchases" : "payments"}/${l.id}/void`, { body: {} }).catch((e) => alert(e.message)); refresh(); } }}><Ban size={14} /></button>
                    </td>}
                  </tr>
                ))}
                <tr className="border-t-2 font-bold"><td className="py-2" colSpan={4}>Closing (we owe)</td><td className="text-right tabular-nums">{pkr(data.closing_balance)}</td>{can("wholesale.void") && <td></td>}</tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
      {pay && <PaySupplier id={id} owed={s?.bypass_owed ?? 0} onClose={() => setPay(false)} onDone={() => { setPay(false); refresh(); }} />}
      {edit && <EditBypassPurchase x={{ ...edit, supplier_name: s?.name, client_fuel: edit.client_fuel || s?.client_id }} onClose={() => setEdit(null)} onDone={() => { setEdit(null); refresh(); }} />}
    </Modal>
  );
}

function PaySupplier({ id, owed, onClose, onDone }: { id: number; owed: number; onClose: () => void; onDone: () => void }) {
  const clients = useApi<any[]>("/wholesale/clients");
  const [f, setF] = useState({ amount: "", mode: "we_pay", method: "Bank transfer", client_id: "", ref: "", note: "" });
  const [acc, setAcc] = useState<number | null>(null);
  const [photos, setPhotos] = useState<number[]>([]);
  const { busy, run } = useAction();
  const needsClient = f.mode !== "we_pay";
  const needsBank = f.mode !== "client_direct";
  const MODES: [string, string, string][] = [
    ["we_pay", "Hum pay karein", "humare bank/cash se supplier ko"],
    ["client_direct", "Client ne direct diya", "client ne supplier ko khud diya — uski due bhi kam"],
    ["through_us", "Client → hum → supplier", "client ne hamein bheja, hum ne aage diya (net-zero)"],
  ];
  const valid = Number(f.amount) > 0 && (!needsClient || f.client_id) && (!needsBank || f.mode === "client_direct" || true);
  return (
    <Modal open onClose={onClose} title="Pay bypass supplier">
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        const body: any = { amount: Number(f.amount), mode: f.mode, ref: f.ref || null, note: f.note || null, photo_ids: photos };
        if (needsClient) body.client_id = Number(f.client_id);
        if (needsBank) { body.method = f.method; body.account_id = acc; }
        if (await run(() => api(`/bypass/suppliers/${id}/payment`, { body }), (r: any) => `Done. We now owe ${pkr(r.bypass_owed)}${r.client_due !== undefined ? ` · client due ${pkr(r.client_due)}` : ""}`)) onDone();
      }}>
        <p className="text-sm text-slate-600">We owe: <b>{pkr(owed)}</b></p>
        <fieldset>
          <legend className="label">Kaun pay kar raha hai? · <Ur>کون ادائیگی</Ur></legend>
          <div className="grid grid-cols-1 gap-2">
            {MODES.map(([m, title, sub]) => (
              <button type="button" key={m} onClick={() => setF({ ...f, mode: m })} aria-pressed={f.mode === m}
                className={`rounded-xl px-3 py-2 text-left text-sm ${f.mode === m ? "bg-slate-800 font-semibold text-white" : "bg-slate-100 text-slate-700"}`}>{title}<span className={`block text-xs font-normal ${f.mode === m ? "text-white/80" : "text-slate-500"}`}>{sub}</span></button>
            ))}
          </div>
        </fieldset>
        <Field label="Amount (Rs) *"><input className="input" type="number" inputMode="decimal" min={1} required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        {needsClient && <Field label="Which client paid? · کون سا کلائنٹ *"><select className="input" required value={f.client_id} onChange={(e) => setF({ ...f, client_id: e.target.value })}>
          <option value="">— choose client —</option>{(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name} · due {pkr(c.due)}</option>)}</select></Field>}
        {needsBank && <>
          <Field label={f.mode === "through_us" ? "Client sent to / we forwarded from which account?" : "Method"}><select className="input" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{["Bank transfer", "Cash", "Cheque", "Raast", "JazzCash", "Easypaisa", "Online"].map((m) => <option key={m}>{m}</option>)}</select></Field>
          <AccountPicker method={f.method} value={acc} onChange={setAcc} />
        </>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Ref / slip"><input className="input" value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} /></Field>
          <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        </div>
        <ProofPhotos value={photos} onChange={setPhotos} hint="payment slip / screenshot" />
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy || !valid}>Save payment</button></div>
      </form>
    </Modal>
  );
}


/**
 * The tanker had more than the clients took: the rest is emptied into OUR tank. Bypass stock goes down at its average
 * cost, the pump's tank goes up, a stock-register delivery is written at that cost — no new supplier bill.
 */
/** Edit one own-tank unload: litres, tank (same fuel), day, note, cost amount; the old transfer is reversed and re-made. */
function EditToTank({ r, tanks, onClose, onDone }: { r: any; tanks: any[]; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [litres, setLitres] = useState(String(r.litres ?? ""));
  const [tankId, setTankId] = useState(String(tanks.find((t: any) => t.name === r.tank && t.product === r.product)?.id ?? tanks.find((t: any) => t.product === r.product)?.id ?? ""));
  const [date, setDate] = useState(String(r.txn_date ?? "").slice(0, 10));
  const [note, setNote] = useState(r.note ?? "");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const L = Number(litres) || 0;
  const save = () => run(() => api(`/bypass/to-tank/${r.id}`, { method: "PATCH", body: { reason, litres: L, tank_id: Number(tankId) || undefined, txn_date: date || undefined, note: note || null, amount: amount ? Number(amount) : undefined } }), "Unload update — stock aur tank theek")
    .then((ok) => { if (ok) onDone(); });
  return (
    <Modal open title={`Unload edit — ${num(r.litres)} L ${PRODUCTS[r.product] ?? r.product}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="rounded-xl bg-amber-50 p-2.5 text-xs text-amber-900">Purani entry ulti ho kar nayi banegi: bypass stock, pump ka tank aur stock register sab saath badlenge. Tank se ye litre bik chuke hon to edit nahi hoga. Audit log me pehle / baad aur wajah.</p>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Litre"><input className="input text-lg font-semibold" type="number" inputMode="decimal" value={litres} onChange={(e) => setLitres(e.target.value)} /></Field>
          <Field label="Tank"><select className="input" value={tankId} onChange={(e) => setTankId(e.target.value)}>{tanks.filter((t: any) => t.product === r.product).map((t: any) => <option key={t.id} value={t.id}>{t.name} · {t.station}</option>)}</select></Field>
          <Field label="Tareekh"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Cost amount (khali = average cost)"><input className="input" type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`abhi ${pkr(r.cost_amount)}`} /></Field>
        </div>
        <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <Field label="Wajah (zaroori)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. litre 3,000 nahi 2,500 the" /></Field>
        <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !(L > 0) || !tankId || reason.trim().length < 3} onClick={save}>Save</button></div>
      </div>
    </Modal>
  );
}

/** "Rate theek karein": the lot's own rate (one tap), or the owner's own rate per litre / total amount (e.g. the real bill). */
function RecostToTank({ r, onClose, onDone }: { r: any; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<"lot" | "rate" | "amount">("lot");
  const [val, setVal] = useState("");
  const [reason, setReason] = useState("");
  const quote = useApi<any>(`/bypass/to-tank/quote?product=${r.product}&litres=${r.litres}&skip=${r.id}${r.tanker_no ? `&tanker_no=${encodeURIComponent(r.tanker_no)}` : r.note ? `&tanker_no=${encodeURIComponent(r.note)}` : ""}`);
  const v = Number(val) || 0;
  const newAmt = mode === "lot" ? quote.data?.cost ?? null : mode === "rate" ? (v > 0 ? Math.round(v * r.litres * 100) / 100 : null) : (v > 0 ? v : null);
  const newRate = newAmt != null && r.litres > 0 ? newAmt / r.litres : null;
  const { busy, run } = useAction();
  const save = async () => {
    const body = mode === "lot" ? {} : mode === "rate" ? { rate: v } : { amount: v };
    const x = await run(() => api(`/bypass/to-tank/${r.id}/recost`, { body: { ...body, ...(reason.trim() ? { reason: reason.trim() } : {}) } }),
      (y: any) => `Rate theek: Rs ${num(r.unit_cost, 2)} → Rs ${num(y.unit_cost, 2)} · amount ${pkr(y.before_cost)} → ${pkr(y.cost)}`);
    if (x) onDone();
  };
  return (
    <Modal open onClose={onClose} title={`Rate theek karein · ${PRODUCTS[r.product] ?? r.product} ${num(r.litres)} L`}>
      <div className="space-y-3">
        <p className="rounded-lg bg-slate-50 p-2 text-sm">Abhi: <b>Rs {num(r.unit_cost, 2)}/L</b> · {pkr(r.cost_amount)} · {r.tank}{r.tanker_no || r.note ? ` · ${r.tanker_no ?? r.note}` : ""}</p>
        <div role="radiogroup" className="space-y-2">
          {([["lot", "Lot ka asal rate", quote.data ? `Rs ${num(quote.data.unit, 2)}/L · ${pkr(quote.data.cost)}` : "…"], ["rate", "Apna rate (Rs per litre)", "jaise 339.97"], ["amount", "Apni kul raqam (Rs)", "jaise asal bill + kiraya"]] as const).map(([k, l, hint]) => (
            <label key={k} className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 ${mode === k ? "border-brand-500 bg-brand-50" : "border-slate-200"}`}>
              <input type="radio" name="recost" checked={mode === k} onChange={() => { setMode(k); setVal(""); }} className="h-4 w-4" />
              <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{l}</span><span className="block text-xs text-slate-500">{hint}</span></span>
            </label>
          ))}
        </div>
        {mode !== "lot" && <Field label={mode === "rate" ? "Rate (Rs/L)" : "Kul raqam (Rs)"}><input autoFocus className="input py-3 text-2xl" type="number" inputMode="decimal" min={0} step="0.01" value={val} onChange={(e) => setVal(e.target.value)} /></Field>}
        <Field label="Wajah (optional)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="jaise: depot bill ke mutabiq" /></Field>
        {newAmt != null && <div className="rounded-xl bg-emerald-50 p-3 text-sm tabular-nums">
          <div className="flex justify-between"><span>Naya rate</span><b>Rs {num(newRate ?? 0, 2)}/L</b></div>
          <div className="flex justify-between"><span>Nayi raqam</span><b>{pkr(newAmt)}</b></div>
          <div className="flex justify-between text-xs text-slate-600"><span>Farq</span><span>{pkr(newAmt - r.cost_amount)}</span></div>
          <p className="mt-1 text-xs text-slate-500">Pump ka stock register, stock ki qeemat aur books isi ke mutabiq badlenge. Litre aur tank wahi rahenge.</p>
        </div>}
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={busy || newAmt == null || newAmt <= 0} onClick={save}>Theek karein · <Ur>محفوظ</Ur></button></div>
      </div>
    </Modal>
  );
}

function LeftoverToTank({ stock, onChanged, always = false }: { stock: any[]; onChanged: () => void; always?: boolean }) {
  const { can } = useAuth();
  const stations = useApi<any[]>("/stations");
  const list = useApi<any[]>("/bypass/to-tank");
  const { busy, run } = useAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ product: "", litres: "", tank_id: "", note: "", tanker_no: "", txn_date: new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10) });
  // the tankers that still carry this fuel (open lots), so the unload is costed from — and taken off — that tanker's bill
  const lotsApi = useApi<any>(open ? "/bypass/lots" : null);
  const vehicles = [...new Set<string>(((lotsApi.data?.fuels ?? []).find((x: any) => x.product === f.product)?.lots ?? []).flatMap((l: any) => l.vehicles ?? []))];
  const tanks = (stations.data ?? []).flatMap((s: any) => (s.tanks ?? []).map((t: any) => ({ ...t, station: s.name })));
  const prodTanks = tanks.filter((t: any) => t.product === f.product);
  const onHand = stock.find((x) => x.product === f.product);
  const litres = Number(f.litres) || 0;
  const quote = useApi<any>(open && f.product && litres > 0 ? `/bypass/to-tank/quote?product=${f.product}&litres=${litres}${f.tanker_no ? `&tanker_no=${encodeURIComponent(f.tanker_no)}` : ""}` : null);
  const unit = quote.data?.unit ?? 0;
  const [lq, setLq] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [editRow, setEditRow] = useState<any>(null);
  const [recostRow, setRecostRow] = useState<any>(null);
  const [unloadVoucher, setUnloadVoucher] = useState<number | null>(null);
  const allRows = (list.data ?? []).filter((r: any) => !r.voided);
  const matched = useListFilter(allRows, { q: lq, text: (r: any) => [r.product, PRODUCTS[r.product], r.tank, r.station, r.note, r.created_by, r.litres].filter((v) => v != null && v !== "").join(" ") });
  const rows = showAll || lq ? matched : matched.slice(0, 8);
  if (!always && !stock.length && !allRows.length) return null;
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto font-semibold">Bacha hua tel apne tank mein · <Ur>بچا ہوا تیل اپنے ٹینک میں</Ur></h3>
        {can("wholesale.manage") && <button className="btn-primary" disabled={!stock.length} onClick={() => { const p = stock[0]?.product ?? ""; setF({ ...f, product: p, tank_id: String(tanks.find((t: any) => t.product === p)?.id ?? "") }); setOpen(true); }}><Plus size={15} /> Unload to tank · <Ur>ٹینک میں ڈالیں</Ur></button>}
      </div>
      <p className="mt-1 text-xs text-slate-500">Tanker mein jo tel client ko dene ke baad bach gaya aur apne pump ke tank mein khali kiya: bypass stock se nikal kar pump ke stock mein — usi gaari ke bill ke asal rate par. Supplier ka bill dobara nahi banta.</p>
      {allRows.length > 0 && <div className="mt-3"><ListTools q={lq} onQ={setLq} placeholder="Tank / fuel / note… · تلاش" shown={rows.length} total={allRows.length}
        right={matched.length > 8 ? <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => setShowAll((v) => !v)}>{showAll ? "Show less" : `Show all (${matched.length})`}</button> : null} /></div>}
      {allRows.length > 0 && !rows.length && <Empty>Kuch nahi mila · کچھ نہیں ملا</Empty>}
      {rows.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead><tr><th className="th">Tareekh</th><th className="th">Fuel</th><th className="th text-right">Litre</th><th className="th">Tank</th><th className="th">Station</th><th className="th">Delivery</th><th className="th">Note</th><th className="th">By</th><th className="th text-right">Cost rate</th><th className="th text-right">Amount</th>{(can("wholesale.void") || can("wholesale.manage")) && <th className="th"></th>}</tr></thead>
            <tbody className="tabular-nums">
              {rows.map((r: any) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="td whitespace-nowrap">{dt(r.txn_date)}</td>
                  <td className="td font-medium">{PRODUCTS[r.product] ?? r.product}</td>
                  <td className="td text-right font-semibold">{num(r.litres)} L</td>
                  <td className="td">{r.tank}</td>
                  <td className="td text-xs text-slate-600">{r.station}</td>
                  <td className="td text-xs">{r.delivery_id ? <button type="button" className="font-mono text-brand-700 underline" onClick={() => setUnloadVoucher(r.delivery_id)}>BYP-{r.delivery_id}</button> : "—"}</td>
                  <td className="td text-xs text-slate-600">{[r.tanker_no, r.note].filter(Boolean).join(" · ")}</td>
                  <td className="td text-xs text-slate-600">{r.created_by}</td>
                  <td className="td text-right">Rs {num(r.unit_cost, 2)}</td>
                  <td className="td text-right font-semibold">{pkr(r.cost_amount)}</td>
                  {(can("wholesale.void") || can("wholesale.manage")) && <td className="td whitespace-nowrap text-right">{can("wholesale.manage") && <button className="btn-secondary mr-1 !px-2 !py-1 text-xs" title="Rate theek karein: lot ka asal rate ya apna rate / raqam" onClick={() => setRecostRow(r)}>Rate theek karein</button>}
                  {can("wholesale.manage") && <button className="btn-secondary mr-1 !px-2 !py-1 text-xs" title="Edit" onClick={() => setEditRow(r)}><Pencil size={13} /> Edit</button>}{can("wholesale.void") && <button className="btn-secondary !px-2 !py-1 text-xs text-red-600" disabled={busy} onClick={async () => { const a = await askCancel({ title: "Apne tank wala maal wapas (undo)", what: <><b>{num(r.litres, 0)} L</b> · {r.tank}</>, hint: "Litre tank se nikal kar wapas bypass stock me chale jayenge." }); if (a) run(() => api(`/bypass/to-tank/${r.id}/void`, { body: { reason: a.reason }, headers: pinHeader(a) }), "Undone — bypass stock aur tank wapas").then(() => { list.reload(); onChanged(); }); }}><Ban size={13} /> Undo</button>}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="border-t-2 bg-slate-50 font-semibold tabular-nums"><td className="td" colSpan={2}>Kul · {rows.length} entries</td><td className="td text-right">{num(rows.reduce((a: number, r: any) => a + r.litres, 0))} L</td><td className="td" colSpan={6}></td><td className="td text-right">{pkr(rows.reduce((a: number, r: any) => a + r.cost_amount, 0))}</td>{(can("wholesale.void") || can("wholesale.manage")) && <td className="td"></td>}</tr></tfoot>
          </table>
        </div>
      )}
      {recostRow && <RecostToTank r={recostRow} onClose={() => setRecostRow(null)} onDone={() => { setRecostRow(null); list.reload(); onChanged(); }} />}
      {editRow && <EditToTank r={editRow} tanks={tanks} onClose={() => setEditRow(null)} onDone={() => { setEditRow(null); list.reload(); onChanged(); }} />}
      {unloadVoucher != null && <BypassVoucher id={unloadVoucher} onClose={() => setUnloadVoucher(null)} />}
      <Modal open={open} onClose={() => setOpen(false)} title="Bacha hua tel apne tank mein · بچا ہوا تیل">
        <form className="space-y-3" onSubmit={async (e) => {
          e.preventDefault();
          const r = await run(() => api("/bypass/to-tank", { body: { product: f.product, litres: Number(f.litres), tank_id: Number(f.tank_id), note: f.note || null, txn_date: f.txn_date, tanker_no: f.tanker_no || null } }),
            (x: any) => `${num(x.litres)} L ${PRODUCTS[f.product] ?? f.product} tank mein — pump stock +${num(x.litres)} L, cost ${pkr(x.cost)}`);
          if (r) { setOpen(false); setF({ ...f, litres: "", note: "" }); list.reload(); onChanged(); }
        }}>
          <Field label="Fuel · تیل"><select className="input" value={f.product} onChange={(e) => { const p = e.target.value; setF({ ...f, product: p, tank_id: String(tanks.find((t: any) => t.product === p)?.id ?? "") }); }}>
            {stock.map((x) => <option key={x.product} value={x.product}>{PRODUCTS[x.product] ?? x.product} — {num(x.litres)} L bypass stock @ Rs {num(x.avg_cost, 2)}</option>)}</select></Field>
          <Field label="Litres · لیٹر"><input className="input py-3 text-2xl" type="number" inputMode="decimal" min={1} max={onHand?.litres ?? undefined} step="1" required value={f.litres} onChange={(e) => setF({ ...f, litres: e.target.value })} placeholder={onHand ? `max ${num(onHand.litres)}` : ""} /></Field>
          <Field label="Kis gaari se utara · کس گاڑی سے"><select className="input" value={f.tanker_no} onChange={(e) => setF({ ...f, tanker_no: e.target.value })}>
            <option value="">— pata nahi (purana maal pehle) —</option>{vehicles.map((v) => <option key={v} value={v}>{v}</option>)}</select></Field>
          <Field label="Kis tank mein · کون سا ٹینک"><select className="input" required value={f.tank_id} onChange={(e) => setF({ ...f, tank_id: e.target.value })}>
            <option value="">— tank —</option>{prodTanks.map((t: any) => <option key={t.id} value={t.id}>{t.name} · {t.station} · {num(t.current_l)} / {num(t.capacity_l)} L</option>)}</select></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Date"><input className="input" type="date" value={f.txn_date} onChange={(e) => setF({ ...f, txn_date: e.target.value })} /></Field>
            <Field label="Note (optional)"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. Tanker 1,000 L bacha" /></Field>
          </div>
          {litres > 0 && <div className="rounded-xl bg-slate-50 p-3 text-sm"><div className="flex justify-between"><span>Pump stock</span><b>+{num(litres)} L</b></div><div className="flex justify-between"><span>Cost (lot ka asal rate{f.tanker_no ? ` · ${f.tanker_no}` : ""})</span><span className="tabular-nums">{num(litres)} × {num(unit, 2)} = <b>{pkr(litres * unit)}</b></span></div><div className="mt-1 text-xs text-slate-500">Journal: Dr Fuel purchases / Cr Bypass stock. Stock register mein delivery entry banegi.</div></div>}
          <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn-primary" disabled={busy || !f.product || !f.tank_id || !(litres > 0)}>Save · <Ur>محفوظ</Ur></button></div>
        </form>
      </Modal>
    </div>
  );
}
