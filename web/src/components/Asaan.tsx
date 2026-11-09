/**
 * "Asaan mode" — the simple, big-button face of the app for salesmen, cashiers and anyone who finds the full screens
 * too busy. One job per tile, the number biggest, every label in Roman Urdu + Urdu, one meaning per colour
 * (green = money in / OK, red = money out / danger, amber = attention). Text is never light grey, touch targets ≥ 64 px.
 *
 * Building blocks: BigAction (home tile), MoneyCard (ledger card), NumPad (calculator keypad), TankGauge.
 * The mode is a per-device choice (localStorage), ON by default for salesman and cashier; everyone can switch it.
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowDownCircle, ArrowUpCircle, CheckCircle2, ChevronLeft, Delete, Fuel, HandCoins, Home, LogIn, LogOut, MessageCircle, Minus, Plus, Receipt, RefreshCw, ShoppingCart, Wifi, WifiOff } from "lucide-react";
import { api, useApi } from "../lib/api";
import { useQueueStatus } from "../lib/offline";
import { WhatsAppDocModal } from "./WhatsAppDoc";
import { useAuth } from "../App";
import { num, pkr, PRODUCTS, PRODUCT_UR } from "../lib/format";
import { toWords } from "../lib/words";

/* ------------------------------------------------------------------ the mode switch ------------------------------------------------------------------ */
const KEY = "pumpai_asaan";
const subs = new Set<() => void>();
const read = (): "1" | "0" | null => { try { const v = localStorage.getItem(KEY); return v === "1" || v === "0" ? v : null; } catch { return null; } };
/** Roles that start in Asaan mode until they switch it off. */
export const ASAAN_DEFAULT_ROLES = ["salesman", "cashier"];
export function useAsaan(): [boolean, (on: boolean) => void] {
  const { user } = useAuth();
  const v = useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, read, () => null);
  const on = v === null ? ASAAN_DEFAULT_ROLES.includes(user?.role ?? "") : v === "1";
  const set = (x: boolean) => { try { localStorage.setItem(KEY, x ? "1" : "0"); } catch { /* private window: this visit only */ } subs.forEach((f) => f()); };
  return [on, set];
}

