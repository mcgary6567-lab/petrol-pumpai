# Petrol PumpAI — Hostinger Business (web) hosting par chalana

Ye guide Hostinger ke **Business / "Unlimited" web hosting** plan (Node.js Web Apps wala) ke liye hai. Is plan ki teen
pabandiyan hain, aur app un ke hisaab se tayyar hai:

| Pabandi | Hal |
|---|---|
| Koi page na khole to app **so jata hai**, background timers nahi chalte | hPanel ka **Cron Job** har 5 minute `/api/cron/tick` kholta hai: app jaagta hai aur jo kaam (backup, reminders, alerts) waqt par reh gaye, chal jate hain |
| GitHub se redeploy par app ka folder **badal sakta hai** | Database **app folder se bahar** (`DB_PATH`) rehta hai; `app.js` andar wala rasta dekhte hi ruk jata hai |
| Shared server par bhaari build nahi chalta | GitHub khud build karta hai aur tayyar files branch **`hostinger`** par rakhta hai; Hostinger sirf install + start karta hai |

> **Sab se zaroori:** Fly aur Hostinger **dono ek saath live na rakhein.** Entries do jagah bat jayengi aur hisaab nahi
> milega. Neeche "Fly se shift" wale tareeqe se ek raat mein shift karein.

---

## 1. GitHub: tayyar build branch

Repo me `.github/workflows/hostinger-build.yml` hai. Har push par (main) ye branch **`hostinger`** banata / update karta hai.
Pehli dafa: GitHub → **Actions** → "Hostinger build" → **Run workflow**. Thodi der baad branch `hostinger` nazar aayegi.

## 2. hPanel: data ka folder banayein (app se bahar)

hPanel → **Files → File Manager**. Home folder me (`/home/u123456789/` jaisa) ek folder banayein:

```
pumpai-data
```

Poora rasta note karein, misal: `/home/u123456789/pumpai-data` (apna `u…` number File Manager ke upar likha hota hai).

## 3. hPanel: Node.js app banayein

hPanel → **Websites → Add website → Node.js Web App** (ya apni website → **Node.js**):

- **Source:** GitHub → is repo ko connect karein → branch **`hostinger`** (sab se halka) **ya `main`** (dono chalti hain;
  `main` par Build command **`npm run build`** rakhein — build ke tools khud aa jate hain)
- Ye **Websites → Node.js app** wala tareeqa hai. "Advanced → Git → Deploy from GitHub (public_html)" PHP / static sites ke
  liye hai — us se Node app nahi chalta
- **Node version:** **22** (22.13 ya naya)
- **Entry file:** `app.js`
- **Install command:** `npm install --omit=dev` (agar poochhe) · **Build command:** khaali / `npm run build` (sirf "already built" likhta hai)

### Environment variables (hPanel → Node.js app → Environment variables)

| Naam | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DB_PATH` | `/home/u123456789/pumpai-data/pumpai.db` ← apna rasta |
| `CRON_KEY` | ek lambi random value (32+ harf). Banane ka tareeqa: kisi bhi computer par `openssl rand -hex 24`, ya 40 harf ka koi bhi mix |
| `JWT_SECRET` | **Fly wali hi value** (neeche step 6). Nayi lagayi to sab log logout + purane bill / portal links band |
| `PUBLIC_URL` | `https://aap-ka-domain.com` |
| `SAAS_MODE` | `1` (Fly par bhi 1 tha) |
| `TRIAL_DAYS` | `30` |
| `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` | agar Fly par set the to wohi |
| `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET`, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | agar Fly par set the to wohi |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | sirf agar Fly par set the (warna ye database me hi hain) |
| `WA_*`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `VENDOR_*` | sirf jo Fly par set the |

> AI / WhatsApp ki zyada tar settings app ke andar (Settings → Integrations) save hoti hain — wo database ke saath khud aa jati hain.

## 4. hPanel: Cron Job (har 5 minute)

