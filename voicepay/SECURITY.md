# VoicePay: security and operations notes

## What is protected today
| Area | Control |
| --- | --- |
| Access to the API | Shared `API_KEY` (checked in constant time). The Edge Function refuses to serve user data when it is not set. |
| Brute force | Per-client rate limits: OTP start/verify 10/min, voice (stt/tts) 40/min, agent 60/min, payments 30/min, everything else 240/min. OTP also expires and allows a few wrong tries. |
| Abuse of uploads | JSON bodies are limited to 64 KB, audio to 10 MB (413 otherwise). |
| Browser/WebView | `nosniff`, `no-store`, `no-referrer`, HSTS, `X-Frame-Options: DENY` on HTML pages. |
| Payments | Amount and payee are fixed server-side in a one-time pending payment; the payment page cannot change them. Razorpay signatures are verified. Duplicate bill payments are blocked. |
| Personal data | PAN and Aadhaar are stored masked (last 4 only). The OTP is never written to the log. |
| Logs | One JSON line per event with a request id; no secrets or personal data. |
| App | Biometric/device-PIN lock, amounts hidden by default, crash screen that speaks and recovers. |

## What is still demo-grade (do this before real money)
1. **Real user accounts.** Today there is one shared `demo` user. Add Supabase Auth, give every row a `user_id`, and enable row level security.
2. **Real KYC and SMS.** The OTP is returned to the app (`demoOtp`). Connect an SMS provider and a licensed KYC provider (DigiLocker / CKYC), then remove `demoOtp`.
3. **Real money rails.** Mock wallet and Razorpay *test* mode only. Real UPI needs a licensed PA/PSP partner and RBI compliance.
4. **Rate limits across servers.** The limiter is in memory per instance (best effort on Edge Functions). Put a shared store (Redis / Postgres) or the platform's WAF in front for a hard guarantee.
5. **Secrets.** `EXPO_PUBLIC_API_KEY` ships inside the APK, so it only keeps casual strangers out. Per-user tokens (item 1) replace it.
6. **Release signing and Play Store.** Build with EAS and your own upload key; add a privacy policy and the Data Safety form.

## Rotating secrets
- Supabase: Dashboard > Edge Functions > Secrets (`API_KEY`, `GROQ_API_KEY`, `SARVAM_API_KEY`).
- Delete deploy tokens at https://supabase.com/dashboard/account/tokens after every deploy.
- If a key was ever pasted in a chat or a screenshot, treat it as leaked and regenerate it.

## Operating it
- Health: `GET /api/health` (open) shows `llm`, `stt`, `tts`, `gateway`.
- Tests and types: `cd server && npm run typecheck && npm test` (CI runs the same, and checks that the Edge Function copy is in sync).
- Deploy: `deploy.ps1` (builds the Edge Function copy and deploys it).