/** The switch shown in the menu: big, both languages, says what it does. */
export function AsaanToggle({ dark = true }: { dark?: boolean }) {
  const [on, set] = useAsaan();
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => set(!on)}
      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold ${dark ? "bg-white/10 text-white hover:bg-white/15" : "bg-slate-100 text-ink"}`}>
      <span className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-emerald-400" : "bg-white/30"}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
      </span>
      <span className="min-w-0 flex-1 leading-tight">Asaan mode<span lang="ur" dir="rtl" className="font-urdu block text-xs font-normal opacity-80">آسان موڈ — بڑے بٹن</span></span>
    </button>
  );
}

/* ------------------------------------------------------------------ building blocks ------------------------------------------------------------------ */
const Urdu = ({ children, className = "" }: { children: ReactNode; className?: string }) => <span lang="ur" dir="rtl" className={`font-urdu ${className}`}>{children}</span>;

type Tone = "in" | "out" | "warn" | "ink" | "brand";
const TILE: Record<Tone, string> = {
  in: "bg-in text-white ring-in-ring", out: "bg-out text-white ring-out-ring", warn: "bg-warn text-white ring-warn-ring",
  ink: "bg-ink text-white ring-slate-400", brand: "bg-brand-700 text-white ring-brand-500",
};

/** A home-screen tile: full width, ≥ 104 px, a big icon, the action in Roman Urdu and Urdu, an optional line under it. */
export function BigAction({ to, onClick, icon: Icon, en, ur, sub, tone = "brand" }: { to?: string; onClick?: () => void; icon: any; en: string; ur: string; sub?: ReactNode; tone?: Tone }) {
  const body = (
    <>
      <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-white/15"><Icon size={40} strokeWidth={2.25} aria-hidden /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-act uppercase tracking-wide">{en}</span>
        <Urdu className="block text-ur-act">{ur}</Urdu>
        {sub && <span className="mt-0.5 block text-base font-semibold opacity-95">{sub}</span>}
      </span>
      <span className="text-3xl font-black opacity-80" aria-hidden>›</span>
    </>
  );
  const cls = `flex min-h-tap-xl w-full items-center gap-4 rounded-3xl px-5 py-4 text-left shadow-lg ring-4 ring-transparent transition active:scale-[.98] focus-visible:outline-none focus-visible:ring-offset-2 focus-visible:ring-ink ${TILE[tone]}`;
  return to ? <Link to={to} className={cls}>{body}</Link> : <button type="button" onClick={onClick} className={cls}>{body}</button>;
}

/** A ledger card: label on top, the number biggest, a thick colour edge that says good (green) or owed (red). */
export function MoneyCard({ en, ur, value, tone = "ink", sub }: { en: string; ur: string; value: number | null | undefined; tone?: "in" | "out" | "ink"; sub?: ReactNode }) {
  const edge = tone === "in" ? "border-in bg-in-bg" : tone === "out" ? "border-out bg-out-bg" : "border-slate-300 bg-white";
  const text = tone === "in" ? "text-in" : tone === "out" ? "text-out" : "text-ink";
  return (
    <div className={`rounded-2xl border-2 border-l-8 p-4 ${edge}`}>
      <div className="flex items-baseline justify-between gap-2"><span className="text-base font-bold text-ink">{en}</span><Urdu className="text-lg text-ink">{ur}</Urdu></div>
      <div className={`mt-1 text-num-lg tabular-nums sm:text-num-xl ${text}`}>{value == null ? "—" : pkr(value)}</div>
      {sub && <div className="mt-1 text-sm font-semibold text-slate-700">{sub}</div>}
    </div>
  );
}

/** Calculator keypad for amounts: 72 px keys, a 000 key, the amount big on top and in words under it. */
export function NumPad({ value, onChange, max = 1_000_000_000, label = "Raqam", ur = "رقم", decimal = false, unit }: { value: string; onChange: (v: string) => void; max?: number; label?: string; ur?: string; decimal?: boolean; unit?: string }) {
  const n = Number(value) || 0;
  const press = (k: string) => {
    if (k === "back") return onChange(value.slice(0, -1));
    if (k === "clear") return onChange("");
    if (k === ".") return value.includes(".") ? undefined : onChange((value || "0") + ".");
    if (value.includes(".") && value.split(".")[1].length >= 2) return; // meters: 2 decimals
    const next = (value === "0" ? "" : value) + k;
    if (Number(next) > max || next.length > 12) return;
    onChange(next.replace(/^0+(?=\d)/, ""));
  };
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", decimal ? "." : "000", "0", "back"];
  const [whole, frac] = value.split(".");
  return (
    <div className="rounded-3xl border-2 border-slate-300 bg-white p-3">
      <div className="flex items-baseline justify-between px-1"><span className="text-base font-bold text-ink">{label}</span><Urdu className="text-lg text-ink">{ur}</Urdu></div>
      <output aria-live="polite" className="block break-all px-1 text-right text-num-lg tabular-nums text-ink sm:text-num-xl">{unit != null ? <>{num(Number(whole) || 0)}{frac !== undefined ? `.${frac}` : ""} <span className="text-2xl">{unit}</span></> : n ? `Rs ${num(n)}` : "Rs 0"}</output>
      <p className="min-h-5 px-1 text-right text-sm font-semibold text-slate-700">{unit == null && n > 0 ? toWords(n) : " "}</p>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {keys.map((k) => (
          <button key={k} type="button" onClick={() => press(k)} aria-label={k === "back" ? "Mitao" : k}
            className={`flex h-[72px] items-center justify-center rounded-2xl text-3xl font-extrabold active:scale-95 ${k === "back" ? "bg-out-bg text-out" : "bg-slate-100 text-ink hover:bg-slate-200"}`}>
            {k === "back" ? <Delete size={30} /> : k}
          </button>
        ))}
      </div>
      {n > 0 && <button type="button" onClick={() => press("clear")} className="mt-2 w-full rounded-xl py-2 text-base font-bold text-slate-700 underline">Saaf karein · <Urdu>صاف کریں</Urdu></button>}
    </div>
  );
}

const LIGHT = {
  green: { bar: "bg-in", text: "text-in", bg: "bg-in-bg border-in-ring", en: "Theek hai", ur: "ٹھیک ہے" },
  amber: { bar: "bg-warn", text: "text-warn", bg: "bg-warn-bg border-warn-ring", en: "Order kar dein", ur: "آرڈر کر دیں" },
  red: { bar: "bg-out", text: "text-out", bg: "bg-out-bg border-out-ring", en: "Fauran order karein!", ur: "فوراً آرڈر کریں!" },
} as const;
const daysText = (d: number | null) => (d == null ? null : d < 1 ? "1 din se kam" : `${d % 1 ? d.toFixed(1) : d} din`);

/** One tank as a big upright gauge: fill level, litres, days of fuel left, traffic-light colour. */
export function TankGauge({ t }: { t: any }) {
  const L = LIGHT[t.light as keyof typeof LIGHT] ?? LIGHT.green;
  return (
    <div className={`flex items-center gap-4 rounded-3xl border-2 p-4 ${L.bg}`}>
      <div className="relative h-32 w-16 shrink-0 overflow-hidden rounded-2xl border-4 border-ink bg-white" role="img" aria-label={`${t.pct}% bhara`}>
        <div className={`absolute inset-x-0 bottom-0 ${L.bar}`} style={{ height: `${Math.max(3, t.pct)}%` }} />
        <span className="absolute inset-x-1 top-1 rounded-md bg-white/95 text-center text-sm font-black text-ink shadow-sm">{t.pct}%</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2"><span className="text-act text-ink">{PRODUCTS[t.product] ?? t.product}</span><Urdu className="text-ur-act text-ink">{PRODUCT_UR[t.product] ?? ""}</Urdu><span className="text-sm font-semibold text-slate-700">{t.name}</span></div>
        <div className="text-num-lg tabular-nums text-ink">{num(t.current_l)} L</div>
        <div className={`text-lg font-extrabold leading-snug ${L.text}`}>{daysText(t.days_left) ? <>{daysText(t.days_left)} ka tail · </> : null}{L.en}<Urdu className="block text-lg font-normal">{L.ur}</Urdu></div>
        {t.per_day_l > 0 && <div className="text-sm font-semibold text-slate-700">Roz ki sale ~{num(t.per_day_l)} L · {num(t.capacity_l)} L ka tank</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ screens ------------------------------------------------------------------ */
function useHome() { return useApi<any>("/asaan/home", 60_000); }

/** The worst tank, as a banner on top of the home screen (only when one needs fuel). */
function TankBanner({ tanks }: { tanks: any[] }) {
  const bad = [...tanks].filter((t) => t.light !== "green").sort((a, b) => (a.light === "red" ? -1 : 1) - (b.light === "red" ? -1 : 1))[0];
  if (!bad) return null;
  const red = bad.light === "red";
  return (
    <Link to="/tanks-level" className={`flex items-center gap-3 rounded-2xl border-2 px-4 py-3 ${red ? "border-out bg-out text-white" : "border-warn-ring bg-warn-bg text-warn"}`}>
      {/* only the icon blinks — the text keeps full contrast for sunlight */}
      <span className="relative flex shrink-0"><Fuel size={32} aria-hidden />{red && <span className="absolute -right-1 -top-1 h-3.5 w-3.5 rounded-full bg-white motion-safe:animate-ping" aria-hidden />}</span>
      <span className="min-w-0 flex-1 text-lg font-extrabold leading-tight">{PRODUCTS[bad.product] ?? bad.product}: {daysText(bad.days_left) ?? `${bad.pct}%`} ka tail baqi!<Urdu className="block text-base font-normal">{PRODUCT_UR[bad.product] ?? ""} کم ہے — {red ? "فوراً آرڈر کریں" : "آرڈر کر دیں"}</Urdu></span>
    </Link>
  );
}

/** Salesman / cashier home: three or four big tiles and the one number that matters. */
export function AsaanHome() {
  const { user, can, modules } = useAuth();
  const { data, reload } = useHome();
  const cashier = can("cashier.desk");
  const shift = data?.shift;
  return (
    <div className="mx-auto max-w-xl space-y-4 pb-28">
      <SyncDot big />
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0"><h1 className="truncate text-2xl font-extrabold text-ink">Salam, {user?.name?.split(" ")[0]}</h1><Urdu className="text-lg text-ink">آج کیا کرنا ہے؟</Urdu></div>
        <button type="button" onClick={() => reload()} className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-ink" aria-label="Taaza karein"><RefreshCw size={26} /></button>
      </div>

      {data?.tanks && <TankBanner tanks={data.tanks} />}

      {cashier ? <>
        <BigAction to="/cashier?tab=receive" icon={ArrowDownCircle} tone="in" en="Paisa aaya" ur="رقم آئی — وصولی" sub="Khata, client, supplier se" />
        <BigAction to="/cashier?tab=pay" icon={ArrowUpCircle} tone="out" en="Paisa gaya" ur="رقم گئی — ادائیگی" sub="Kharcha, supplier, advance" />
        {can("shifts.handover") && <BigAction to="/cashier?tab=handover" icon={HandCoins} tone="ink" en="Salesman se cash" ur="سیلزمین سے کیش لیں" />}
      </> : <>
        <BigAction to={shift ? `/shift-band/${shift.id}` : "/shifts"} icon={shift ? LogOut : LogIn} tone={shift ? "out" : "in"}
          en={shift ? "Shift band karein" : "Shift shuru karein"} ur={shift ? "شفٹ ختم کریں" : "شفٹ شروع کریں"}
          sub={shift ? `Chal rahi hai · ${shift.station_name}` : "Abhi koi shift nahi"} />
        {modules.pos
          ? <BigAction to="/pos" icon={ShoppingCart} tone="brand" en="Sale darj karein" ur="روزانہ کیش انٹری — فروخت" sub={shift ? `Is shift mein ${pkr(shift.sale_amount)} · ${num(shift.sale_litres)} L` : undefined} />
          : <BigAction to="/shifts" icon={Receipt} tone="brand" en="Aaj ka cash" ur="روزانہ کیش انٹری" />}
      </>}
      <BigAction to="/tanks-level" icon={Fuel} tone="warn" en="Tank mein tail kitna hai" ur="ٹینک میں تیل کتنا ہے" />

      {data?.cash_in_hand != null && <MoneyCard en="Galla abhi" ur="گلہ — ہاتھ میں کیش" value={data.cash_in_hand} tone="in" />}
      {shift && !cashier && <MoneyCard en="Is shift ki sale" ur="اس شفٹ کی فروخت" value={shift.sale_amount} tone="ink" sub={`${shift.sale_n} entries · ${num(shift.sale_litres)} L`} />}

      <p className="text-center text-sm font-semibold text-slate-700">Poora menu ☰ upar hai · <Urdu>باقی سب کچھ مینو میں</Urdu></p>
    </div>
  );
}

/** Tank levels for everyone (salesman included): one big gauge per tank, worst first. */
export function TanksLevel() {
  const { data, reload } = useHome();
  const tanks = [...(data?.tanks ?? [])].sort((a, b) => ["red", "amber", "green"].indexOf(a.light) - ["red", "amber", "green"].indexOf(b.light));
  useEffect(() => { const id = setInterval(() => reload(), 120_000); return () => clearInterval(id); }, [reload]);
  return (
    <div className="mx-auto max-w-xl space-y-3 pb-28">
      <div><h1 className="text-2xl font-extrabold text-ink">Tank mein tail kitna hai</h1><Urdu className="text-xl text-ink">ٹینک میں تیل کتنا ہے</Urdu></div>
      {!data ? <p className="text-lg font-semibold text-slate-700">Load ho raha hai…</p>
        : !tanks.length ? <p className="text-lg font-semibold text-slate-700">Koi tank nahi mila</p>
        : tanks.map((t) => <TankGauge key={t.id} t={t} />)}
      <p className="text-sm font-semibold text-slate-700">Din = pichle 7 din ki roz ki sale ke hisaab se. 🟢 3 din se zyada · 🟡 1½–3 din · 🔴 1½ din se kam.</p>
    </div>
  );
}

/** Tiny hook for pages that want a NumPad instead of the phone keyboard in Asaan mode. */
export function useNumPadOn() { const [on] = useAsaan(); const [touch] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches); return on && touch; }

/* ------------------------------------------------------------------ phase 2 ------------------------------------------------------------------ */
/** Internet / unsent-entries status: 🟢 online · 🟡 entries waiting on this device · 🔴 no internet (entries are kept). */
export function SyncDot({ big = false }: { big?: boolean }) {
  const q = useQueueStatus();
  const state = !q.online ? "off" : q.pending > 0 ? "wait" : "ok";
  const txt = state === "off" ? ["Net nahi — entry mehfooz hai", "انٹرنیٹ نہیں — اندراج محفوظ ہے"] : state === "wait" ? [`${q.pending} entry bhejni hain`, "اندراج بھیجے جا رہے ہیں"] : ["Online", "آن لائن"];
  const tone = state === "off" ? "bg-out-bg text-out border-out-ring" : state === "wait" ? "bg-warn-bg text-warn border-warn-ring" : "bg-in-bg text-in border-in-ring";
  if (!big) return (
    <span role="status" title={`${txt[0]} · ${txt[1]}`} className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-bold ${tone}`}>
      <span className={`h-2.5 w-2.5 rounded-full ${state === "off" ? "bg-out" : state === "wait" ? "bg-warn motion-safe:animate-pulse" : "bg-in"}`} />{state === "ok" ? "Online" : state === "wait" ? q.pending : "Net nahi"}
    </span>
  );
  if (state === "ok") return null; // the home screen only speaks up when something is wrong
  return (
    <div role="status" className={`flex items-center gap-3 rounded-2xl border-2 px-4 py-3 ${tone}`}>
      {state === "off" ? <WifiOff size={28} aria-hidden /> : <Wifi size={28} aria-hidden />}
      <span className="text-lg font-extrabold leading-tight">{txt[0]}<Urdu className="block text-base font-normal">{txt[1]}</Urdu></span>
    </div>
  );
}