hPanel → **Advanced → Cron Jobs** → **Custom** → har 5 minute (`*/5 * * * *`) → command:

```
curl -fsS "https://aap-ka-domain.com/api/cron/tick?key=YAHAN_CRON_KEY" > /dev/null
```

Ye app ko jagata hai aur raat ka backup (2 baje), Dropbox backup, alerts, reminders waghera waqt par chalata hai. Agar
server kai ghante band raha ho to 2 ghante se purane kaam **dobara nahi** chalte (taa ke subah 11 baje wala reminder raat 11
baje na jaye) — wo agle din apne waqt par chalenge.

Check: browser me ye link kholein — `{"ok":true,...}` aana chahiye. Galat key par 403.

## 5. Pehli dafa chalayein (khali database ke saath — test)

hPanel me app **Deploy / Start** karein, `https://aap-ka-domain.com` kholein. Setup wizard ek **SETUP CODE** maangta hai:
wo app ke log me `[setup] SETUP CODE: XXXXXXXX` likha hota hai (aur `pumpai-data/.setup_code` file me). Agar `DB_PATH` galat ho to log me saaf
message aata hai (hPanel → Node.js → Logs). Phir **zaroor ye test karein**:

1. App me koi chhoti entry karein.
2. hPanel se **Redeploy** karein.
3. Entry wahin hai? → data folder sahi jagah hai. Nahi hai → `DB_PATH` check karein, shift na karein.

## 6. Fly se shift (ek raat me)

1. Pump walon ko batayein: **raat X baje se aadha ghanta entry na karein.**
2. Fly ki secrets ki values nikalein (ek dafa, apne computer par `flyctl` se):
   ```
   fly ssh console -a petrol-pumpai -C "printenv"
   fly ssh console -a petrol-pumpai -C "cat /data/.jwt_secret"
   ```
   `JWT_SECRET` (ya `.jwt_secret` file wali value) aur baqi zaroori values Hostinger ke environment variables me daalein.
3. Aakhri backup: app me **Platform → Backups → "Backup now"**, phir wo file **download** karein.
4. Hostinger par app **Stop** karein. File Manager → `pumpai-data` me downloaded file upload karein aur naam rakhein
   **`pumpai.db`** (agar test wali `pumpai.db`, `pumpai.db-wal`, `pumpai.db-shm` hain to pehle delete karein).
5. App **Start** karein, login karein, Dashboard / khate / aaj ki sales check karein. Admin: `/books/check` → 0 farq.
6. Domain ka DNS Hostinger ki taraf karein (agar domain badla to `PUBLIC_URL`, WhatsApp webhook (Meta) aur Google login
   redirect URL bhi naye domain par).
7. Sab theek ho to **Fly band karein**: `fly scale count 0 -a petrol-pumpai` (volume abhi rehne dein — ek hafte baad
   delete karein). GitHub par Fly wala workflow bhi band kar dein (Actions → "Fly Deploy" → Disable), warna har push par
   Fly phir chal parega.

## 7. Roz ka kaam

- **Code update:** main par push → GitHub "Hostinger build" → branch `hostinger` update → hPanel me auto-deploy (ya
  **Redeploy** dabayein). Database ko kuch nahi hota.
- **Backup:** raat 2 baje khud (cron ke zariye) + Dropbox. `pumpai-data/backups` me 14 din ke backups.
- **Restore:** Platform → Backups → Restore → phir hPanel se app **Restart** (is hosting par "Restart now" button nahi chalta).

## Hadood (is plan par)

- Request zyada se zyada 120 second; bari Excel / backup download is se pehle ho jate hain.
- Live screens (dashboard live, board) chalti hain lekin app sone ke baad pehla page khulne me 2–5 second lag sakte hain.
- Pumps barhne par (10+ pumps, bhaari AI use) **VPS (KVM 1)** par jana behtar — wahan yahi `app.js` / Docker dono chalte hain.
