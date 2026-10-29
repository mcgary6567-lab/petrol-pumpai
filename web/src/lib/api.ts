import { useCallback, useEffect, useRef, useState } from "react";

const TOKEN_KEY = "pumpai_token";
export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t: string | null) => {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ }
  // the offline copy of API reads belongs to the person who was signed in: never show it to the next one
  try { navigator.serviceWorker?.controller?.postMessage("clear-api-cache"); caches?.delete("pumpai-api-v1").catch(() => {}); } catch { /* no SW / private mode */ }
};

/* ---- offline: the service worker answers API reads from its last copy when the net is gone, marked x-pumpai-offline ---- */
let offlineSince: number | null = null;
const offlineListeners = new Set<(v: number | null) => void>();
const setOffline = (v: boolean) => {
  const next = v ? (offlineSince ?? Date.now()) : null;
  if (next === offlineSince) return;
  offlineSince = next;
  offlineListeners.forEach((f) => f(offlineSince));
};
if (typeof window !== "undefined") {
  window.addEventListener("offline", () => setOffline(true));
  window.addEventListener("online", () => { setOffline(false); notifyChanged(); });
}
/** true while the app is showing its offline copy (or the browser says there is no connection). */
export function useOffline() {
  const [since, setSince] = useState<number | null>(offlineSince ?? (typeof navigator !== "undefined" && !navigator.onLine ? Date.now() : null));
  useEffect(() => { offlineListeners.add(setSince); return () => { offlineListeners.delete(setSince); }; }, []);
  return { offline: since != null, since };
}

/** Short-lived read-only token for links the browser opens by itself (photos, downloads, live feed) — never the session. */
let media = "";
export const setMediaToken = (t: string | null | undefined) => { media = t ?? ""; };
export const linkToken = () => encodeURIComponent(media);

export class ApiError extends Error { retryAfter?: number; constructor(public status: number, message: string, retryAfter?: number) { super(message); this.retryAfter = retryAfter; } }

/* ---- live data: after any write, every list / total on screen refreshes by itself (no browser reload) ---- */
/** This tab's id: its own writes are announced back on /live too — those are skipped (already refreshed locally). */
export const CLIENT_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
const listeners = new Set<() => void>();
let changeTimer: ReturnType<typeof setTimeout> | null = null;
/** Tell every mounted useApi to refetch (debounced: a burst of writes = one refresh). */
export function notifyChanged() {
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => { changeTimer = null; for (const l of [...listeners]) { try { l(); } catch { /* one bad listener must not stop the rest */ } } }, 350);
}
export const onDataChanged = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

const DEVICE_KEY = "pumpai_device";
/** Links this tablet to the business so staff can sign in with name + PIN. */
export const getDevice = () => { try { return localStorage.getItem(DEVICE_KEY); } catch { return null; } };
export const setDevice = (t: string | null) => { try { t ? localStorage.setItem(DEVICE_KEY, t) : localStorage.removeItem(DEVICE_KEY); } catch { /* storage blocked */ } };

/* ---- PIN before a cancel: the server answers 428 + code, the app asks the person for their PIN and sends it again ---- */
export type PinCode = "pin_required" | "pin_wrong" | "pin_not_set";
let pinAsker: ((code: PinCode, message: string) => Promise<string | null>) | null = null;
export const setPinAsker = (f: typeof pinAsker) => { pinAsker = f; };

/** Identical GETs already on their way share one request (after a write, several cards on one screen ask for the same list). */
const inflight = new Map<string, Promise<any>>();
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  if ((opts.method ?? (opts.body ? "POST" : "GET")) === "GET" && !opts.headers) {
    const key = path;
    const hit = inflight.get(key);
    if (hit) return hit as Promise<T>;
    const p = apiNow<T>(path, opts).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }
  return apiNow<T>(path, opts);
}
async function apiNow<T = any>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    // never let the browser / a proxy serve a stale GET — reports must show the latest entry at once
    cache: "no-store",
    headers: { "content-type": "application/json", "x-client-id": CLIENT_ID, ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    setOffline(true);
    throw new ApiError(0, "Internet nahi hai — ye entry save nahi hui. Net aane par dobara karein (POS ki fuel sales khud mehfooz rehti hain).");
  }
  const data = await res.json().catch(() => ({}));
  if (res.headers.get("x-pumpai-offline")) setOffline(true); else if (res.ok) setOffline(false);
  // a write that went through: every screen in this tab refreshes (other tabs / devices hear it on /live)
  if (res.ok && (opts.method ?? (opts.body ? "POST" : "GET")) !== "GET") notifyChanged();
  if (res.status === 401 && !path.startsWith("/auth/")) {
    setToken(null);
    window.location.href = "/login";
  }
  if (res.status === 428 && pinAsker && ["pin_required", "pin_wrong", "pin_not_set"].includes(data.code)) {
    const pin = await pinAsker(data.code, data.error);
    if (!pin) throw new ApiError(428, "Mansookh nahi hua — PIN nahi diya");
    return apiNow<T>(path, { ...opts, headers: { ...opts.headers, "x-action-pin": pin } });
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, Number(data.retry_after) || undefined);
  return data as T;
}

