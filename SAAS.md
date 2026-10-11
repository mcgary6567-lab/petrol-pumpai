# Petrol PumpAI — SaaS mode

One cloud server, many pumps. Every pump owner installs the app, signs up, and runs **their own** pump — no
per-pump domain or hosting. You (the platform owner) host **one** server and hand out access after payment.

## How it works
- **Sign up** (`/signup`): anyone creates their pump (tenant) + admin and starts a **free trial** (`TRIAL_DAYS`, default 7).
- **Gate**: when the trial ends (or you suspend a pump), that pump can only see the **Activate** screen until it's active.
- **Activate**: the owner pays you once (cash) → you either flip them to **active** in the platform panel, or hand
  them a one-time **activation code** they enter in the app. Then it's theirs for good.
- **Platform panel** (`/platform`): your super-admin — list every pump, activate / suspend, and make codes.
- **Isolation**: every row carries `tenant_id` and the login token pins a user to one pump, so pumps never see each
  other's data.

Turn it on with `SAAS_MODE=1` (already set in `fly.toml`). With it **off**, this same code is the classic
single-pump install (first-run wizard, one tenant).

## Deploy (new Fly.io account)

```bash
fly auth login
fly apps create petrol-pumpai
fly volumes create pumpai_data --size 3 --region sin -a petrol-pumpai
fly secrets set -a petrol-pumpai \
  JWT_SECRET="$(openssl rand -hex 32)" \
  PLATFORM_ADMIN_EMAIL="you@yourmail.com" \
  PLATFORM_ADMIN_PASSWORD="a-strong-password" \
  PUBLIC_URL="https://petrolpumpai.site" \
  SALES_PHONE="03001234567"
fly deploy -a petrol-pumpai
```

(Windows PowerShell: run each line separately; for the secrets use
`$jwt = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })` then `fly secrets set JWT_SECRET=$jwt …`.)

### Secrets
| Name | Meaning |
|---|---|
| `JWT_SECRET` | sign-in + link secret (random; **never changes** after launch, or everyone is signed out) |
| `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` | **your** super-admin login at `/platform` (seeded on every boot) |
| `PUBLIC_URL` | the address customers open (WhatsApp links, bills, the app) |
| `SALES_PHONE` | shown on the Activate screen as the "WhatsApp to buy" number |
| `GEMINI_API_KEY` (optional) | one AI key for the whole platform; or each pump sets its own in Settings → Integrations |

### Domain (pick before building the Play Store app)
Use a neutral product domain (e.g. `petrolpumpai.site`), since the Android app is tied to one domain:
`fly certs add petrolpumpai.site -a petrol-pumpai` → add the A/AAAA records it shows at your DNS.

## Auto-deploy
`.github/workflows/fly-deploy.yml` deploys on every push to `main`. One-time:
`fly tokens create deploy -a petrol-pumpai`, then in the GitHub repo add secret `FLY_API_TOKEN` (the token) and
variable `FLY_APP` = `petrol-pumpai`.

## Day-to-day (platform owner)
- `https://<your-domain>/platform` → sign in with `PLATFORM_ADMIN_EMAIL` → see every pump; **Activate** after cash,
  **Suspend** if needed, **+ Naya activation code** to hand a code over WhatsApp.
- **Off-site backup**: set `BACKUP_COPY_CMD` so each nightly backup is copied off Fly — the whole platform's data is
  on one volume; keep a copy elsewhere.
- **Scale** as pumps grow: `fly scale memory 2048`, `fly volumes extend <id> --size 10`. Keep **one** machine
  (SQLite single-writer) — never `fly scale count 2`.