/** One tap: the shift report PDF to the owner on WhatsApp (falls back to the number picker when no owner number is saved). */
export function OwnerWhatsApp({ shiftId }: { shiftId: number }) {
  const [state, setState] = useState<"idle" | "busy" | "sent" | "pick">("idle");
  const [err, setErr] = useState("");
  const go = async () => {
    setState("busy"); setErr("");
    try {
      const c = await api<any>(`/docs/shift/${shiftId}/contacts`);
      const owner = (c.staff ?? []).find((s: any) => s.role === "owner" || s.role === "admin");
      if (!owner?.phone) { setState("pick"); return; }
      const r = await api<any>(`/docs/shift/${shiftId}/send`, { body: { phones: [owner.phone] } });
      const link = r.results?.find((x: any) => x.ok && x.wa_link)?.wa_link;
      if (link) window.open(link, "_blank", "noopener");
      if (!r.results?.some((x: any) => x.ok)) throw new Error(r.results?.[0]?.error ?? "Nahi gaya");
      setState("sent");
    } catch (e: any) { setErr(e.message); setState("idle"); }
  };
  return (
    <>
      <button type="button" onClick={go} disabled={state === "busy"} className="flex min-h-tap w-full items-center justify-center gap-3 rounded-2xl bg-[#128C7E] px-4 text-act text-white shadow active:scale-[.98] disabled:opacity-70">
        <MessageCircle size={28} aria-hidden /> {state === "sent" ? "Owner ko bhej diya ✅" : state === "busy" ? "Bhej raha hai…" : "Owner ko WhatsApp karein"}
      </button>
      <Urdu className="-mt-2 block text-center text-lg text-ink">{state === "sent" ? "مالک کو بھیج دیا" : "رپورٹ مالک کو واٹس ایپ کریں"}</Urdu>
      {err && <p className="text-center text-base font-bold text-out">{err}</p>}
      {state === "pick" && <WhatsAppDocModal kind="shift" id={shiftId} onClose={() => setState("idle")} />}
    </>
  );
}

