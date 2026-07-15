# TG Drive — Full Documentation

TG Drive turns a user's own Telegram account into unlimited, free cloud storage for their website account. Upload files (including large videos), stream them back with seeking, and generate public or private share links — all backed by the user's Telegram "Saved Messages," not your own server disk.

---

## 1. Purpose & how it works

Telegram gives every account effectively unlimited storage for free. TG Drive exposes that as a normal-feeling web app:

1. **Login** — the user enters their real Telegram phone number. Your backend calls Telegram's `auth.sendCode`/`auth.signIn` (via the MTProto protocol, using the `telegram` npm package / GramJS) — the same login flow the official Telegram apps use. This returns a **session string**, which is encrypted and stored against that user in your database.
2. **Upload** — files are sent straight to the user's own Saved Messages chat, split into up to **12 parallel parts** for speed (see §4).
3. **Storage** — your database only stores metadata (filename, size, mimetype, the Telegram message id, and share settings). The actual bytes live on Telegram's servers, not yours.
4. **Stream/Download** — when a file is requested, the backend fetches it from Telegram using the owner's session and pipes it to the browser, supporting HTTP `Range` requests so videos can be seeked without downloading the whole file first.
5. **Share links** — a file can be `private` (only the owner, while logged in, can stream it) or `public` (anyone with the link can view/download it, no login required — the backend still uses the *owner's* session behind the scenes to fetch it from Telegram).

## 2. Why not just use the Telegram Bot API?

The regular Bot API can only **download** files up to 20MB. That's fine for documents/images but useless for large videos. This project uses the full MTProto client library (GramJS) logged in as the real user account, which supports uploads/downloads in the multi-GB range — the same limits a normal Telegram user has (currently 2GB for free accounts, 4GB for Telegram Premium).

## 3. Architecture

```
Browser (React/Vite)  ⇄  Express backend  ⇄  Telegram (MTProto via GramJS)
                              │
                          lowdb (JSON file)
                       metadata only, no file bytes
```

- `backend/telegramClient.js` — all Telegram/GramJS logic: login flow, a per-user connection pool (so we don't reconnect on every request), upload, and ranged download.
- `backend/db.js` — lowdb-backed metadata store (`users`, `files`).
- `backend/server.js` — Express routes for auth, upload, listing, sharing, and streaming.
- `frontend/src/App.jsx` — login screen, dashboard (drag-and-drop upload with live progress, file list, preview modal), and a public share viewer page.

## 4. Parallel/segmented uploads (the "12 parallel parts" feature)

Telegram uploads are internally split into fixed-size parts. GramJS's `sendFile(..., { workers: N })` uploads up to `N` of those parts **concurrently** over the same MTProto connection, which is what actually saturates your bandwidth for large files. This project sets `workers: 12`. You can tune this in `telegramClient.js` → `uploadToSavedMessages()`. Higher isn't always better — past a certain point you're bottlenecked by your own network or by Telegram's per-connection flood limits, so 8–16 is a reasonable range to experiment with.

Note: this parallelism happens on the **backend → Telegram** leg. The browser → backend leg is still a single HTTP upload (multipart/form-data via `multer`), since splitting that too would require a custom chunked-upload protocol between your frontend and backend. For most home/office connections the backend→Telegram leg is the bottleneck, so this is where parallelism matters most.

## 5. Streaming & the connection pool

Early versions of this project opened a brand-new Telegram connection for every single upload/stream request, which was slow and could silently fail (showing a blank page). `telegramClient.js` now keeps a **pool of one connected client per user**, reused across requests and automatically closed after 10 minutes of inactivity. Streaming also:

- Looks up the file's message with a fallback scan of recent Saved Messages, in case a direct id lookup comes back empty.
- Returns real JSON error messages instead of silently returning a blank response, so failures are visible both in the browser and in your server console.
- Respects `Range` headers so `<video>`/`<audio>` tags can seek.

## 6. Public vs private files

- `visibility: private` (default) — only viewable via `/files/:id/stream`, which requires the owner's login cookie.
- `visibility: public` — a random `share_token` is generated, and `/public/:token` streams the file with no auth required. The frontend also serves a nice-looking public viewer page at `/public/:token` (see `PublicViewer` in `App.jsx`) that shows the filename/size and an embedded player before falling back to a raw download link for unsupported types.

Set `PUBLIC_BASE_URL` in `backend/.env` to your **frontend's** origin (e.g. `http://localhost:5173` in dev, or your real domain in production) so generated share links point at the nice viewer page rather than the raw backend endpoint.

## 7. Security model — please read this

- The encrypted Telegram session your server stores for each user is equivalent to holding a live login to their Telegram account. Treat `SESSION_ENCRYPT_KEY` with the same care as a database encryption key or a payment credential — if it or your database leaks, every user's Telegram account is compromised.
- `TG_API_ID`/`TG_API_HASH` (from my.telegram.org) identify your *application*, not any one user, but still shouldn't be posted publicly — rotate them if they've been exposed.
- This MVP does not include: rate limiting, session revocation UI, 2FA setup flows, or account deletion. Add these before opening the site to strangers.
- Automating full user accounts (not bots) at scale is a gray area under Telegram's Terms of Service. Fine for personal or small-scale projects; get legal input before scaling to many unrelated users.

## 8. Known limitations / next steps

- **lowdb** (a JSON file) is used for metadata for simplicity. Fine for a personal project; move to Postgres/MySQL if you expect concurrent writes from many users.
- No retry/backoff for Telegram's `FLOOD_WAIT` errors yet — if you hit Telegram's rate limits, uploads/downloads will throw and need a manual retry.
- No folders, search, or thumbnails yet.
- No password/email login as a fallback — losing Telegram access means losing access to your TG Drive account too. Consider adding a secondary login method before real users depend on this.

## 9. Running it

```bash
# Backend
cd backend
cp .env.example .env   # fill in TG_API_ID, TG_API_HASH, and two random secrets
npm install
npm start

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`, log in with your Telegram phone number + the code Telegram sends you, and start uploading.
