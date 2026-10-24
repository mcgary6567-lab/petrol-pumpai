/**
 * Backups + cloud copies (Google Drive / Dropbox). One component, two homes: the pump's Settings page on a single-pump install
 * (request = the normal api) and the SaaS platform panel (request = the platform-token fetch, base = "/platform/backups").
 */
import { useCallback, useEffect, useState } from "react";
import { useAction } from "./ui";

export type Req = (path: string, init?: { method?: string; body?: unknown }) => Promise<any>;

export function BackupsPanel({ request, base, downloadUrl, canRestart = false, title = "Backups" }: { request: Req; base: string; downloadUrl: (name: string) => string; canRestart?: boolean; title?: string }) {
  const [data, setData] = useState<any>(null);
  const reload = useCallback(() => { request(base).then(setData).catch(() => setData(null)); }, [request, base]);
  useEffect(() => { reload(); }, [reload]);
  const { busy, run } = useAction();
  if (!data) return null;
  return (
    <div className="card p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2"><h2 className="font-semibold">{title}</h2><span className="text-xs text-slate-500">Every night at 2:30am · last 14 kept · {data.dir}</span>
        <button className="btn-secondary ml-auto" disabled={busy} onClick={() => run(() => request(base, { body: {} }), "Backup made").then(reload)}>Back up now</button></div>
      {data.restore_pending && <div className="mb-2 flex items-center gap-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-800">A restore is ready — restart the app to finish it.
        {data.can_restart && canRestart && <button className="btn-primary ml-auto !py-1" onClick={() => run(() => request("/system/restart", { body: {} }), "Restarting — page reloads in a few seconds").then(() => setTimeout(() => location.reload(), 6000))}>Restart now</button>}
        <button className={`btn-secondary !py-1 ${data.can_restart ? "" : "ml-auto"}`} onClick={() => run(() => request(`${base}/restore`, { method: "DELETE" }), "Restore cancelled").then(reload)}>Cancel restore</button></div>}
      <ul className="divide-y divide-slate-100 text-sm">{data.backups.map((b: any) => (
        <li key={b.name} className="flex flex-wrap items-center gap-2 py-1.5">
          <span className="flex-1 font-mono text-xs">{b.name}</span><span className="text-xs text-slate-500">{Math.round(b.bytes / 1024).toLocaleString()} KB</span>
          <a className="btn-secondary !py-1 text-xs" href={downloadUrl(b.name)}>Download</a>
          <button className="btn-secondary !py-1 text-xs" title="Password se encrypt kar ke download (safe off-site copy)" onClick={() => {
            const pass = prompt("Backup encrypt karne ke liye password (kam az kam 8 characters). Ise sambhaal kar rakhein — bhoolne par backup khul nahi sakta:") ?? "";
            if (pass.length < 8) { if (pass) alert("Password kam az kam 8 characters ka hona chahiye."); return; }
            const u = downloadUrl(b.name); const [p, q] = u.split("?");
            window.open(`${p}/enc?${q ? q + "&" : ""}pass=${encodeURIComponent(pass)}`, "_blank");
          }}>🔒 Encrypted</button>
          <button className="btn-secondary !py-1 text-xs" onClick={() => confirm(`Restore ${b.name}? Today's data is backed up first; the restore finishes when the app restarts.`) && run(() => request(`${base}/${b.name}/restore`, { body: {} }), (r: any) => r.message).then(reload)}>Restore</button>
        </li>
      ))}{!data.backups.length && <li className="py-2 text-slate-500">No backups yet — the first one is made tonight.</li>}</ul>
      <p className="mt-2 text-xs text-slate-500">Tip: download a backup every week and keep it on another computer or USB, or set BACKUP_DIR to a cloud-synced folder. 🔒 Encrypted copy ko kisi bhi computer par kholne ke liye: <code className="font-mono">openssl enc -d -aes-256-cbc -pbkdf2 -md sha256 -in file.enc -out backup.db -k 'password'</code></p>
      <CloudBackups cloud={data.cloud} reload={reload} request={request} base={base} />
    </div>
  );
}