/** After an entry: a big ✅, the gist, and the next steps. `undo` adds a "Wapas lo" button for the first 10 seconds. */
export function DoneScreen({ title, ur, lines, children, undo }: { title: string; ur: string; lines?: ReactNode[]; children?: ReactNode; undo?: () => Promise<void> | void }) {
  const [left, setLeft] = useState(undo ? 10 : 0);
  useEffect(() => { if (left <= 0) return; const id = setTimeout(() => setLeft((x) => x - 1), 1000); return () => clearTimeout(id); }, [left]);
  return (
    <div className="space-y-4 text-center">
      <CheckCircle2 size={96} className="mx-auto text-in motion-safe:animate-pop" aria-hidden />
      <div><h2 className="text-3xl font-extrabold text-ink">{title}</h2><Urdu className="text-2xl text-ink">{ur}</Urdu></div>
      {lines && <div className="space-y-1 text-xl font-bold text-ink">{lines.map((l, i) => <div key={i}>{l}</div>)}</div>}
      {children}
      {undo && left > 0 && <button type="button" onClick={() => { setLeft(0); void undo(); }} className="w-full rounded-2xl border-2 border-out-ring py-3 text-act text-out">↩ Wapas lo ({left}) · <Urdu>واپس لیں</Urdu></button>}
      <Link to="/" className="flex min-h-tap items-center justify-center gap-3 rounded-2xl bg-ink text-act text-white"><Home size={26} aria-hidden /> Ghar · <Urdu>گھر</Urdu></Link>
    </div>
  );
}

