import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { installSelectSearch } from "./lib/selectSearch";

// the pump this browser belongs to (its /p/<slug> link, or the last sign-in): the install-app manifest must be that pump's from the first paint
try {
  const q = new URLSearchParams(location.search).get("pump") || localStorage.getItem("pumpai_pump");
  if (q) {
    const slug = encodeURIComponent(q.toLowerCase());
    document.querySelector('link[rel="manifest"]')?.setAttribute("href", `/manifest.webmanifest?pump=${slug}`);
    document.querySelector('link[rel="apple-touch-icon"]')?.setAttribute("href", `/branding/icon-180.png?pump=${slug}`);
    document.querySelector('link[rel="icon"]')?.setAttribute("href", `/branding/icon-64.png?pump=${slug}`);
  }
} catch { /* private mode */ }

// Theme: apply the saved choice before first paint (default: light). Dark mode is opt-in from the menu.
try { if (localStorage.getItem("pumpai.theme") === "dark") document.documentElement.classList.add("dark"); } catch { /* private mode */ }

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Number inputs, system-wide: phone keypad (inputmode) even for inputs built without it, and no value change by
// mouse wheel or arrow keys — a figure typed into a money box must stay exactly as typed.
const isNum = (el: Element | null): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === "number";
// a decimal box takes as many decimals as typed (litres / rate like 12.345): a box with no step would refuse "12.5" on Save
const anyStep = (el: Element) => { if (el.getAttribute("inputmode") === "decimal" && !el.hasAttribute("step")) el.setAttribute("step", "any"); };
const keypad = (root: ParentNode) => { root.querySelectorAll('input[type="number"]:not([inputmode])').forEach((el) => el.setAttribute("inputmode", "decimal")); root.querySelectorAll('input[type="number"]').forEach(anyStep); };
keypad(document);
new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) if (n instanceof HTMLElement) { if (isNum(n)) { n.setAttribute("inputmode", "decimal"); anyStep(n); } else keypad(n); } })
  .observe(document.documentElement, { childList: true, subtree: true });
// a preloaded script of the new page could not load (old version open during an update): reload once, not a blank screen
window.addEventListener("vite:preloadError", (e) => {
  let last = 0;
  try { last = Number(sessionStorage.getItem("pumpai_chunk_reload") || 0); } catch { /* storage blocked */ }
  if (Date.now() - last > 60_000) { e.preventDefault(); try { sessionStorage.setItem("pumpai_chunk_reload", String(Date.now())); } catch { /* blocked */ } window.location.reload(); }
});
// long dropdowns (client, customer, supplier …) get a search box
installSelectSearch();
document.addEventListener("wheel", () => { if (isNum(document.activeElement)) document.activeElement.blur(); }, { passive: true });
document.addEventListener("keydown", (e) => { if ((e.key === "ArrowUp" || e.key === "ArrowDown") && isNum(e.target as Element)) e.preventDefault(); });

// keep the app shell available offline (production build only; dev uses Vite's server)
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => { /* not critical */ }));
}