function CloudBackups({ cloud, reload, request, base }: { cloud: any; reload: () => void; request: Req; base: string }) {
  const { busy, run } = useAction();
  const [gJson, setGJson] = useState("");
  const [gFolder, setGFolder] = useState("");
  const [dKey, setDKey] = useState("");
  const [dSecret, setDSecret] = useState("");
  const [dCode, setDCode] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const when = (r: any) => r ? `${new Date(r.at).toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" })}` : "";
  const Status = ({ last }: { last: any }) => !last ? <span className="text-xs text-slate-500">No copy sent yet · <span className="font-urdu" lang="ur" dir="rtl">ابھی کاپی نہیں گئی</span></span>
    : last.ok ? <span className="text-xs text-emerald-700">✓ Last copy {when(last)} · {last.file}</span>
    : <span className="text-xs text-red-600">✗ Failed {when(last)} — {last.message}</span>;
  const Actions = ({ p }: { p: "gdrive" | "dropbox" }) => (
    <div className="flex flex-wrap gap-2">
      <button className="btn-secondary !py-1 text-xs" disabled={busy} onClick={() => run(() => request(`${base}/cloud/${p}/push`, { body: {} }), (r: any) => r.result.message).then(reload)}>Send latest backup now</button>
      <button className="btn-secondary !py-1 text-xs" disabled={busy} onClick={() => run(() => request(`${base}/cloud/${p}/check`, { body: {} }), (r: any) => `Connected · ${r.folder ?? r.account ?? "ok"}`)}>Check connection</button>
      <button className="btn-secondary !py-1 text-xs text-red-600" disabled={busy} onClick={() => confirm("Disconnect? Backups stay where they are; new ones will not be sent here.") && run(() => request(`${base}/cloud/${p}`, { method: "DELETE" }), "Disconnected").then(reload)}>Disconnect</button>
    </div>
  );
  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <h3 className="font-semibold">Cloud copy · <span className="font-urdu" lang="ur" dir="rtl">کلاؤڈ کاپی</span></h3>
      <p className="mb-3 text-xs text-slate-500">Server kharab ho jaye to backup bhi chala jata hai. Yahan jorein, har raat ka backup khud Google Drive / Dropbox par bhi jayega (aakhri 14 wahan rehte hain).</p>
      <div className="grid gap-3 lg:grid-cols-2">
        {/* Google Drive */}
        <div className="rounded-xl bg-slate-50 p-3">
          <div className="mb-1 flex items-center gap-2 font-medium">Google Drive {cloud?.gdrive?.configured && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">Connected</span>}</div>
          {cloud?.gdrive?.configured ? (
            <div className="space-y-2 text-sm">
              <div className="text-xs text-slate-600">Account: <span className="font-mono">{cloud.gdrive.email}</span> · folder <span className="font-mono">{cloud.gdrive.folder_id}</span></div>
              <Status last={cloud.gdrive.last} />
              <Actions p="gdrive" />
            </div>
          ) : cloud?.oneclick?.gdrive ? (
            <div className="space-y-2 text-sm">
              <p className="text-xs text-slate-600">Ek click mein apni Google Drive connect karein — koi JSON/key copy nahi.</p>
              <button className="btn-primary !py-1.5 text-sm" disabled={busy} onClick={() => run(() => request(`${base}/cloud/gdrive/auth-url`), "Google khul raha hai — allow karein, phir wapas aa kar Refresh").then((r: any) => { if (r?.url) window.open(r.url, "_blank", "noopener"); })}>Connect Google Drive</button>
              <button className="btn-secondary !py-1 text-xs" disabled={busy} onClick={reload}>Connect ho gaya? Refresh</button>
            </div>
          ) : (
            <div className="space-y-2 text-sm">
              <ol className="list-decimal space-y-0.5 pl-4 text-xs text-slate-600">
                <li>Google Cloud console → APIs → enable <b>Google Drive API</b> → IAM → <b>Service account</b> banayen → Keys → <b>Add key (JSON)</b> download.</li>
                <li>Apni Drive mein folder banayen (e.g. "PumpAI backups"), us service account ki email ko <b>Editor</b> share karein.</li>
                <li>Folder ka link ya ID aur JSON yahan paste karein.</li>
              </ol>
              <textarea className="input min-h-24 w-full font-mono text-xs" placeholder='{"type": "service_account", "client_email": "...", "private_key": "..."}' value={gJson} onChange={(e) => setGJson(e.target.value)} />
              <input className="input w-full" placeholder="Folder ID or link  (drive.google.com/drive/folders/…)" value={gFolder} onChange={(e) => setGFolder(e.target.value)} />
              <button className="btn-primary !py-1.5 text-sm" disabled={busy || gJson.length < 20 || gFolder.trim().length < 10} onClick={() => run(() => request(`${base}/cloud/gdrive`, { method: "PUT", body: { json: gJson, folder_id: gFolder } }), (r: any) => `Google Drive connected · folder "${r.folder}"`).then((r) => { if (r) { setGJson(""); setGFolder(""); reload(); } })}>Connect & test</button>
            </div>
          )}
        </div>
        {/* Dropbox */}
        <div className="rounded-xl bg-slate-50 p-3">
          <div className="mb-1 flex items-center gap-2 font-medium">Dropbox {cloud?.dropbox?.configured && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">Connected</span>}</div>
          {cloud?.dropbox?.configured ? (
            <div className="space-y-2 text-sm">
              <div className="text-xs text-slate-600">Account: {cloud.dropbox.account ?? "—"} · folder <span className="font-mono">/PumpAI backups</span></div>
              <Status last={cloud.dropbox.last} />
              <Actions p="dropbox" />
            </div>
          ) : cloud?.oneclick?.dropbox ? (
            <div className="space-y-2 text-sm">
              <p className="text-xs text-slate-600">1) "Get code" dabayein → Dropbox par <b>Allow</b> → jo code mile woh copy karein. 2) Neeche paste kar ke Connect.</p>
              <div className="flex flex-wrap items-center gap-2">
                <button className="btn-secondary !py-1 text-xs" disabled={busy} onClick={() => run(() => request(`${base}/cloud/dropbox/auth-url`), "Dropbox khul raha hai — allow kar ke code copy karein").then((r: any) => { if (r?.url) { setAuthUrl(r.url); window.open(r.url, "_blank", "noopener"); } })}>Get code from Dropbox</button>
                {authUrl && <a className="text-xs underline" href={authUrl} target="_blank" rel="noreferrer">link dobara kholein</a>}
              </div>
              <input className="input w-full font-mono" placeholder="Dropbox ka code yahan paste karein" value={dCode} onChange={(e) => setDCode(e.target.value)} />
              <button className="btn-primary !py-1.5 text-sm" disabled={busy || dCode.trim().length < 5} onClick={() => run(() => request(`${base}/cloud/dropbox/connect`, { body: { code: dCode.trim() } }), (r: any) => `Dropbox connected${r.account ? ` · ${r.account}` : ""}`).then((r) => { if (r) { setDCode(""); reload(); } })}>Connect</button>
            </div>
          ) : (
            <div className="space-y-2 text-sm">
              <ol className="list-decimal space-y-0.5 pl-4 text-xs text-slate-600">
                <li><a className="underline" href="https://www.dropbox.com/developers/apps" target="_blank" rel="noreferrer">dropbox.com/developers/apps</a> → Create app → Scoped access → <b>App folder</b> → Permissions: files.content.write, files.content.read, files.metadata.read.</li>
                <li>App key & secret yahan likhein, "Get code" dabayen, Dropbox jo code de woh paste karein.</li>
              </ol>
              <div className="grid grid-cols-2 gap-2">
                <input className="input" placeholder="App key" value={dKey} onChange={(e) => setDKey(e.target.value)} />
                <input className="input" placeholder="App secret" type="password" value={dSecret} onChange={(e) => setDSecret(e.target.value)} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button className="btn-secondary !py-1 text-xs" disabled={busy || dKey.trim().length < 5} onClick={() => run(() => request(`${base}/cloud/dropbox/auth-url?app_key=${encodeURIComponent(dKey.trim())}`), "Open the link, allow, copy the code").then((r: any) => { if (r?.url) { setAuthUrl(r.url); window.open(r.url, "_blank", "noopener"); } })}>Get code from Dropbox</button>
                {authUrl && <a className="text-xs underline" href={authUrl} target="_blank" rel="noreferrer">open link again</a>}
              </div>
              <input className="input w-full font-mono" placeholder="Paste the code Dropbox shows" value={dCode} onChange={(e) => setDCode(e.target.value)} />
              <button className="btn-primary !py-1.5 text-sm" disabled={busy || dKey.trim().length < 5 || dSecret.trim().length < 5 || dCode.trim().length < 5} onClick={() => run(() => request(`${base}/cloud/dropbox/connect`, { body: { app_key: dKey.trim(), app_secret: dSecret.trim(), code: dCode.trim() } }), (r: any) => `Dropbox connected${r.account ? ` · ${r.account}` : ""}`).then((r) => { if (r) { setDKey(""); setDSecret(""); setDCode(""); reload(); } })}>Connect</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