const NOTE_VALUES = [5000, 1000, 500, 100, 50, 20, 10];
/** Count the notes: one big row per note with − / + and the running total. */
function NoteCounter({ notes, setNotes, loose, setLoose }: { notes: Record<number, number>; setNotes: (n: Record<number, number>) => void; loose: string; setLoose: (v: string) => void }) {
  const total = NOTE_VALUES.reduce((a, d) => a + d * (notes[d] ?? 0), 0) + (Number(loose) || 0);
  const bump = (d: number, by: number) => setNotes({ ...notes, [d]: Math.max(0, (notes[d] ?? 0) + by) });
  return (
    <div className="space-y-2">
      {NOTE_VALUES.map((d) => (
        <div key={d} className="flex items-center gap-2 rounded-2xl border-2 border-slate-200 bg-white p-2">
          <span className="w-20 shrink-0 text-center text-xl font-black tabular-nums text-ink sm:text-2xl">{d}</span>
          <button type="button" aria-label={`${d} ka note kam`} onClick={() => bump(d, -1)} className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-out-bg text-out active:scale-95"><Minus size={28} /></button>
          <input aria-label={`${d} ke note`} inputMode="numeric" className="h-14 w-full min-w-0 rounded-xl border-2 border-slate-300 text-center text-2xl font-black tabular-nums text-ink" value={notes[d] ? String(notes[d]) : ""} placeholder="0"
            onChange={(e) => setNotes({ ...notes, [d]: Math.max(0, Math.floor(Number(e.target.value.replace(/\D/g, "")) || 0)) })} />
          <button type="button" aria-label={`${d} ka note zyada`} onClick={() => bump(d, 1)} className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-in-bg text-in active:scale-95"><Plus size={28} /></button>
        </div>
      ))}
      <label className="flex items-center gap-2 rounded-2xl border-2 border-slate-200 bg-white p-2">
        <span className="w-20 shrink-0 text-center text-base font-bold text-ink">Khula<Urdu className="block text-sm">کھلا</Urdu></span>
        <input inputMode="numeric" className="h-14 w-full min-w-0 rounded-xl border-2 border-slate-300 px-3 text-right text-2xl font-black tabular-nums text-ink" value={loose} placeholder="Rs 0" onChange={(e) => setLoose(e.target.value.replace(/\D/g, ""))} />
      </label>
      <div className="rounded-2xl bg-ink p-3 text-center text-white"><span className="text-base font-bold">Kul gina hua · <Urdu>کل گنا ہوا</Urdu></span><div className="text-num-lg tabular-nums">{pkr(total)}</div></div>
    </div>
  );
}

const ONLINE_NAMES: Record<string, [string, string]> = { card: ["Card machine", "کارڈ مشین"], jazzcash: ["JazzCash", "جاز کیش"], easypaisa: ["Easypaisa", "ایزی پیسہ"], raast: ["Raast / QR", "راست"] };

/**
 * End a shift in big steps: one screen per meter (NumPad), the online money the POS already has, count the notes, then
 * the answer in one line — Barabar / Kam / Zyada — and close. Hard cases (test litres, khata slips not entered, dips,
 * meter reset) stay on the full form, linked from every step.
 */
