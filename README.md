# TeraCloud — Unlimited Storage via Telegram

Source & development: https://github.com/shreeapi/telecloud-storage
Telegram: https://t.me/shreeapi · https://t.me/nepalimomoswala
Designed by AnshAPI · Powered by ShreeAPI


Lets users log in with their **own Telegram account** (phone number, not just Telegram Login Widget) and use their Saved Messages as free, large-file cloud storage — upload, stream, and generate public/private share links.

## Why this architecture

Telegram's **Bot API** can only download files up to 20MB. To support 1–2GB video files, this project uses **MTProto directly via GramJS**, logging in as the real user account (like Telegram Desktop/Mobile does). Files are uploaded to the user's own "Saved Messages" chat, and your server streams them back on demand using the stored session.

## ⚠️ Important things to understand before shipping this

1. **You will hold a live login session for every user.** The encrypted session string your server stores is equivalent to being logged into their Telegram account. Losing your `SESSION_ENCRYPT_KEY` or DB to an attacker means their Telegram account is compromised. Treat this with the same care as storing passwords — ideally more.
2. **Be transparent with users** about exactly what access this grants (their full Telegram account, not just a storage folder).
3. **Telegram's Terms of Service** are written around normal human/app usage of user accounts. Automating user accounts at scale (many accounts, high volume, bot-like behavior) can trigger anti-abuse limits or account restrictions. This is fine for personal projects or small user bases; talk to a lawyer if you plan to scale commercially.
4. **Rate limits & flood waits**: Telegram will throttle (`FLOOD_WAIT`) if you upload/download too aggressively. Production code needs retry/backoff logic (not included in this MVP).
5. This MVP stores one Telegram session per website user 1:1. It does **not** yet support multiple devices, session revocation UI, or account deletion flows — add these before real users onboard.

## Setup

### 1. Get Telegram API credentials
Go to https://my.telegram.org → API Development Tools → create an app → copy `api_id` and `api_hash`.

### 2. Backend
```bash
cd backend
cp .env.example .env
# edit .env: paste your TG_API_ID, TG_API_HASH, and set two long random secrets
npm install
npm start
```
Backend runs on `http://localhost:4000`.

### 3. Frontend
```bash
cd frontend
npm install
npm run dev
```
Frontend runs on `http://localhost:5173` (proxies API calls to the backend).

## How login works (no bot involved)
1. User enters their phone number → backend calls Telegram's `auth.sendCode` → Telegram sends a real login code to their Telegram app.
2. User enters that code (and their 2FA password, if they have one set) into your site.
3. Backend completes `auth.signIn`, gets a **session string**, encrypts it, and stores it against that user in SQLite.
4. All future uploads/downloads for that user reuse this session via GramJS.

## Streaming large files
`GET /files/:id/stream` and `GET /public/:token` both support HTTP `Range` requests, so `<video>` tags can seek without downloading the whole file — the backend pulls only the requested byte range from Telegram via `client.iterDownload()`.

## Next steps you'll likely want
- Move from SQLite to Postgres for multi-instance deployments
- Add a connection pool for GramJS clients instead of connecting per-request (faster streaming)
- Add retry/backoff for `FLOOD_WAIT` errors
- Add file thumbnails/previews, folders, search
- Add password/email login as an *additional* option, separate from the Telegram session, so losing Telegram access doesn't lock users out of your site entirely
