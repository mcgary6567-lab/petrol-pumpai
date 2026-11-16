/**
 * The Print button, system-wide.
 *
 * On a computer this is plain window.print(). Many phones do nothing on window.print(): the app opened inside WhatsApp /
 * Facebook, some installed-app windows, older iPhones. There the button looked dead. So on a phone we ask for print,
 * and if the print screen has not opened within a moment, a small sheet offers the ways that always work:
 *   - the PDF of this paper (the phone opens it in its PDF viewer: Print, Share, Save) — when the page has one;
 *   - the same paper on its own in a new tab (open it in Chrome and print from there).
 */
const onPhone = () => window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 768;

export type PrintOpts = { pdf?: string | null; title?: string };

export function printNow(opts: PrintOpts = {}) {
  if (!onPhone()) { window.print(); return; }
  let opened = false;
  const mark = () => { opened = true; };
  window.addEventListener("beforeprint", mark, { once: true });
  const mq = window.matchMedia("print");
  const onMq = (e: MediaQueryListEvent) => { if (e.matches) opened = true; };
  mq.addEventListener?.("change", onMq);
  try { window.print(); } catch { /* no print here */ }
  setTimeout(() => {
    window.removeEventListener("beforeprint", mark);
    mq.removeEventListener?.("change", onMq);
    if (!opened) fallback(opts);
  }, 1200);
}

/** What prints: the top open dialog's card, else the page. */
function printable(): HTMLElement | null {
  const dialogs = [...document.querySelectorAll<HTMLElement>('body > [role="dialog"]')];
  const top = dialogs[dialogs.length - 1];
  return (top?.querySelector<HTMLElement>(".card") ?? top) || document.querySelector<HTMLElement>("main");
}

/** The paper on its own page: the app's own styles, only what prints (no buttons, phone cards swapped for the table). */
function paperHtml(title: string): string {
  const src = printable();
  if (!src) return "";
  const c = src.cloneNode(true) as HTMLElement;
  c.querySelectorAll('[class*="print:hidden"], button, [role="group"], input[type="search"]').forEach((n) => n.remove());
  // a page can hold two papers (khata: statement / purchase bill): keep the one asked for
  if (document.body.classList.contains("print-purchase")) { c.querySelectorAll(".khata-main, .modal-title, .client-bill").forEach((n) => n.remove()); c.querySelectorAll(".purchase-bill").forEach((n) => n.classList.remove("hidden")); }
  else c.querySelectorAll(".purchase-bill").forEach((n) => n.remove());
  c.querySelectorAll<HTMLElement>('[class*="print:block"], [class*="print:table"], [class*="print:flex"]').forEach((n) => n.classList.remove("hidden"));
  c.querySelectorAll<HTMLElement>('[class*="max-h-"]').forEach((n) => { n.style.maxHeight = "none"; n.style.overflow = "visible"; });
  const styles = [...document.querySelectorAll('link[rel="stylesheet"], style')].map((n) => n.outerHTML).join("");
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><base href="${location.origin}/">${styles}
<style>body{background:#fff;padding:12px}.pbar{position:sticky;top:0;z-index:5;display:flex;gap:8px;align-items:center;justify-content:space-between;background:#0f172a;color:#fff;padding:8px 10px;border-radius:12px;margin-bottom:12px;font:600 14px system-ui}
.pbar button{border:0;border-radius:10px;padding:10px 14px;font:600 14px system-ui}.pbar .go{background:#059669;color:#fff}.pbar .x{background:#334155;color:#fff}.pmsg{display:none;margin:0 0 12px;padding:10px 12px;border-radius:10px;background:#fef3c7;color:#78350f;font:14px system-ui}
@media print{.pbar,.pmsg{display:none!important}body{padding:0}}</style></head><body>
<div class="pbar"><button class="x" onclick="window.close()">✕ Close</button><span>${esc(title)}</span><button class="go" id="go">🖨 Print / PDF</button></div>
<div class="pmsg" id="msg">Is app mein print nahi khulta. Upar ⋮ menu se <b>"Open in Chrome"</b> karein, phir Print dabayein — ya ⋮ → Share → Print.</div>
${c.outerHTML}
<script>document.getElementById("go").onclick=function(){var ok=false;addEventListener("beforeprint",function(){ok=true},{once:true});try{print()}catch(e){}setTimeout(function(){if(!ok)document.getElementById("msg").style.display="block"},1200)};</script>
</body></html>`;
}

function openPaperTab(title: string) {
  const html = paperHtml(title);
  const w = window.open("", "_blank");
  if (!w) { alert("Naya tab nahi khula — browser ne rok diya. Pop-up allow karein."); return; }
  w.document.open(); w.document.write(html); w.document.close();
}

function fallback(opts: PrintOpts) {
  if (document.getElementById("pn-sheet")) return;
  const title = opts.title || document.querySelector('body > [role="dialog"]:last-of-type')?.getAttribute("aria-label") || document.title || "Print";
  const dark = document.documentElement.classList.contains("dark");
  const back = document.createElement("div");
  back.id = "pn-sheet";
  back.setAttribute("role", "alertdialog");
  back.setAttribute("aria-label", "Print");
  back.className = "print:hidden";
  back.style.cssText = "position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.45);display:flex;align-items:flex-end;justify-content:center";
  const bg = dark ? "#111c2e" : "#fff", fg = dark ? "#e5edf7" : "#0f172a", sub = dark ? "#94a3b8" : "#475569";
  back.innerHTML = `<div style="background:${bg};color:${fg};width:100%;max-width:480px;border-radius:16px 16px 0 0;padding:16px;box-shadow:0 -10px 40px rgba(0,0,0,.25);font-family:inherit">
    <div style="font-weight:700;font-size:16px">Print nahi khula · <span lang="ur" class="font-urdu">پرنٹ نہیں کھلا</span></div>
    <p style="margin:6px 0 12px;font-size:14px;color:${sub}">Is phone / app mein seedha print nahi chalta. Neeche se kholein — wahan se Print, PDF ya WhatsApp share ho jaega.</p>
    <div style="display:grid;gap:8px">
      ${opts.pdf ? `<button type="button" data-a="pdf" style="min-height:48px;border:0;border-radius:12px;background:#059669;color:#fff;font-weight:600;font-size:15px">📄 PDF kholein (print / share)</button>` : ""}
      <button type="button" data-a="tab" style="min-height:48px;border:0;border-radius:12px;background:${opts.pdf ? (dark ? "#172338" : "#f1f5f9") : "#059669"};color:${opts.pdf ? fg : "#fff"};font-weight:600;font-size:15px">🗒 Naye tab mein kholein</button>
      <button type="button" data-a="x" style="min-height:44px;border:0;border-radius:12px;background:none;color:${sub};font-size:14px">Band karein</button>
    </div></div>`;
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey); };
  document.addEventListener("keydown", onKey);
  back.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("[data-a]")?.getAttribute("data-a");
    if (e.target === back || a === "x") { close(); return; }
    if (a === "pdf" && opts.pdf) { close(); const w = window.open(opts.pdf, "_blank"); if (!w) location.href = opts.pdf; }
    if (a === "tab") { close(); openPaperTab(title); }
  });
  document.body.appendChild(back);
}