function StepShell({ children, title, ur, back = true, step, total, onBack }: { children: ReactNode; title: string; ur: string; back?: boolean; step: number; total: number; onBack: () => void }) {
  return (
    <div className="mx-auto max-w-xl space-y-4 pb-24">
      <div className="flex items-center gap-3">
        {back && <button type="button" aria-label="Peeche" onClick={onBack} className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-ink"><ChevronLeft size={32} /></button>}
        <div className="min-w-0"><h1 className="text-2xl font-extrabold text-ink">{title}</h1><Urdu className="text-xl text-ink">{ur}</Urdu></div>
      </div>
      {total > 0 && <div className="flex gap-1.5" aria-label={`Qadam ${step + 1} / ${total}`}>{Array.from({ length: total }, (_, i) => <span key={i} className={`h-2.5 flex-1 rounded-full ${i <= step ? "bg-in" : "bg-slate-200"}`} />)}</div>}
      {children}
    </div>
  );
}
function Next({ ok, label = "Aage", ur = "آگے", onClick }: { ok: boolean; label?: string; ur?: string; onClick: () => void }) {
  return (
    <button type="button" disabled={!ok} onClick={onClick} className="flex min-h-tap-xl w-full items-center justify-center gap-3 rounded-3xl bg-in text-2xl font-extrabold text-white shadow-lg active:scale-[.98] disabled:bg-slate-300 disabled:text-slate-600">
      {label} · <Urdu>{ur}</Urdu> ▶
    </button>
  );
}

export function AsaanCloseShift() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const { data, error } = useApi<any>(id ? `/shifts/${id}/live` : null);
  const queue = useQueueStatus();
  const [step, setStep] = useState(0);
  const [readings, setReadings] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<number, number>>({});
  const [loose, setLoose] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any>(null);

  const nozzles: any[] = data?.readings ?? [];
  const digital = useMemo(() => Object.fromEntries(Object.entries((data?.recorded?.online ?? {}) as Record<string, number>).filter(([, v]) => v > 0)), [data]);
  const body = useMemo(() => ({ readings: Object.fromEntries(Object.entries(readings).map(([k, v]) => [k, Number(v)])), digital }), [readings, digital]);
  const counted = NOTE_VALUES.reduce((a, d) => a + d * (notes[d] ?? 0), 0) + (Number(loose) || 0);
  const N = nozzles.length, ONLINE_STEP = N, NOTES_STEP = N + 1, RESULT_STEP = N + 2;

  // the server works the expected cash out (nothing saved) once every meter is in
  useEffect(() => {
    if (!N || step < ONLINE_STEP) return;
    let live = true;
    api<any>(`/shifts/${id}/preview`, { body }).then((r) => { if (live) { setPreview(r); setErr(""); } }).catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [step >= ONLINE_STEP, JSON.stringify(body)]); // eslint-disable-line react-hooks/exhaustive-deps

  const full = <Link to="/shifts" className="block text-center text-base font-bold text-slate-700 underline">Test litre, khata parchi ya meter kharab? Poora form · <Urdu>پورا فارم</Urdu></Link>;
  // passed as plain props, so the step screen keeps its inputs mounted while typing
  const sp = { step, total: N > 0 && !done ? N + 3 : 0, onBack: () => (step ? setStep(step - 1) : nav("/")) };
  if (error) return <StepShell {...sp} title="Shift band karein" ur="شفٹ ختم کریں"><p className="text-xl font-bold text-out">{String(error)}</p>{full}</StepShell>;
  if (!data) return <StepShell {...sp} title="Shift band karein" ur="شفٹ ختم کریں"><p className="text-xl font-bold text-ink">Load ho raha hai…</p></StepShell>;
  if (data.shift?.status && data.shift.status !== "open" && !done) return <StepShell {...sp} title="Shift pehle hi band hai" ur="شفٹ بند ہو چکی ہے"><Link to="/" className="block rounded-2xl bg-ink py-4 text-center text-act text-white">Ghar · <Urdu>گھر</Urdu></Link></StepShell>;

  if (done) return (
    <div className="mx-auto max-w-xl pb-24">
      <DoneScreen title="Shift band ho gayi" ur="شفٹ بند ہو گئی"
        lines={[`Gina hua cash: ${pkr(counted)}`, done.diff === 0 ? "Hisaab barabar ✅" : done.diff < 0 ? `Kam: ${pkr(-done.diff)}` : `Zyada: ${pkr(done.diff)}`]}>
        <OwnerWhatsApp shiftId={id} />
      </DoneScreen>
    </div>
  );

  // ---- one meter per screen ----
  if (step < N) {
    const r = nozzles[step];
    const last = r.checkpoint ?? r.opening;
    const v = readings[r.nozzle_id] ?? "";
    const bad = v !== "" && Number(v) < last;
    const sold = v !== "" && !bad ? Number(v) - r.opening : null;
    return (
      <StepShell {...sp} title={`Meter ${step + 1} / ${N}`} ur={`میٹر ${step + 1} / ${N}`}>
        <div className="rounded-2xl border-2 border-slate-300 bg-white p-4">
          <div className="flex flex-wrap items-baseline gap-x-2"><span className="text-act text-ink">{r.label}</span><span className="text-lg font-bold text-ink">{PRODUCTS[r.product] ?? r.product}</span><Urdu className="text-lg text-ink">{PRODUCT_UR[r.product] ?? ""}</Urdu></div>
          <div className="mt-1 text-lg font-semibold text-slate-700">Shuru ki reading: <b className="tabular-nums text-ink">{num(last, 2)}</b></div>
        </div>
        <NumPad decimal unit="" value={v} onChange={(x) => setReadings({ ...readings, [r.nozzle_id]: x })} label="Ab meter kya keh raha hai?" ur="آخری میٹر ریڈنگ" max={9_999_999_999} />
        {bad ? <p className="rounded-2xl bg-out-bg p-3 text-center text-xl font-extrabold text-out">Ye shuru se kam hai! Dobara dekhein · <Urdu>دوبارہ دیکھیں</Urdu></p>
          : sold != null && <p className="rounded-2xl bg-in-bg p-3 text-center text-xl font-extrabold text-in">Is meter se: {num(sold, 2)} L · {pkr(sold * (data.prices?.[r.product] ?? 0))}</p>}
        <Next ok={v !== "" && !bad} onClick={() => setStep(step + 1)} />
        {full}
      </StepShell>
    );
  }

  // ---- online money the POS already recorded ----
  if (step === ONLINE_STEP) {
    const rows = Object.entries(digital);
    return (
      <StepShell {...sp} title="Online paisa" ur="آن لائن رقم">
        {queue.pending > 0 && <p className="rounded-2xl bg-warn-bg p-3 text-lg font-extrabold text-warn">{queue.pending} sale abhi is phone se nahi gayi. Net aane ka intezar karein, phir band karein. · <Urdu>پہلے سیل بھیجیں</Urdu></p>}
        {rows.length ? rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between rounded-2xl border-2 border-slate-200 bg-white p-4">
            <span className="text-lg font-bold text-ink">{ONLINE_NAMES[k]?.[0] ?? k}<Urdu className="block text-base font-normal">{ONLINE_NAMES[k]?.[1] ?? ""}</Urdu></span>
            <span className="text-num-lg tabular-nums text-ink">{pkr(v)}</span>
          </div>
        )) : <p className="rounded-2xl bg-slate-100 p-4 text-xl font-bold text-ink">Is shift mein koi online paisa nahi · <Urdu>کوئی آن لائن رقم نہیں</Urdu></p>}
        <p className="text-base font-semibold text-slate-700">Ye POS mein darj card / JazzCash / Easypaisa hai. Ghalat ho to poora form kholein.</p>
        <Next ok={queue.pending === 0} label="Sahi hai" ur="صحیح ہے" onClick={() => setStep(NOTES_STEP)} />
        {full}
      </StepShell>
    );
  }

  // ---- count the notes ----
  if (step === NOTES_STEP) return (
    <StepShell {...sp} title="Note ginein" ur="نوٹ گنیں">
      {preview && Number(preview.cash_expected ?? 0) <= 0 && <p className="rounded-2xl bg-sky-50 p-3 text-lg font-bold text-sky-900">Is shift mein cash nahi bana — 0 par band karein · <Urdu>صفر پر بند کریں</Urdu></p>}
      <NoteCounter notes={notes} setNotes={setNotes} loose={loose} setLoose={setLoose} />
      <Next ok onClick={() => setStep(RESULT_STEP)} />
    </StepShell>
  );

  // ---- the answer, then close ----
  const expected = preview ? Math.round(Number(preview.cash_expected ?? 0)) : null;
  const diff = expected != null ? Math.round(counted - expected) : null;
  const close = async () => {
    // a short shift is real money: say the amount once more before it is booked against the salesman
    if (diff != null && diff < 0 && !confirm(`Cash ${pkr(-diff)} kam hai. Isi ke saath shift band karein?\nکیش کم ہے — پھر بھی بند کریں؟`)) return;
    setBusy(true); setErr("");
    try {
      await api(`/shifts/${id}/close`, { body: { ...body, cash_actual: counted, cash_notes: Object.fromEntries(Object.entries(notes).filter(([, n]) => n > 0).map(([k, n]) => [k, n])) } });
      setDone({ diff });
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const tone = diff == null ? "bg-slate-100 text-ink" : diff === 0 ? "bg-in text-white" : diff < 0 ? "bg-out text-white" : "bg-warn text-white";
  return (
    <StepShell {...sp} title="Hisaab" ur="حساب">
      <MoneyCard en="Hona chahiye" ur="ہونا چاہیے" value={expected} tone="ink" sub="Meter ki sale − online − khata − kharche" />
      <MoneyCard en="Aap ne gina" ur="آپ نے گنا" value={counted} tone="ink" />
      <div className={`rounded-3xl p-5 text-center ${tone}`}>
        {diff == null ? <span className="text-xl font-bold">Hisaab ho raha hai…</span>
          : diff === 0 ? <><div className="text-num-lg">Barabar ✅</div><Urdu className="text-2xl">حساب برابر</Urdu></>
          : diff < 0 ? <><div className="text-num-lg">Kam: {pkr(-diff)}</div><Urdu className="text-2xl">کم ہے</Urdu></>
          : <><div className="text-num-lg">Zyada: {pkr(diff)}</div><Urdu className="text-2xl">زیادہ ہے</Urdu></>}
      </div>
      {diff != null && diff !== 0 && <p className="text-center text-lg font-bold text-ink">Dobara gin lein? <button type="button" className="underline" onClick={() => setStep(NOTES_STEP)}>Note dobara ginein</button></p>}
      {err && <p className="rounded-2xl bg-out-bg p-3 text-lg font-bold text-out">{err}</p>}
      <button type="button" disabled={busy || expected == null || queue.pending > 0} onClick={close}
        className="flex min-h-tap-xl w-full items-center justify-center gap-3 rounded-3xl bg-out text-2xl font-extrabold text-white shadow-lg active:scale-[.98] disabled:bg-slate-300 disabled:text-slate-600">
        <LogOut size={30} aria-hidden /> {busy ? "Band ho rahi hai…" : "Shift band karein"} · <Urdu>شفٹ ختم</Urdu>
      </button>
      {full}
    </StepShell>
  );
}

/* ------------------------------------------------------------------ phase 3 ------------------------------------------------------------------ */
/** "Dhoop mode": white page, black bold text, thick borders, no shadows — readable in direct sunlight. Per device. */
const SUN_KEY = "pumpai_sun";
const sunSubs = new Set<() => void>();
const readSun = () => { try { return localStorage.getItem(SUN_KEY) === "1"; } catch { return false; } };
const applySun = (on: boolean) => { if (typeof document !== "undefined") document.documentElement.classList.toggle("sun", on); };
applySun(readSun()); // before the first paint of any screen
export function useSun(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore((cb) => { sunSubs.add(cb); return () => sunSubs.delete(cb); }, readSun, () => false);
  const set = (x: boolean) => { try { localStorage.setItem(SUN_KEY, x ? "1" : "0"); } catch { /* this visit only */ } applySun(x); sunSubs.forEach((f) => f()); };
  return [on, set];
}
export function SunToggle() {
  const [on, set] = useSun();
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => set(!on)}
      className="flex w-full items-center gap-3 rounded-xl bg-white/10 px-3 py-2.5 text-left text-sm font-semibold text-white hover:bg-white/15">
      <span className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-amber-400" : "bg-white/30"}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
      </span>
      <span className="min-w-0 flex-1 leading-tight">☀️ Dhoop mode<span lang="ur" dir="rtl" className="font-urdu block text-xs font-normal opacity-80">دھوپ میں صاف نظر آئے</span></span>
    </button>
  );
}

