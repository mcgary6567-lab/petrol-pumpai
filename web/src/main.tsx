import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

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
const keypad = (root: ParentNode) => root.querySelectorAll('input[type="number"]:not([inputmode])').forEach((el) => el.setAttribute("inputmode", "decimal"));
keypad(document);
new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) if (n instanceof HTMLElement) { if (isNum(n)) n.setAttribute("inputmode", "decimal"); else keypad(n); } })
  .observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener("wheel", () => { if (isNum(document.activeElement)) document.activeElement.blur(); }, { passive: true });
document.addEventListener("keydown", (e) => { if ((e.key === "ArrowUp" || e.key === "ArrowDown") && isNum(e.target as Element)) e.preventDefault(); });

// keep the app shell available offline (production build only; dev uses Vite's server)
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => { /* not critical */ }));
}
