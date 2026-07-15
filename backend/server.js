import express from "express";
import cors from "cors";
import cookieSession from "cookie-session";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import os from "os";
import "dotenv/config";

import { Users, Files, Folders } from "./db.js";
import {
  sendLoginCode,
  verifyLoginCode,
  encryptSession,
  decryptSession,
  getPooledClient,
  uploadToSavedMessages,
  renameSavedMessage,
  findSavedMessage,
  iterDownloadRange,
} from "./telegramClient.js";
import adminRouter from "./admin.js";

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(
  cookieSession({
    name: "tgdrive_session",
    keys: [process.env.COOKIE_SECRET || "dev_secret"],
    maxAge: 30 * 24 * 60 * 60 * 1000,
  })
);

const upload = multer({ dest: os.tmpdir() });

function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: "Not logged in" });
  next();
}

function getUser(userId) {
  return Users.findById(userId);
}

async function clientForUser(userId) {
  const user = getUser(userId);
  if (!user) throw new Error("User not found");
  const sessionString = decryptSession(user.encrypted_session);
  return getPooledClient(userId, sessionString);
}

// ---------------------------------------------------------------------------
// Real-time upload progress via Server-Sent Events (the server->Telegram leg,
// the real bottleneck — see docs).
// ---------------------------------------------------------------------------
const progressSubscribers = new Map(); // uploadId -> Set<res>
const cancelledUploads = new Set(); // uploadId currently being cancelled

function publishProgress(uploadId, payload) {
  const subs = progressSubscribers.get(uploadId);
  if (!subs) return;
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of subs) res.write(line);
}

app.get("/files/upload-progress/:uploadId", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const { uploadId } = req.params;
  if (!progressSubscribers.has(uploadId)) progressSubscribers.set(uploadId, new Set());
  progressSubscribers.get(uploadId).add(res);

  req.on("close", () => {
    progressSubscribers.get(uploadId)?.delete(res);
  });
});

// Best-effort cancel: if the upload is still in the browser->server leg, the
// browser aborting its own XHR is enough. If it's already in the
// server->Telegram leg, we mark it cancelled and force-disconnect that
// user's pooled Telegram client, which throws inside the in-flight
// sendFile() call and stops the transfer (the pool reconnects fresh next time).
app.post("/files/upload-cancel/:uploadId", requireAuth, async (req, res) => {
  cancelledUploads.add(req.params.uploadId);
  try {
    const user = getUser(req.session.userId);
    if (user) {
      const sessionString = decryptSession(user.encrypted_session);
      const client = await getPooledClient(req.session.userId, sessionString);
      await client.disconnect().catch(() => {});
    }
  } catch (_) {}
  publishProgress(req.params.uploadId, { phase: "error", error: "Cancelled by user" });
  progressSubscribers.delete(req.params.uploadId);
  res.json({ ok: true });
});

// ---------- AUTH ----------

