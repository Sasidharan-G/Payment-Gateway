# VoicePay — a voice-first payment app for everyone, including blind and low-vision users

Talk to your phone. VoicePay understands English, Tamil and Tanglish, does the work, and **speaks every answer back**.
You can run the whole app without looking at the screen.

| You say | What happens |
|---|---|
| "Send 500 to Ramesh" | Two Ramesh contacts → asks "which one?" → asks to confirm → pays |
| "Priya ku aayiram anuppu" | ₹1,000 to Priya → confirm → pay |
| "Murugan Stores ku 250" … then "Google Pay" | Opens Google Pay pre-filled (you enter your UPI PIN) |
| "EB bill kattu" / "Jio recharge 299" / "Gas cylinder book pannu" | Fetches the bill or plan, confirms, pays |
| "What is my balance?" / "Show history" | Read out loud |
| "Open contacts" / "Open bills" / "Who are my contacts?" | Switches screen **and reads it to you** |
| "Start KYC" | Guided KYC by voice: name, date of birth, PAN, Aadhaar, mobile, OTP |
| "Help" / "Repeat" / "Stop listening" | What I can do / say it again / end hands-free mode |
| "Yes" / "Aama" / "Sari" / "Venaam" | Confirms or cancels |

## How a blind user uses it

1. Open the app. It greets you, tells your balance and **starts listening** (hands-free).
2. Speak. It answers aloud, then listens again. If you stay quiet twice it stops and says so.
3. **Tap anywhere on the big circle** to talk, to say "I'm done", or to interrupt it while it speaks.
4. Works with TalkBack / VoiceOver too: every control has a spoken label, headings, large targets (56dp+), no color-only meaning, and haptic feedback for success / error.

Accessibility choices (from the UI/UX Pro Max design system): dark OLED theme, text contrast 7:1+ on key text, 18px base font that follows the phone's font size, vector icons only, 8dp spacing, safe areas, reduced layout shift.

## Real mode (Supabase: login + per-user data)

The Supabase Edge Function runs in **real mode**: every user signs in (email + password, Supabase Auth) and gets their own row in `vp_state`.
The deployed backend keeps the demo wallet, demo gateway and simulated bills/KYC (no payment provider needed); only login and per-user data are real.
Set `REAL_MODE=1` (see `server/src/mode.ts`) to switch the fakes off later.

1. `app/.env` (copy `app/.env.example`): `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` (Dashboard > Project Settings > API).
2. Supabase Dashboard > Authentication > Providers > Email: turn **Confirm email** off if you want instant sign-up.
3. Deploy the backend: `.\deploy.ps1` (secrets needed: `GROQ_API_KEY`; `API_KEY` is no longer used).
4. Build the app with those two env vars. Without them the app talks to the local demo server as before.

## 1. What you need