/** Fetch on mount + manual reload; optional polling. */
export function useApi<T = any>(path: string | null, pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pathRef = useRef(path);
  pathRef.current = path;
  const reload = useCallback(async () => {
    if (!pathRef.current) return;
    try {
      const d = await api<T>(pathRef.current);
      setData(d);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    setLoading(true);
    setData(null); setError(null); // a new path never flashes the previous one's rows
    reload();
    if (!pollMs) return;
    const id = setInterval(reload, pollMs);
    return () => clearInterval(id);
  }, [path, pollMs, reload]);
  // any write anywhere (this tab or, via /live, another tab / device) → refetch silently; the old rows stay until the new ones land
  useEffect(() => onDataChanged(() => { if (pathRef.current && document.visibilityState !== "hidden") reload(); }), [reload]);
  return { data, error, loading, reload, setData };
}

/** Mount once (Layout): listens to the server's /live feed and turns other tabs' / devices' writes into a refresh here;
 *  also refreshes when the tab comes back to the foreground (a phone that slept through a few entries). */
export function useLiveData() {
  useEffect(() => {
    if (!getToken()) return;
    let es: EventSource | null = null, retry: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      if (!media || es) return;
      es = new EventSource(`/api/live?token=${linkToken()}`);
      es.onmessage = (m) => { try { const e = JSON.parse(m.data); if (e.type === "changed" && e.client !== CLIENT_ID) notifyChanged(); } catch { /* ignore */ } };
      es.onerror = () => { es?.close(); es = null; if (!retry) retry = setTimeout(() => { retry = null; open(); }, 5000); };
    };
    open();
    const wait = setInterval(() => { if (!es) open(); }, 3000); // the media token arrives a moment after login
    const onVis = () => { if (document.visibilityState === "visible") { notifyChanged(); if (!es) open(); } };
    document.addEventListener("visibilitychange", onVis);
    return () => { es?.close(); if (retry) clearTimeout(retry); clearInterval(wait); document.removeEventListener("visibilitychange", onVis); };
  }, []);
}

/* One shared /events connection per tab, whatever number of screens listen (browsers allow only ~6 connections per site). */
const eventSubs = new Set<(e: any) => void>();
let eventsEs: EventSource | null = null, eventsRetry: ReturnType<typeof setTimeout> | null = null;
function ensureEvents() {
  if (eventsEs || !eventSubs.size || !getToken()) return;
  // the media token arrives a moment after login: try again shortly until it is there
  if (!media) { if (!eventsRetry) eventsRetry = setTimeout(() => { eventsRetry = null; ensureEvents(); }, 1500); return; }
  eventsEs = new EventSource(`/api/events?token=${linkToken()}`);
  eventsEs.onmessage = (m) => { let e: any; try { e = JSON.parse(m.data); } catch { return; } for (const f of [...eventSubs]) { try { f(e); } catch { /* one bad listener must not stop the rest */ } } };
  eventsEs.onerror = () => { eventsEs?.close(); eventsEs = null; if (!eventsRetry) eventsRetry = setTimeout(() => { eventsRetry = null; ensureEvents(); }, 5000); };
}
/** Subscribe to server-sent live events (new WhatsApp messages, orders...). */
export function useLiveEvents(onEvent: (e: any) => void, enabled = true) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (!enabled) return;
    const f = (e: any) => cb.current(e);
    eventSubs.add(f);
    ensureEvents();
    return () => { eventSubs.delete(f); if (!eventSubs.size) { eventsEs?.close(); eventsEs = null; } };
  }, [enabled]);
}