/** Plain words for the menu in Asaan mode — no accounting English. */
export const SIMPLE_LABEL: Record<string, string> = {
  "/": "Ghar", "/reports": "Report", "/sales-history": "Purani sale", "/insights": "Malik ki report", "/owner-report": "Nafa nuqsan ka hisaab",
  "/discounts-report": "Riyayat ki report", "/other-entries": "Doosri aamdani / kharcha", "/investors": "Sarmaya kaar", "/margins": "Nafa aur target",
  "/profit": "Munafa kaise bana", "/suggestions": "Mashwaray", "/inbox": "WhatsApp", "/pos": "Sale darj karein", "/shifts": "Shift",
  "/customers": "Gahak", "/khata": "Khata / udhaar", "/prepaid": "Coupon aur wallet", "/card-pending": "Card baad mein",
  "/wholesale": "Wholesale", "/carriage": "Kiraya (carriage)", "/cashier": "Cashier", "/expenses": "Kharche", "/cash": "Galla aur bank",
  "/accounts": "Hisaab kitaab aur tax", "/suppliers": "Supplier (jin ko dena hai)", "/property": "Kiraye ki jaidad", "/orders": "Order",
  "/bookings": "Booking", "/complaints": "Shikayat", "/campaigns": "Paighaam (campaign)", "/stock": "Tank aur tail", "/dip-charts": "Dip chart",
  "/register": "Stock register", "/shop": "Dukaan aur mobil oil", "/prices": "Rate", "/alerts": "Khabardar", "/automations": "Khud-kaar kaam",
  "/staff": "Mulazim ka hisaab", "/kiosk": "Haazri", "/roster": "Duty", "/team": "Rating aur commission", "/checklist": "Roz ki jaanch",
  "/compliance": "License aur jaanch", "/machines": "Machine", "/my-account": "Mera hisaab", "/help": "Madad", "/users": "Users aur ikhtiyar",
  "/audit": "Kis ne kya badla", "/security": "Hifazat", "/corrections": "Ghalti theek karein", "/go-live": "Shuru karne ki list",
  "/opening-balances": "Purana hisaab", "/lists": "Fehristein", "/settings": "Settings",
};