app.post("/auth/send-code", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "phone required" });
    const requestId = await sendLoginCode(phone);
    res.json({ requestId });
  } catch (err) {
    console.error("[send-code]", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/auth/verify-code", async (req, res) => {
  try {
    const { requestId, code, password } = req.body;
    if (!requestId || !code) return res.status(400).json({ error: "requestId and code required" });

    let sessionString, phone;
    try {
      ({ sessionString, phone } = await verifyLoginCode(requestId, code, password));
    } catch (err) {
      if (err.message === "2FA_PASSWORD_REQUIRED") {
        return res.status(401).json({ error: "2FA_PASSWORD_REQUIRED" });
      }
      throw err;
    }

    const encrypted = encryptSession(sessionString);
    const user = await Users.upsert({ id: uuidv4(), phone, encrypted_session: encrypted });

    req.session.userId = user.id;
    res.json({ ok: true });
  } catch (err) {
    console.error("[verify-code]", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/auth/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get("/auth/me", (req, res) => {
  if (!req.session?.userId) return res.json({ loggedIn: false });
  Users.touchActive(req.session.userId);
  res.json({ loggedIn: true });
});

// ---------- FOLDERS ----------

app.get("/folders", requireAuth, (req, res) => {
  const parentId = req.query.parent_id || null;
  const folders = Folders.findByUser(req.session.userId, parentId);
  const breadcrumb = parentId ? Folders.breadcrumb(parentId) : [];
  res.json({ folders, breadcrumb });
});

app.post("/folders", requireAuth, async (req, res) => {
  const { name, parent_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Folder name required" });
  const folder = await Folders.create({
    id: uuidv4(),
    user_id: req.session.userId,
    name: name.trim(),
    parent_id: parent_id || null,
  });
  res.json({ folder });
});

app.delete("/folders/:id", requireAuth, async (req, res) => {
  const folder = Folders.findById(req.params.id);
  if (!folder || folder.user_id !== req.session.userId) return res.status(404).json({ error: "not found" });
  const hasFiles = Files.findByUserAndFolder(req.session.userId, folder.id).length > 0;
  const hasSubfolders = Folders.findByUser(req.session.userId, folder.id).length > 0;
  if (hasFiles || hasSubfolders) return res.status(400).json({ error: "Folder is not empty" });
  await Folders.remove(folder.id);
  res.json({ ok: true });
});

// ---------- FILES ----------

app.post("/files/upload", requireAuth, upload.single("file"), async (req, res) => {
  const tmpPath = req.file?.path;
  const uploadId = req.query.uploadId;
  let aborted = false;
  req.on("aborted", () => { aborted = true; cancelledUploads.add(uploadId); });

  try {
    if (!req.file) return res.status(400).json({ error: "No file received" });

    const client = await clientForUser(req.session.userId);
    const totalSize = req.file.size;

    // Resolve/auto-create a nested folder path if this came from a folder upload.
    let folderId = req.body.folder_id || null;
    const relativePath = req.body.relativePath;
    if (relativePath) {
      const parts = relativePath.split("/").filter(Boolean);
      for (const part of parts) {
        const folder = await Folders.getOrCreatePath(req.session.userId, folderId, part);
        folderId = folder.id;
      }
    }

    let lastTime = Date.now();
    let lastBytes = 0;

    const message = await uploadToSavedMessages(client, tmpPath, req.file.originalname, (fraction) => {
      if (cancelledUploads.has(uploadId)) throw new Error("Upload cancelled");
      if (!uploadId) return;
      const now = Date.now();
      const bytes = Math.round(fraction * totalSize);
      const dt = (now - lastTime) / 1000;
      const dBytes = bytes - lastBytes;
      if (dt >= 0.15) {
        const speed = dBytes / dt;
        lastTime = now;
        lastBytes = bytes;
        publishProgress(uploadId, { phase: "telegram", bytes, total: totalSize, pct: Math.round(fraction * 100), speed });
      }
    });

    cancelledUploads.delete(uploadId);
    if (uploadId) {
      publishProgress(uploadId, { phase: "done", bytes: totalSize, total: totalSize, pct: 100, speed: 0 });
      progressSubscribers.delete(uploadId);
    }

    const id = uuidv4();
    await Files.create({
      id,
      user_id: req.session.userId,
      tg_message_id: message.id,
      filename: req.file.originalname,
      mimetype: req.file.mimetype || "application/octet-stream",
      size: req.file.size,
      folder_id: folderId,
    });

    if (!aborted) res.json({ id, filename: req.file.originalname });
  } catch (err) {
    console.error("[upload]", err);
    cancelledUploads.delete(uploadId);
    if (uploadId) publishProgress(uploadId, { phase: "error", error: err.message });
    if (!aborted && !res.headersSent) res.status(500).json({ error: err.message || "Upload failed" });
  } finally {
    if (tmpPath) fs.unlink(tmpPath, () => {});
  }
});

app.get("/files", requireAuth, (req, res) => {
  const folderId = req.query.folder_id || null;
  const files = Files.findByUserAndFolder(req.session.userId, folderId).map(
    ({ id, filename, mimetype, size, visibility, share_token, folder_id, created_at }) => ({
      id, filename, mimetype, size, visibility, share_token, folder_id, created_at,
    })
  );
  res.json({ files });
});

app.delete("/files/:id", requireAuth, async (req, res) => {
  const file = Files.findByIdAndUser(req.params.id, req.session.userId);
  if (!file) return res.status(404).json({ error: "not found" });
  await Files.remove(file.id);
  res.json({ ok: true });
});

app.patch("/files/:id", requireAuth, async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename || !filename.trim()) return res.status(400).json({ error: "filename required" });
    const file = Files.findByIdAndUser(req.params.id, req.session.userId);
    if (!file) return res.status(404).json({ error: "not found" });

    const client = await clientForUser(req.session.userId);
    const message = await findSavedMessage(client, file.tg_message_id);
    if (message) {
      // Keep the Telegram message caption in sync too, not just our DB.
      await renameSavedMessage(client, message, filename.trim()).catch((e) => {
        console.error("[rename] failed to update Telegram caption", e);
      });
    }

    await Files.update(file.id, { filename: filename.trim() });
    res.json({ ok: true, filename: filename.trim() });
  } catch (err) {
    console.error("[rename]", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/files/:id/share", requireAuth, async (req, res) => {
  try {
    const { visibility } = req.body;
    const file = Files.findByIdAndUser(req.params.id, req.session.userId);
    if (!file) return res.status(404).json({ error: "not found" });

    let token = file.share_token;
    if (visibility === "public" && !token) token = uuidv4();

    await Files.update(file.id, { visibility, share_token: visibility === "public" ? token : file.share_token });

    const base = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
    res.json({ visibility, shareUrl: visibility === "public" ? `${base}/public/${token}` : null });
  } catch (err) {
    console.error("[share]", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/files/:id/stream", requireAuth, async (req, res) => {
  const file = Files.findByIdAndUser(req.params.id, req.session.userId);
  if (!file) return res.status(404).json({ error: "File not found" });
  await streamFileToResponse(file, req, res, req.query.download === "1");
});

app.get("/public/:token/info", (req, res) => {
  const file = Files.findByShareToken(req.params.token);
  if (!file) return res.status(404).json({ error: "not found" });
  res.json({ filename: file.filename, size: file.size, mimetype: file.mimetype });
});

app.get("/public/:token", async (req, res) => {
  const file = Files.findByShareToken(req.params.token);
  if (!file) return res.status(404).json({ error: "File not found or is private" });
  await streamFileToResponse(file, req, res, req.query.download === "1");
});

async function streamFileToResponse(file, req, res, forceDownload) {
  try {
    const client = await clientForUser(file.user_id);
    const message = await findSavedMessage(client, file.tg_message_id);

    if (!message || !message.media) {
      console.error("[stream] message/media not found for file", file.id, "tg_message_id", file.tg_message_id);
      return res.status(404).json({ error: "File content not found on Telegram (was it deleted from Saved Messages?)" });
    }

    const size = file.size;
    const range = req.headers.range;

    res.setHeader("Content-Type", file.mimetype || "application/octet-stream");
    res.setHeader("Accept-Ranges", "bytes");
    const disposition = forceDownload ? "attachment" : "inline";
    res.setHeader("Content-Disposition", `${disposition}; filename="${encodeURIComponent(file.filename)}"`);

    let start = 0;
    let end = size - 1;
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      if (match) {
        start = parseInt(match[1], 10);
        end = match[2] ? parseInt(match[2], 10) : size - 1;
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    } else {
      res.status(200);
    }
    res.setHeader("Content-Length", end - start + 1);

    try {
      for await (const chunk of iterDownloadRange(client, message, start, end - start + 1)) {
        if (!res.write(chunk)) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
      res.end();
    } catch (streamErr) {
      console.error("[stream] error while writing chunks", streamErr);
      if (!res.headersSent) res.status(500).json({ error: streamErr.message });
      else res.end();
    }
  } catch (err) {
    console.error("[stream] fatal error", err);
    if (!res.headersSent) res.status(500).json({ error: err.message || "Streaming failed" });
  }
}

app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- ADMIN (metadata monitoring only — see admin.js) ----------
app.use("/admin", adminRouter);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`tg-drive backend listening on :${PORT}`));
