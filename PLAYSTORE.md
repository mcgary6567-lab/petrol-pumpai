# Petrol PumpAI — Google Play Store app (TWA)

The web app is a full PWA (installable, offline, service worker). To put it on the **Play Store** we wrap it in a
**Trusted Web Activity (TWA)** — a thin Android app that opens your live site full-screen, no browser bar. Same code,
one domain, nothing to re-write.

> Do this **after** your SaaS server is live on its own domain (see `SAAS.md`). The Android app is tied to **one**
> domain — pick the neutral product domain (e.g. `petrolpumpai.site`), not a single pump's domain.

## What's already done in this repo
- **Manifest** (`web/public/manifest.webmanifest`): name, icons (192/512 + maskable), `id`, `categories`, app shortcuts
  (Sale, Inbox, Khata, Cashier) — this is what the TWA builder reads.
- **Digital Asset Links**: the server serves `/.well-known/assetlinks.json` from env, so Google can verify the app
  belongs to your site. Until you set the fingerprint it returns `[]` (harmless).
- **Privacy & Terms**: public pages at `/privacy` and `/terms` (Play **requires** a privacy policy URL).

## Step 1 — Build the Android app from the live PWA
Use **Bubblewrap** (Google's CLI) or **PWABuilder** (web UI). Bubblewrap:

```bash
npm i -g @bubblewrap/cli
bubblewrap init --manifest https://petrolpumpai.site/manifest.webmanifest
#   Package name: site.petrolpumpai.twa   (keep this — it goes in assetlinks)
#   Host: petrolpumpai.site
bubblewrap build        # produces app-release-signed.apk and app-release-bundle.aab
```

Bubblewrap makes a signing key the first time and **prints its SHA-256 fingerprint**
(or get it later with `keytool -list -v -keystore android.keystore`).

## Step 2 — Tell the server the app's identity
Set these on the server (Fly secrets) with the package name and the fingerprint Bubblewrap printed:

```bash
fly secrets set -a petrol-pumpai \
  ANDROID_PACKAGE="site.petrolpumpai.twa" \
  ANDROID_CERT_FINGERPRINTS="AB:CD:EF:...:99"
```

`https://petrolpumpai.site/.well-known/assetlinks.json` now lists the app → the TWA opens with **no** browser bar.

> **Play App Signing** (recommended) re-signs your app with Google's own key. After the first upload, copy the
> **"App signing key certificate" SHA-256** from Play Console → *Setup → App integrity* and **add it** to the list
> (comma-separated), so both your upload key and Google's signing key verify:
> `ANDROID_CERT_FINGERPRINTS="<upload-key-sha256>,<play-signing-sha256>"`

## Step 3 — Publish on Play Console
1. Create a developer account (one-time ~$25) at <https://play.google.com/console>.
2. New app → upload the **`.aab`** from Step 1.
3. **Privacy policy URL**: `https://petrolpumpai.site/privacy`.
4. **Data safety** form: data stays on your server; WhatsApp via Meta; AI (if a key is set) via Anthropic — none sold.
5. Add the screenshots/feature graphic Play asks for (capture a few app screens on a phone), fill the store listing,
   and submit for review.

## Updating the app later
The TWA is just a shell — **you almost never rebuild it.** Pushing to `main` auto-deploys the website, and the app
shows the new version instantly. Rebuild the `.aab` only when you change the icon, name, or the TWA shell itself.