/** Owner / manager home in Asaan mode: four ledger cards in a fixed order, the tanks, today in one line. */
export function AsaanOwnerHome() {
  const { user, modules } = useAuth();
  const o = useApi<any>("/owner/overview", 120_000);
  const h = useHome();
  const d = o.data;
  const tanks: any[] = h.data?.tanks ?? [];
  const t = d?.today;
  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-28">
      <SyncDot big />
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0"><h1 className="truncate text-2xl font-extrabold text-ink">Salam, {user?.name?.split(" ")[0]}</h1><Urdu className="text-lg text-ink">آج کا حساب ایک نظر میں</Urdu></div>
        <button type="button" onClick={() => { o.reload(); h.reload(); }} className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-ink" aria-label="Taaza karein"><RefreshCw size={26} /></button>
      </div>
      {tanks.length > 0 && <TankBanner tanks={tanks} />}
      {o.error ? <p className="text-lg font-bold text-out">{String(o.error)}</p> : !d ? <p className="text-lg font-semibold text-slate-700">Load ho raha hai…</p> : <>
        <div className="grid gap-3 sm:grid-cols-2">
          <MoneyCard en="Galla + Bank" ur="ہاتھ میں اور بینک میں" value={d.money.total} tone="in"
            sub={`Galla ${pkr(d.money.office_cash)} · Salesman ke paas ${pkr(d.money.with_salesmen)} · Bank ${pkr(d.money.banks)}`} />
          <MoneyCard en="Aaj ka munafa" ur="آج کا منافع" value={t?.profit_estimate ?? null} tone={(t?.profit_estimate ?? 0) >= 0 ? "in" : "out"}
            sub={t ? `Aaj ki sale ${pkr(t.sale)} · ${num((t.retail_litres ?? 0) + (t.wholesale_litres ?? 0))} L` : undefined} />
          <MoneyCard en="Udhaar baqi (lena hai)" ur="ادھار باقی — لینا ہے" value={d.owed_to_us.total} tone="out"
            sub={[modules.khata !== false ? `Khata ${pkr(d.owed_to_us.khata)}` : null, modules.wholesale ? `Wholesale ${pkr(d.owed_to_us.wholesale)}` : null].filter(Boolean).join(" · ") || undefined} />
          <MoneyCard en="Humne dena hai" ur="ہم نے دینا ہے" value={d.we_owe.total} tone="out"
            sub={`Supplier ${pkr(round0(d.we_owe.suppliers + d.we_owe.bypass_suppliers))}${d.we_owe.pending_expenses > 0 ? ` · Kharche ${pkr(d.we_owe.pending_expenses)}` : ""}`} />
        </div>
        {d.month && <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-2xl border-2 border-slate-300 bg-white px-4 py-3">
          <span className="text-lg font-bold text-ink">Is mahine ka asal munafa<Urdu className="block text-base font-normal">اس مہینے کا اصل منافع</Urdu></span>
          <span className={`text-num-lg tabular-nums ${d.month.net_profit >= 0 ? "text-in" : "text-out"}`}>{pkr(d.month.net_profit)}</span>
        </div>}
      </>}
      {tanks.length > 0 && (
        <Link to="/tanks-level" className="block rounded-2xl border-2 border-slate-300 bg-white p-3">
          <div className="mb-2 flex items-baseline justify-between"><span className="text-lg font-bold text-ink">Tank · <Urdu>ٹینک</Urdu></span><span className="text-sm font-bold text-slate-700">Sab dekhein ›</span></div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {tanks.slice(0, 6).map((k) => <TankChip key={k.id} t={k} station={new Set(tanks.map((x) => x.station_name)).size > 1} />)}
          </div>
        </Link>
      )}
      <Link to="/dashboard" className="flex min-h-tap items-center justify-center gap-2 rounded-2xl bg-ink text-act text-white">Tafseeli dashboard › <Urdu className="text-lg font-normal">تفصیلی ڈیش بورڈ</Urdu></Link>
    </div>
  );
}
const round0 = (n: number) => Math.round(n);
function TankChip({ t, station }: { t: any; station?: boolean }) {
  const L = LIGHT[t.light as keyof typeof LIGHT] ?? LIGHT.green;
  return (
    <div className={`rounded-xl border-2 p-2 ${L.bg}`}>
      <div className="flex items-baseline justify-between gap-1"><span className="truncate text-base font-extrabold text-ink">{PRODUCTS[t.product] ?? t.product}</span><span className={`text-sm font-black ${L.text}`}>{t.pct}%</span></div>
      <div className="mt-1 h-3 overflow-hidden rounded-full bg-white ring-1 ring-slate-300"><div className={`h-full ${L.bar}`} style={{ width: `${Math.max(3, t.pct)}%` }} /></div>
      <div className={`mt-1 text-sm font-bold ${L.text}`}>{t.days_left != null ? `${daysText(t.days_left)}` : `${num(t.current_l)} L`}</div>
      {station && <div className="truncate text-xs font-semibold text-slate-700">{t.station_name}</div>}
    </div>
  );
}
