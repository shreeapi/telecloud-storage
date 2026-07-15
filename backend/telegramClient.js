import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram";
import CryptoJS from "crypto-js";
import bigInt from "big-integer";
import "dotenv/config";

const apiId = parseInt(process.env.TG_API_ID, 10);
const apiHash = process.env.TG_API_HASH;
const ENC_KEY = process.env.SESSION_ENCRYPT_KEY;

export function encryptSession(sessionString) {
  return CryptoJS.AES.encrypt(sessionString, ENC_KEY).toString();
}

export function decryptSession(encrypted) {
  const bytes = CryptoJS.AES.decrypt(encrypted, ENC_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

// In-memory map for in-progress logins (phone code hash + temp client), keyed by requestId
const pendingLogins = new Map();

/**
 * Step 1 of login: send the Telegram login code to the user's phone.
 * Returns a requestId the frontend must send back with the code.
 */
export async function sendLoginCode(phone) {
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();

  const result = await client.invoke(
    new Api.auth.SendCode({
      phoneNumber: phone,
      apiId,
      apiHash,
      settings: new Api.CodeSettings({}),
    })
  );

  const requestId = `${phone}-${Date.now()}`;
  pendingLogins.set(requestId, {
    client,
    phone,
    phoneCodeHash: result.phoneCodeHash,
  });

  return requestId;
}

/**
 * Step 2 of login: verify the code (and 2FA password if needed).
 * Returns a session string to persist (encrypted) for this user.
 */
export async function verifyLoginCode(requestId, code, password) {
  const pending = pendingLogins.get(requestId);
  if (!pending) throw new Error("Login request expired or not found. Start over.");

  const { client, phone, phoneCodeHash } = pending;

  try {
    await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash,
        phoneCode: code,
      })
    );
  } catch (err) {
    // 2FA enabled accounts throw SESSION_PASSWORD_NEEDED
    if (err.errorMessage === "SESSION_PASSWORD_NEEDED" || /PASSWORD_NEEDED/i.test(String(err))) {
      if (!password) {
        throw new Error("2FA_PASSWORD_REQUIRED");
      }
      await client.signInWithPassword(
        { apiId, apiHash },
        {
          password: async () => password,
          onError: (e) => { throw e; },
        }
      );
    } else {
      throw err;
    }
  }

  const sessionString = client.session.save();
  pendingLogins.delete(requestId);
  // NOTE: intentionally not disconnecting here — the pool below will reuse
  // this same client for this user immediately after login.

  return { sessionString, phone, client };
}

// ---------------------------------------------------------------------------
// Connection pool: reuse one connected GramJS client per user instead of
// reconnecting on every single request. Reconnecting per-request was slow
// and could silently time out, which is what caused streaming to appear to
// "hang" and return a blank page.
// ---------------------------------------------------------------------------
const clientPool = new Map(); // userId -> { client, lastUsed }
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export async function getPooledClient(userId, sessionString) {
  const existing = clientPool.get(userId);
  if (existing && existing.client.connected) {
    existing.lastUsed = Date.now();
    return existing.client;
  }

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  clientPool.set(userId, { client, lastUsed: Date.now() });
  return client;
}

// Periodically close idle connections so we don't leak sockets.
setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of clientPool.entries()) {
    if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
      entry.client.disconnect().catch(() => {});
      clientPool.delete(userId);
    }
  }
}, 60 * 1000).unref();

/**
 * Get a one-off connected GramJS client (used only for the login flow).
 */
export async function getClientForSession(sessionString) {
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  return client;
}

/**
 * Upload a file to the user's own Saved Messages.
 * `workers: 12` uploads 12 file parts to Telegram in parallel for much
 * faster large-file uploads. `onProgress(fraction)` is called by GramJS
 * with the REAL upload-to-Telegram progress (0..1) — this is the actual
 * bottleneck, as opposed to the near-instant browser->our-server leg.
 */
export async function uploadToSavedMessages(client, filePath, fileName, onProgress) {
  const result = await client.sendFile("me", {
    file: filePath,
    caption: fileName,
    workers: 12,
    progressCallback: (progress) => {
      // GramJS calls this with a float between 0 and 1.
      if (onProgress) onProgress(progress);
    },
  });
  return result; // Api.Message
}

/**
 * Look up a message by id in Saved Messages, with a fallback search in case
 * a direct id lookup returns nothing (this happened when the id lookup was
 * silently failing and callers were treating it as a 404).
 */
/**
 * Rename a file on both sides: this edits the caption of the real Telegram
 * message (so it stays in sync if the user looks at Saved Messages directly),
 * the caller is responsible for updating the filename in our own DB too.
 */
export async function renameSavedMessage(client, message, newName) {
  await client.invoke(
    new Api.messages.EditMessage({
      peer: "me",
      id: message.id,
      message: newName,
    })
  );
}

export async function findSavedMessage(client, messageId) {
  const me = await client.getEntity("me");
  let messages = await client.getMessages(me, { ids: [messageId] });
  let message = messages?.[0];
  if (message && message.className !== "MessageEmpty") return message;

  // Fallback: scan recent saved messages for a matching id.
  for await (const m of client.iterMessages(me, { limit: 200 })) {
    if (m.id === messageId) return m;
  }
  return null;
}

/**
 * Stream a range of bytes for a given message's media back to the caller.
 * offset/limit are in bytes. Uses GramJS's downloadMedia in chunks.
 */
export async function* iterDownloadRange(client, message, offset, byteLength) {
  // GramJS's MAX_CHUNK_SIZE is exactly 512KB. If requestSize is set any
  // higher, GramJS silently clamps requestSize but NOT chunkSize, which
  // makes them mismatch and forces it onto the "GenericDownloadIter" code
  // path — which has a bug (`this.request.offset.mod is not a function`)
  // when offset isn't perfectly chunk-aligned. Keeping requestSize exactly
  // at 512KB keeps chunkSize === requestSize, which uses the working
  // "DirectDownloadIter" path instead.
  const CHUNK = 512 * 1024;
  const iter = client.iterDownload({
    file: message.media,
    offset: bigInt(offset),
    // fileSize (not "limit") is how GramJS computes how many chunks to
    // fetch — it must be a big-integer instance too.
    fileSize: bigInt(byteLength),
    requestSize: CHUNK,
  });
  for await (const chunk of iter) {
    yield chunk;
  }
}