- **Node.js 20+** on a laptop (https://nodejs.org)
- An Android phone with **Expo Go** (or the APK, section 6), or an Android emulator
- A free **Groq API key** — this one key does speech-to-text (Whisper) **and** understanding (LLM). Nothing else is needed for voice.
- Optional: **Razorpay test keys** for the real gateway screen. Without them a built-in demo gateway pays automatically after you say yes.

## 2. Run it

```bash
npm run setup            # installs server + app (first time only)
```

**Terminal 1 — server**
```bash
cd server
copy .env.example .env   # then paste your GROQ_API_KEY
npm start
```
Open the `Network:` link it prints in the phone's browser; you should see `{"ok":true,"llm":true,...}`.
If it doesn't open on Windows: allow **Node.js** (or TCP port 4000) through Windows Firewall for *all* networks, including the hotspot.

**Terminal 2 — app**
```bash
cd app
npx expo start
```
Scan the QR with Expo Go. The app finds the server automatically (same Wi-Fi / hotspot). Otherwise: Profile → Server address.

## 3. Keys (`server/.env`)

| Key | What for |
|---|---|
| `GROQ_API_KEY` | Voice + AI. https://console.groq.com/keys (free) |
| `GROQ_MODEL` | Default `openai/gpt-oss-120b`. (`llama-3.3-70b-versatile` needs a paid plan.) Check https://console.groq.com/docs/models |
| `GROQ_STT_MODEL` | Default `whisper-large-v3-turbo` |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Optional, test mode first |
| `API_KEY` | Set on a public server; same value as `EXPO_PUBLIC_API_KEY` in the app build |
| `DATA_FILE` | Where the JSON database lives (default `data/db.json`) |

Restart the server after changing `.env`. Never commit `.env` or paste keys in chat; rotate a key if it leaked.

## 4. Real-time payments: what is real and what is not

| Part | Status |
|---|---|
| Voice → text (Whisper), intent understanding (LLM + rule fallback) | Real |
| Contact matching, KYC rules (PAN, Aadhaar checksum, 18+, OTP limits) | Real checks |
| Razorpay checkout + HMAC signature verification | Real (test mode until you complete Razorpay business KYC) |
| Open Google Pay / PhonePe / Paytm pre-filled | Real, **moves real money**, you enter the UPI PIN |
| Bill fetch (electricity, DTH, recharge plans, gas) | Simulated. Real needs a BBPS aggregator (Setu, PaySprint, Cashfree BBPS…) |
| KYC OTP / Aadhaar eKYC | Simulated (OTP is read out in demo mode). Real needs an SMS gateway and a UIDAI-licensed partner (Digio, IDfy, Signzy) |
| Wallet balance | Demo money |

**Going live (in this order):**
1. Razorpay: complete business KYC → live keys → payments to *your* account (collecting money). Paying *other people* from the app needs **Razorpay X / Cashfree Payouts** (RBI rules apply), or keep using the UPI-app route where the user's own bank does the debit.
2. Replace `fetchBill()` in `server/src/billers.ts` with a BBPS aggregator.
3. Replace KYC in `server/src/kyc.ts` with a licensed eKYC provider + SMS OTP.
4. Add real user accounts: today the server has **one shared demo user**. Before many people use it, add login (e.g. Supabase Auth) and store each user's data in a database instead of `data/db.json`.
5. Holding user money (a wallet) is a regulated activity (RBI PPI licence). Do not do that without the license.

A fully hands-free *real* payment is limited by the UPI rules: the UPI PIN is entered in the bank app (TalkBack works there). The gateway route for a blind user means the checkout page must be accessible; the demo gateway auto-pays after the spoken "yes".

## 5. Tests

```bash
npm test      # 22 server tests (parser, voice navigation, voice KYC, every payment flow, API key guard) + type-checks
```

## 6. Build an APK

**Option A — Expo cloud (easiest, needs a free Expo account):**
```bash
cd app
npm install -g eas-cli
eas login
eas build -p android --profile preview      # prints a download link for the .apk
```
Before building, put your server URL in `app/eas.json` (`EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_API_KEY`).

**Option B — local build on Windows (what was used here):** needs Android Studio.
```bash
cd app
npx expo prebuild --platform android
cd android
# use a short path (e.g. C:\vp) — OneDrive and long paths break Gradle
set JAVA_HOME=C:\Program Files\Android\Android Studio\jbr
set EXPO_PUBLIC_API_URL=https://your-server
gradlew.bat assembleRelease
```
APK: `android/app/build/outputs/apk/release/app-release.apk`. Install: copy to the phone, or `adb install app-release.apk`.
The release APK is signed with the debug key — fine for testing; make a real keystore before the Play Store.

## 7. Host the server (so the APK works away from your laptop)

The server is a small always-on Node app with a JSON file, so use a Node/Docker host:

- **Render (free):** push the repo to GitHub → Render → New → Blueprint → it reads `render.yaml`. Paste `GROQ_API_KEY`; copy the generated `API_KEY` into `app/eas.json`. Free instances sleep after idle (first request is slow) and the JSON file resets on redeploy: add a disk or a database for real use.
- **Railway / Fly.io:** same Dockerfile (`server/Dockerfile`).
- **Supabase:** it can't run this Node server as-is (Edge Functions are Deno and have no disk). Use Supabase for what it is good at: **Postgres + Auth**. Next step for production: replace `server/src/db.ts` with Supabase Postgres tables per user and add Supabase Auth. The Node API then stays on Render/Railway.

## 8. Project layout

```
server/src/agent.ts     conversation state, decisions, safety checks, voice KYC, screen descriptions
server/src/parser.ts    rules: English / Tamil / Tanglish numbers, names, bills, navigation
server/src/speech.ts    "double five", "A B C P E 1 2 3", "14th May 2001" → clean values
server/src/llm.ts       Groq: tool calling (intents) + Whisper
server/src/app.ts       HTTP routes (/api/agent, /api/stt, /api/payments/*, /checkout/*)
app/App.tsx             shell, tabs, voice navigation
app/src/voice.tsx       speak() / listen() / ask() with auto-stop on silence
app/src/screens/Home.tsx   the hands-free conversation loop + big talk target
app/src/PayFlow.tsx     confirm → gateway / UPI app → spoken result
app/src/theme.ts, ui.tsx   design tokens + accessible components
```

## 9. Troubleshooting

| Problem | Fix |
|---|---|
| "I can't reach the VoicePay server" | Server running? Same Wi-Fi / hotspot? Allow port 4000 in the firewall for all networks. Set the address in Profile → Server. |
| Phone on the laptop's **hotspot** | The laptop is `192.168.137.1`. On Wi-Fi it is the Wi-Fi IP shown when the server starts. |
| Voice says it needs a key | Add `GROQ_API_KEY`, restart the server. |
| Voice stops after two quiet turns | By design. Tap the big circle. |
| `model_not_found` in the server log | Set `GROQ_MODEL=openai/gpt-oss-120b`. |
| Gradle can't download | `services.gradle.org` may be blocked on some networks: use `downloads.gradle.org` in `gradle-wrapper.properties`. |
