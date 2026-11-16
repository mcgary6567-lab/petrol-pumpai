/**
 * Search in every long dropdown, system-wide (client, customer, supplier, tanker, item …).
 *
 * A phone's own dropdown is a bare scrolling list: with 200 clients nobody finds "Zafar". So a <select> with many
 * options opens this sheet instead: a search box on top, the options below, tap to pick. It works on the select that is
 * already on the page (no page has to change): the pick is written into the select and a normal "change" event is
 * fired, so React and every form see it exactly as if the native list was used.
 *
 * Short lists (fuel, yes/no …) stay native. A select can opt out with data-native.
 */
const MIN_OPTIONS = 8;
const MOVE_PX = 10;

const isBig = (el: Element | null | undefined): el is HTMLSelectElement =>
  el instanceof HTMLSelectElement && !el.multiple && !el.disabled && !el.dataset.native && el.options.length >= MIN_OPTIONS;
const selectOf = (t: EventTarget | null) => (t instanceof Element ? t.closest("select") : null);

const CSS = `
.ss-back{position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.45);display:flex;align-items:flex-end;justify-content:center}
@media (min-width:640px){.ss-back{align-items:flex-start;padding-top:10vh}}
.ss-panel{background:#fff;color:#0f172a;width:100%;max-width:480px;max-height:82vh;display:flex;flex-direction:column;border-radius:16px 16px 0 0;box-shadow:0 20px 50px rgba(0,0,0,.3);overflow:hidden;font-family:inherit}
@media (min-width:640px){.ss-panel{border-radius:16px;max-height:70vh}}
.ss-head{display:flex;align-items:center;gap:8px;padding:12px 12px 8px;border-bottom:1px solid #e2e8f0}
.ss-title{flex:1;font-weight:600;font-size:15px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ss-x{border:0;background:#f1f5f9;border-radius:10px;width:40px;height:40px;font-size:18px;color:#475569;cursor:pointer}
.ss-q{margin:8px 12px;padding:10px 12px;font-size:16px;border:1px solid #cbd5e1;border-radius:10px;outline:none;background:#fff;color:inherit}
.ss-q:focus{border-color:#059669;box-shadow:0 0 0 3px rgba(5,150,105,.15)}
.ss-count{padding:0 14px 6px;font-size:12px;color:#64748b}
.ss-list{overflow-y:auto;overscroll-behavior:contain;padding:0 6px 10px;-webkit-overflow-scrolling:touch}
.ss-grp{padding:10px 10px 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#64748b}
.ss-opt{display:flex;align-items:center;gap:8px;width:100%;min-height:46px;padding:10px 12px;border:0;background:none;text-align:left;font-size:15px;color:inherit;border-radius:10px;cursor:pointer}
.ss-opt:hover,.ss-opt.ss-act{background:#f1f5f9}
.ss-opt.ss-on{background:#ecfdf5;color:#065f46;font-weight:600}
.ss-opt:disabled{color:#94a3b8;cursor:default}
.ss-opt .ss-tick{margin-left:auto;color:#059669}
.ss-none{padding:24px;text-align:center;color:#64748b;font-size:14px}
.dark .ss-panel{background:#111c2e;color:#e5edf7}
.dark .ss-head{border-color:#24344d}
.dark .ss-x{background:#172338;color:#cbd5e1}
.dark .ss-q{background:#0f1a2b;border-color:#2a3b56}
.dark .ss-opt:hover,.dark .ss-opt.ss-act{background:#172338}
.dark .ss-opt.ss-on{background:rgba(16,185,129,.18);color:#6ee7b7}
`;

/** What the list is for: its aria-label, its <label>, the label text just above it, else the "— client —" placeholder. */
function titleOf(sel: HTMLSelectElement): string {
  const aria = sel.getAttribute("aria-label");
  if (aria) return aria;
  const lab = sel.labels?.[0] ?? sel.closest("label");
  const own = lab?.querySelector(".label")?.textContent || (lab && lab.textContent && lab.textContent.replace(sel.textContent ?? "", "").trim());
  if (own) return own.slice(0, 60);
  const first = sel.options[0];
  if (first && !first.value) return first.text.replace(/[—–-]/g, "").trim() || "Chunein";
  return "Chunein · چنیں";
}
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
const digits = (s: string) => s.replace(/\D/g, "");

let openNow = false;

