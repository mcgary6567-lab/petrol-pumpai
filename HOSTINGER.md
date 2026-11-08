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

**Agar site 503 / 403 de aur Runtime logs khaali hon:** File Manager me `public_html` ke bahar (usi level par)
`pumpai-startup.log` kholein — har start aur har rukawat ki wajah wahan likhi hoti hai. Entry file `app.js` zaroor likhein.

Check: browser me ye link kholein — `{"ok":true,...}` aana chahiye. Galat key par 403.

## 5. Pehli dafa chalayein (khali database ke saath — test)

hPanel me app **Deploy / Start** karein, `https://aap-ka-domain.com` kholein. Setup wizard ek **SETUP CODE** maangta hai:
wo app ke log me `[setup] SETUP CODE: XXXXXXXX` likha hota hai (aur `pumpai-data/.setup_code` file me). Agar `DB_PATH` galat ho to log me saaf
message aata hai (hPanel → Node.js → Logs). Phir **zaroor ye test karein**:

1. App me koi chhoti entry karein.
2. hPanel se **Redeploy** karein.
3. Entry wahin hai? → data folder sahi jagah hai. Nahi hai → `DB_PATH` check karein, shift na karein.

## 6. Fly se shift (ek raat me — 3 clicks, terminal nahi)

1. Pump walon ko batayein: **raat X baje se aadha ghanta entry na karein.**
2. **Purana server (Fly):** `petrol-pumpai.fly.dev/platform` → **Backups** → neeche **"🚚 Naye server par le jane ki file"** →
   ek password (10+ harf, yaad rakhein) do dafa → **Migration file download karein**. Ek `.pumpai` file milegi — is me poora
   database, saari photos aur login secret hai (password se band). Ise kisi ko na dein.
3. **Naya server (Hostinger):** `https://petrolpump.site/migrate` kholein →
   - **Setup code:** hPanel → Runtime logs me `SETUP CODE`, ya File Manager (🏠) → `pumpai-startup.log` me `SETUP CODE: ...`
   - **File:** wohi `.pumpai` file · **Password:** wohi password → **Data laayein**.
   File tukron me upload hoti hai, check hoti hai, data sahi folder me rakha jata hai aur app khud restart hota hai. Ghalat
   password / adhoori file par kuch nahi badalta. Pehle wala (test) data `pumpai-data` me `.before-restore-*` ban kar rehta hai.
4. Purane email / password se login karein (users ke PIN devices, customer portal aur bill links bhi wohi chalenge — login
   secret saath aata hai, `JWT_SECRET` badalne ki zarurat nahi). Dashboard, khate, aaj ki sales check karein; Admin → **Books
   check = 0 farq**. App 1–2 minute me na khule to hPanel → **Redeploy**.
5. Domain / links: agar purane links `petrol-pumpai.fly.dev` wale the to WhatsApp webhook (Meta), Google login redirect URL
   naye domain par karein; `PUBLIC_URL` = `https://petrolpump.site`.
6. Sab theek ho to **Fly band karein**: Fly dashboard → app → Machines → Stop (volume ek hafta rehne dein), aur GitHub →
   Actions → "Fly Deploy" → **Disable workflow**, warna har push par Fly phir chal parega.

**Purana tareeqa (terminal ke saath)** bhi chalta hai: Fly par Backup download → File Manager se `pumpai-data/pumpai.db`
rakhein → `JWT_SECRET` = `fly ssh console -a petrol-pumpai -C "printenv JWT_SECRET"`.

## 7. Roz ka kaam

- **Code update:** main par push → GitHub "Hostinger build" → branch `hostinger` update → hPanel me auto-deploy (ya
  **Redeploy** dabayein). Database ko kuch nahi hota.
- **Backup:** raat 2 baje khud (cron ke zariye) + Dropbox. `pumpai-data/backups` me 14 din ke backups.
- **Restore:** Platform → Backups → Restore → phir hPanel se app **Restart** (is hosting par "Restart now" button nahi chalta).

## Hadood (is plan par)

- Request zyada se zyada 120 second; bari Excel / backup download is se pehle ho jate hain.
- Live screens (dashboard live, board) chalti hain lekin app sone ke baad pehla page khulne me 2–5 second lag sakte hain.
- Pumps barhne par (10+ pumps, bhaari AI use) **VPS (KVM 1)** par jana behtar — wahan yahi `app.js` / Docker dono chalte hain.

## 8. Main site (petrolpump.site) + app (app.petrolpump.site)

Main domain par sales page (`/sell`), aur system subdomain `app.petrolpump.site` par. Do tareeqe:

### A. (Tajweez) Main site = sadi files, app = Node.js subdomain par

GitHub har push par branch **`site`** banata hai (`.github/workflows/site-build.yml`): sirf sales page + tasweerein.

1. **Pehle** purani Node.js app jo `petrolpump.site` par chal rahi hai, us ko hata dein (hPanel → petrolpump.site → ⋮ → Delete
   website, ya Node.js app band karein). Data `pumpai-data` folder me rehta hai — wo nahi mitta. (Ek hi data par do Node apps
   ek saath na chalayein — reminders / backup do dafa chal jayenge.)
2. **App:** hPanel → Websites → **Add website → Node.js app** → domain **`app.petrolpump.site`** (subdomain) → GitHub repo,
   branch **`hostinger`**, entry **`app.js`**, Node 22. Environment variables wohi (`DB_PATH` wahi rasta!), bas
   **`PUBLIC_URL=https://app.petrolpump.site`**. Cron job ka link bhi `https://app.petrolpump.site/api/cron/tick?key=...` kar dein.
3. **Main site:** hPanel → Websites → `petrolpump.site` (khaali website) → **Advanced → Git** → repo, branch **`site`**,
   directory `public_html` → **Deploy**. Har push par GitHub `site` branch update karta hai; hPanel me "Auto deployment" on karein.
4. WhatsApp button ke liye GitHub → Settings → Secrets and variables → Actions → **Variables** → `SALES_PHONE` =
   `923001234567` (apna number). Domain alag hon to `SITE_URL` / `APP_URL` bhi yahan.

### B. Ek hi Node app dono pate (agar hPanel app par alias / extra domain lagane de)

Node app ke environment variables me:
```
PUBLIC_URL=https://app.petrolpump.site
SITE_URL=https://petrolpump.site
MARKETING_HOST=petrolpump.site,www.petrolpump.site
```
Phir `petrolpump.site` par "/" sales page dikhata hai aur login / signup / baqi pages `app.petrolpump.site` par bhej deta hai.
API, webhooks aur files dono pate par chalte hain.
