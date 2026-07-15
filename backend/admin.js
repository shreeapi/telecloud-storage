import express from "express";
import { Users, Files, Folders } from "./db.js";
import "dotenv/config";

const router = express.Router();

// Credentials are read from env with the values you gave as defaults, so the
// panel works out of the box — but PLEASE move these to your real .env and
// change the password before deploying anywhere public. Hardcoded/default
// admin credentials in source are a real risk if this repo is ever public.
const ADMIN_ID = process.env.ADMIN_ID || "YOURADMINID";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "YOURPASSWARD";

function requireAdmin(req, res, next) {
  if (!req.session?.isAdmin) return res.status(401).json({ error: "Admin login required" });
  next();
}

router.post("/login", (req, res) => {
  const { id, password } = req.body;
  if (id === ADMIN_ID && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Invalid admin credentials" });
});

router.post("/logout", (req, res) => {
  req.session.isAdmin = false;
  res.json({ ok: true });
});

router.get("/me", (req, res) => {
  res.json({ isAdmin: !!req.session?.isAdmin });
});

// ---------------------------------------------------------------------------
// Everything below is METADATA ONLY. We deliberately never decrypt or expose
// `encrypted_session` here — that string is equivalent to a live login to a
// user's real Telegram account, and no admin panel should be able to read or
// reuse it. What you get instead: who's using the product, how much storage
// they're using, and when they were last active.
// ---------------------------------------------------------------------------

function storageForUser(userId) {
  return Files.all()
    .filter((f) => f.user_id === userId)
    .reduce((sum, f) => sum + (f.size || 0), 0);
}

router.get("/overview", requireAdmin, (req, res) => {
  const users = Users.all();
  const files = Files.all();
  const totalStorage = files.reduce((sum, f) => sum + (f.size || 0), 0);
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const activeToday = users.filter((u) => (u.last_active || 0) > dayAgo).length;

  res.json({
    totalUsers: users.length,
    totalFiles: files.length,
    totalStorageBytes: totalStorage,
    activeToday,
  });
});

router.get("/users", requireAdmin, (req, res) => {
  const users = Users.all().map((u) => ({
    id: u.id,
    // Phone is partially masked for privacy even within the admin panel.
    phone: u.phone ? u.phone.replace(/(\d{3})\d+(\d{2})$/, "$1••••$2") : "—",
    created_at: u.created_at,
    last_login: u.last_login,
    last_active: u.last_active,
    fileCount: Files.all().filter((f) => f.user_id === u.id).length,
    storageBytes: storageForUser(u.id),
  }));
  res.json({ users });
});

router.get("/files", requireAdmin, (req, res) => {
  const users = Users.all();
  const files = Files.all().map((f) => {
    const owner = users.find((u) => u.id === f.user_id);
    return {
      id: f.id,
      filename: f.filename,
      mimetype: f.mimetype,
      size: f.size,
      visibility: f.visibility,
      created_at: f.created_at,
      ownerPhone: owner ? owner.phone.replace(/(\d{3})\d+(\d{2})$/, "$1••••$2") : "unknown",
    };
  });
  res.json({ files });
});

export default router;