function open(sel: HTMLSelectElement) {
  if (openNow) return;
  openNow = true;
  const dark = document.documentElement.classList.contains("dark");
  const back = document.createElement("div");
  back.className = `ss-back${dark ? " dark" : ""}`;
  back.setAttribute("role", "presentation");
  const panel = document.createElement("div");
  panel.className = "ss-panel";
  panel.setAttribute("role", "listbox");
  const title = titleOf(sel);
  panel.setAttribute("aria-label", title);
  panel.innerHTML = `<div class="ss-head"><div class="ss-title"></div><button type="button" class="ss-x" aria-label="Band karein">✕</button></div>
    <input class="ss-q" type="search" enterkeyhint="search" autocomplete="off" placeholder="Dhoondein… · تلاش کریں" aria-label="Dhoondein">
    <div class="ss-count"></div><div class="ss-list"></div>`;
  (panel.querySelector(".ss-title") as HTMLElement).textContent = title;
  back.appendChild(panel);
  document.body.appendChild(back);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";

  const q = panel.querySelector(".ss-q") as HTMLInputElement;
  const list = panel.querySelector(".ss-list") as HTMLElement;
  const count = panel.querySelector(".ss-count") as HTMLElement;
  // every option once, with the optgroup it sits in
  const all = [...sel.options].filter((o) => !o.hidden).map((o, i) => ({ o, i, text: o.text, key: norm(`${o.text} ${o.value}`), num: digits(o.text), group: o.parentElement instanceof HTMLOptGroupElement ? o.parentElement.label : "" }));
  let shown = all;
  let act = -1;

  const close = () => {
    openNow = false;
    document.body.style.overflow = prevOverflow;
    back.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const pick = (o: HTMLOptionElement) => {
    if (o.disabled) return;
    const changed = sel.value !== o.value;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(sel, o.value);
    close();
    if (changed) { sel.dispatchEvent(new Event("input", { bubbles: true })); sel.dispatchEvent(new Event("change", { bubbles: true })); }
    // a mouse user keeps the keyboard on the field; on a phone a focus could pop the native list up again
    if (!matchMedia("(pointer: coarse)").matches) sel.focus({ preventScroll: true });
  };
  const render = () => {
    list.textContent = "";
    let lastGroup = "";
    shown.forEach((x, n) => {
      if (x.group && x.group !== lastGroup) { const g = document.createElement("div"); g.className = "ss-grp"; g.textContent = x.group; list.appendChild(g); lastGroup = x.group; }
      const b = document.createElement("button");
      b.type = "button";
      b.className = `ss-opt${x.o.value === sel.value && x.o.value !== "" ? " ss-on" : ""}${n === act ? " ss-act" : ""}`;
      b.disabled = x.o.disabled;
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(x.o.value === sel.value));
      b.textContent = x.text || "—";
      if (x.o.value === sel.value && x.o.value !== "") { const t = document.createElement("span"); t.className = "ss-tick"; t.textContent = "✓"; b.appendChild(t); }
      b.addEventListener("click", () => pick(x.o));
      list.appendChild(b);
    });
    if (!shown.length) { const e = document.createElement("div"); e.className = "ss-none"; e.textContent = "Kuch nahi mila · کچھ نہیں ملا"; list.appendChild(e); }
    count.textContent = q.value.trim() ? `${shown.filter((x) => x.o.value !== "").length} mile · ${all.length} mein se` : `${all.filter((x) => x.o.value !== "").length} · type karke dhoondein`;
  };
  const filter = () => {
    const words = norm(q.value).trim().split(/\s+/).filter(Boolean);
    const d = digits(q.value);
    shown = !words.length ? all : all.filter((x) => words.every((w) => x.key.includes(w)) || (d.length >= 3 && x.num.includes(d)));
    act = shown.length && words.length ? shown.findIndex((x) => !x.o.disabled) : -1;
    render();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return;
      act = (act + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      render();
      list.querySelectorAll(".ss-opt")[act]?.scrollIntoView({ block: "nearest" });
    }
    if (e.key === "Enter" && document.activeElement === q) { e.preventDefault(); const x = shown[act >= 0 ? act : 0]; if (x) pick(x.o); }
  };
  q.addEventListener("input", filter);
  panel.querySelector(".ss-x")!.addEventListener("click", close);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  document.addEventListener("keydown", onKey, true);
  render();
  // scroll the chosen one into view, then put the cursor in the search box
  list.querySelector(".ss-on")?.scrollIntoView({ block: "center" });
  setTimeout(() => q.focus(), 30);
}

export function installSelectSearch() {
  if (typeof document === "undefined" || (window as any).__selectSearch) return;
  (window as any).__selectSearch = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  // touch: a tap (not a scroll that started on the field) opens the sheet; stopping the tap's default keeps the
  // phone's own list from opening
  let start: { sel: HTMLSelectElement; x: number; y: number } | null = null;
  document.addEventListener("touchstart", (e) => {
    const s = selectOf(e.target);
    start = isBig(s) ? { sel: s, x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { capture: true, passive: true });
  document.addEventListener("touchend", (e) => {
    if (!start) return;
    const t = e.changedTouches[0];
    const s = start; start = null;
    if (Math.abs(t.clientX - s.x) > MOVE_PX || Math.abs(t.clientY - s.y) > MOVE_PX) return;
    if (selectOf(e.target) !== s.sel || !isBig(s.sel)) return;
    e.preventDefault();
    open(s.sel);
  }, { capture: true, passive: false });
  // mouse
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const s = selectOf(e.target);
    if (!isBig(s)) return;
    e.preventDefault();
    open(s);
  }, true);
  // keyboard: the native list stays (arrows, type-ahead); Alt+Down or F4 on a long list opens the search
  document.addEventListener("keydown", (e) => {
    const s = selectOf(e.target);
    if (isBig(s) && ((e.altKey && e.key === "ArrowDown") || e.key === "F4")) { e.preventDefault(); open(s); }
  }, true);
}
