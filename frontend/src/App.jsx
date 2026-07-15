import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import "./styles.css";
import AdminPanel from "./AdminPanel.jsx";

const APP_NAME = "TeraCloud";
const GITHUB_REPO = "https://github.com/shreeapi/telecloud-storage";
const TG_CHANNEL_1 = "https://t.me/nepalimomoswala";
const TG_CHANNEL_2 = "https://t.me/shreeapi";

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function fmtSize(bytes) {
  if (bytes == null) return "—";
  const mb = bytes / 1024 / 1024;
  if (mb > 1024) return (mb / 1024).toFixed(2) + " GB";
  return mb.toFixed(1) + " MB";
}
function fmtSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return "—";
  const mbps = bytesPerSec / 1024 / 1024;
  if (mbps < 1) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${mbps.toFixed(2)} MB/s`;
}
function fmtEta(seconds) {
  if (!seconds || !isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s left`;
}
function fileIcon(mimetype = "") {
  if (mimetype.startsWith("video/")) return "🎬";
  if (mimetype.startsWith("image/")) return "🖼️";
  if (mimetype.startsWith("audio/")) return "🎵";
  if (mimetype.includes("pdf")) return "📄";
  if (mimetype.includes("zip") || mimetype.includes("rar")) return "🗜️";
  return "📁";
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function navigate(path) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new Event("locationchange"));
}
function useRoute() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onChange = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onChange);
    window.addEventListener("locationchange", onChange);
    return () => {
      window.removeEventListener("popstate", onChange);
      window.removeEventListener("locationchange", onChange);
    };
  }, []);
  return path;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
const THEMES = [
  { id: "light", icon: "☀️", label: "Light" },
  { id: "dark", icon: "🌙", label: "Dark" },
  { id: "soft", icon: "🌾", label: "Soft" },
];
function useTheme() {
  const [theme, setTheme] = useState(localStorage.getItem("tc-theme") || "light");
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("tc-theme", theme);
  }, [theme]);
  return [theme, setTheme];
}
function BubbleBackground() {
  return (
    <div className="bubble-bg">
      <div className="blob blob-1" />
      <div className="blob blob-2" />
      <div className="blob blob-3" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Global upload manager — lives at the App root so uploads keep running (and
// stay visible in a floating widget) no matter which page the user browses
// to. This is what lets someone kick off an upload and go explore the rest
// of the site while it finishes in the background.
// ---------------------------------------------------------------------------
const UploadContext = createContext(null);
function useUploadContext() { return useContext(UploadContext); }

function useUploadManager(onAnyUploaded) {
  const [uploads, setUploads] = useState([]); // {id, name, size, phase, pct, speed, eta, error, xhr, uploadId}

  const uploadOne = (file, { folderId, relativePath } = {}) => {
    const uid = Math.random().toString(36).slice(2);
    const uploadId = `${uid}-${Date.now()}`;

    setUploads((u) => [
      ...u,
      { id: uid, uploadId, name: file.name, size: file.size, phase: "server", pct: 0, speed: 0, eta: null, error: null, xhr: null },
    ]);

    const es = new EventSource(`/files/upload-progress/${uploadId}`);
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.phase === "telegram") {
        const remaining = data.total - data.bytes;
        const eta = data.speed > 0 ? remaining / data.speed : null;
        setUploads((u) => u.map((x) => (x.id === uid
          ? { ...x, phase: "telegram", pct: data.pct, speed: data.speed, eta }
          : x)));
      } else if (data.phase === "done") {
        setUploads((u) => u.map((x) => (x.id === uid ? { ...x, phase: "done", pct: 100, eta: 0 } : x)));
        es.close();
      } else if (data.phase === "error") {
        setUploads((u) => u.map((x) => (x.id === uid ? { ...x, error: data.error } : x)));
        es.close();
      }
    };
    es.onerror = () => es.close();

    const form = new FormData();
    form.append("file", file);
    if (folderId) form.append("folder_id", folderId);
    if (relativePath) form.append("relativePath", relativePath);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/files/upload?uploadId=${encodeURIComponent(uploadId)}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      setUploads((u) => u.map((x) => (x.id === uid && x.phase === "server" ? { ...x, pct } : x)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setTimeout(() => setUploads((u) => u.filter((x) => x.id !== uid)), 2200);
        onAnyUploaded?.();
      } else if (xhr.status !== 0) {
        let msg = "Upload failed";
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
        setUploads((u) => u.map((x) => (x.id === uid ? { ...x, error: msg } : x)));
        es.close();
      }
    };
    xhr.onerror = () => {
      setUploads((u) => u.map((x) => (x.id === uid ? { ...x, error: "Network error" } : x)));
      es.close();
    };
    xhr.onabort = () => {
      setUploads((u) => u.map((x) => (x.id === uid ? { ...x, error: "Cancelled" } : x)));
      es.close();
    };
    xhr.send(form);

    setUploads((u) => u.map((x) => (x.id === uid ? { ...x, xhr } : x)));
  };

  const addFiles = (fileList, opts) => Array.from(fileList).forEach((f) => uploadOne(f, opts));

  // Folder-aware add: expects real File objects that may carry webkitRelativePath
  // (set automatically by <input webkitdirectory> or a folder drag-drop).
  const addFilesWithPaths = (fileList, folderId) => {
    Array.from(fileList).forEach((file) => {
      const rel = file.webkitRelativePath || "";
      const relDir = rel.includes("/") ? rel.split("/").slice(0, -1).join("/") : "";
      uploadOne(file, { folderId, relativePath: relDir });
    });
  };

  const cancel = (id) => {
    const u = uploads.find((x) => x.id === id);
    if (!u) return;
    u.xhr?.abort();
    if (u.uploadId) {
      fetch(`/files/upload-cancel/${u.uploadId}`, { method: "POST", credentials: "include" }).catch(() => {});
    }
  };

  const dismiss = (id) => setUploads((u) => u.filter((x) => x.id !== id));

  return { uploads, addFiles, addFilesWithPaths, cancel, dismiss };
}

function UploadWidget() {
  const { uploads, dismiss, cancel } = useUploadContext();
  const [size, setSize] = useState("normal"); // 'mini' | 'normal' | 'large'

  if (uploads.length === 0) return null;

  const active = uploads.filter((u) => !u.error && u.phase !== "done");
  const overallPct = uploads.length
    ? Math.round(uploads.reduce((s, u) => s + u.pct, 0) / uploads.length)
    : 0;

  const phaseLabel = (u) => {
    if (u.error) return u.error === "Cancelled" ? "Cancelled" : "Failed";
    if (u.phase === "server") return "Uploading to server…";
    if (u.phase === "telegram") return "Uploading to Telegram…";
    return "Done ✓";
  };

  return (
    <div className={`upload-widget ${size}`}>
      <div className="uw-header" onClick={() => setSize(size === "mini" ? "normal" : "mini")}>
        <div className="uw-title">
          {active.length > 0 && <div className="uw-spinner" />}
          {active.length > 0
            ? `Uploading ${uploads.length - active.length + 1}/${uploads.length} file${uploads.length > 1 ? "s" : ""}`
            : `${uploads.length} file${uploads.length > 1 ? "s" : ""} done`}
        </div>
        <div className="uw-controls">
          {size !== "mini" && (
            <button
              className="uw-icon-btn"
              title={size === "large" ? "Shrink" : "Enlarge"}
              onClick={(e) => { e.stopPropagation(); setSize(size === "large" ? "normal" : "large"); }}
            >
              {size === "large" ? "⤡" : "⤢"}
            </button>
          )}
          <button className="uw-icon-btn" title={size === "mini" ? "Expand" : "Minimize"}>
            {size === "mini" ? "▲" : "▼"}
          </button>
        </div>
      </div>
      {size === "mini" ? (
        <div className="uw-mini-bar"><div className="uw-mini-fill" style={{ width: `${overallPct}%` }} /></div>
      ) : (
        <div className="uw-body">
          {uploads.map((u) => (
            <div className="upload-row" key={u.id}>
              <div className="upload-top">
                <div className="upload-info">
                  <div className="upload-name">{u.name} <span style={{ color: "var(--text-dim)" }}>· {fmtSize(u.size)}</span></div>
                  {u.error ? (
                    <div className="error-box" style={{ marginTop: 4 }}>{u.error}</div>
                  ) : (
                    <div className="progress-track"><div className="progress-fill" style={{ width: `${u.pct}%` }} /></div>
                  )}
                </div>
                {!u.error && <div className="upload-pct">{u.pct}%</div>}
                {!u.error && u.phase !== "done" && (
                  <button className="uw-icon-btn" title="Cancel" onClick={() => cancel(u.id)}>✕</button>
                )}
                {(u.error || u.phase === "done") && (
                  <button className="uw-icon-btn" title="Dismiss" onClick={() => dismiss(u.id)}>✕</button>
                )}
              </div>
              {!u.error && (
                <div className="upload-stats">
                  <span>{phaseLabel(u)}</span>
                  {u.phase === "telegram" && <span>⚡ {fmtSpeed(u.speed)}</span>}
                  {u.phase === "telegram" && <span>⏱ {u.pct >= 100 ? "Done" : fmtEta(u.eta)}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------
function NavBar({ loggedIn, onLogout, path, theme, setTheme }) {
  const link = (to, label) => (
    <a className={path === to ? "active" : ""} onClick={() => navigate(to)}>{label}</a>
  );
  return (
    <div className="nav-wrap">
      <div className="nav">
        <div className="brand" onClick={() => navigate("/")}>
          <div className="brand-badge">☁️</div> {APP_NAME}
        </div>
        <div className="nav-links">
          {link("/", "Home")}
          {loggedIn && link("/upload", "Upload")}
          {loggedIn && link("/library", "Library")}
          {link("/docs", "Docs")}
        </div>
        <div className="nav-right">
          <div className="theme-toggle">
            {THEMES.map((t) => (
              <button key={t.id} className={"theme-dot" + (theme === t.id ? " active" : "")} title={t.label} onClick={() => setTheme(t.id)}>
                {t.icon}
              </button>
            ))}
          </div>
          {loggedIn ? (
            <button className="btn btn-sm" onClick={onLogout}>Log out</button>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={() => navigate("/login")}>Log in</button>
          )}
        </div>
      </div>
    </div>
  );
}

function Footer() {
  return (
    <div className="site-footer">
      <div>{APP_NAME} — Powered by ShreeAPI · Designed by AnshAPI</div>
      <div className="footer-links">
        <a href={GITHUB_REPO} target="_blank" rel="noreferrer">GitHub — Source & Dev</a>
        <a href={TG_CHANNEL_2} target="_blank" rel="noreferrer">t.me/shreeapi</a>
        <a href={TG_CHANNEL_1} target="_blank" rel="noreferrer">t.me/nepalimomoswala</a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------
function Landing() {
  return (
    <div className="animate-in">
      <div className="hero">
        <div>
          <h1>Your Telegram account,<br />as unlimited storage.</h1>
          <p>
            Log in with your own Telegram account, upload files of any size (one at a time or
            many at once), keep browsing while they upload in the background, stream instantly,
            and share public or private links — all backed by your own Saved Messages.
          </p>
          <div className="hero-actions">
            <button className="btn btn-primary" onClick={() => navigate("/login")}>Get Started</button>
            <button className="btn" onClick={() => navigate("/docs")}>Read the Docs</button>
          </div>
        </div>
        <div className="hero-visual"><div className="glyph">☁️</div></div>
      </div>

      <div className="features">
        <div className="feature-card">
          <div className="feature-icon">🚀</div>
          <h4>Lightning uploads</h4>
          <p>Upload multiple files at once, in up to 12 parallel parts each, with live real-world speed shown as it goes.</p>
        </div>
        <div className="feature-card">
          <div className="feature-icon">🪟</div>
          <h4>Upload & keep exploring</h4>
          <p>Minimize the upload tray and browse the rest of the site — your files keep uploading in the background.</p>
        </div>
        <div className="feature-card">
          <div className="feature-icon">🔗</div>
          <h4>Public or private links</h4>
          <p>Share any file with a public link, or keep it private to your account only.</p>
        </div>
        <div className="feature-card">
          <div className="feature-icon">♾️</div>
          <h4>Effectively unlimited</h4>
          <p>Storage lives on Telegram's servers, not ours — so you're limited only by your Telegram account.</p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
function LoginForm({ onLoggedIn }) {
  const [phone, setPhone] = useState("");
  const [requestId, setRequestId] = useState(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const sendCode = async () => {
    setLoading(true);
    setError("");
    try {
      const { requestId } = await api("/auth/send-code", { method: "POST", body: JSON.stringify({ phone }) });
      setRequestId(requestId);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const verify = async () => {
    setLoading(true);
    setError("");
    try {
      await api("/auth/verify-code", {
        method: "POST",
        body: JSON.stringify({ requestId, code, password: needsPassword ? password : undefined }),
      });
      onLoggedIn();
      navigate("/library");
    } catch (e) {
      if (e.message === "2FA_PASSWORD_REQUIRED") setNeedsPassword(true);
      else setError(e.message);
    }
    setLoading(false);
  };

  return (
    <div className="page animate-in">
      <div className="card auth-card">
        <h2>Log in with Telegram</h2>
        {!requestId && (
          <>
            <p className="hint">Enter your Telegram phone number with country code.</p>
            <input className="field" placeholder="+1 234 567 8900" value={phone}
              onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendCode()} />
            <button className="btn btn-primary" style={{ width: "100%" }} onClick={sendCode} disabled={loading || !phone}>
              {loading ? "Sending…" : "Send Code"}
            </button>
          </>
        )}
        {requestId && (
          <>
            <p className="hint">Check your Telegram app for the login code.</p>
            <input className="field" placeholder="Login code" value={code}
              onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && verify()} />
            {needsPassword && (
              <input className="field" placeholder="2FA password" type="password" value={password}
                onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && verify()} />
            )}
            <button className="btn btn-primary" style={{ width: "100%" }} onClick={verify} disabled={loading || !code}>
              {loading ? "Verifying…" : "Verify"}
            </button>
          </>
        )}
        {error && <div className="error-box">{error}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload page — just the dropzone; actual progress lives in the global
// floating widget so it survives navigating to other pages.
// ---------------------------------------------------------------------------
function UploadPage() {
  const { addFiles, addFilesWithPaths } = useUploadContext();
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef();
  const folderInputRef = useRef();

  const handleFiles = (fileList) => addFiles(fileList);
  const handleFolder = (fileList) => addFilesWithPaths(fileList, null);

  return (
    <div className="page animate-in">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Upload</h2>
        <p className="hint">Select or drop as many files (or a whole folder) as you like — they'll upload together, and you can keep browsing the rest of {APP_NAME} while they finish (check the tray in the corner).</p>
        <div
          className={"dropzone" + (dragOver ? " dragover" : "")}
          onClick={() => inputRef.current.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
        >
          <div style={{ fontSize: 28, marginBottom: 8 }}>⬆️</div>
          <div>Drag & drop files here, or click to browse</div>
          <div className="hint" style={{ marginTop: 6 }}>Multiple files supported · 12 parallel parts per file for speed</div>
          <input ref={inputRef} type="file" multiple onChange={(e) => e.target.files.length && handleFiles(e.target.files)} />
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="btn" onClick={() => folderInputRef.current.click()}>📁 Upload a whole folder</button>
          <button className="btn" onClick={() => navigate("/library")}>Go to Library →</button>
        </div>
        <input
          ref={folderInputRef}
          type="file"
          webkitdirectory=""
          directory=""
          multiple
          style={{ display: "none" }}
          onChange={(e) => e.target.files.length && handleFolder(e.target.files)}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Player modal
// ---------------------------------------------------------------------------
function PlayerModal({ file, onClose }) {
  if (!file) return null;
  const src = `/files/${file.id}/stream`;
  const isVideo = file.mimetype?.startsWith("video/");
  const isImage = file.mimetype?.startsWith("image/");
  const isAudio = file.mimetype?.startsWith("audio/");
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>{file.filename}</strong>
          <button className="btn btn-sm" onClick={onClose}>✕ Close</button>
        </div>
        {isVideo && <video src={src} controls autoPlay />}
        {isAudio && <audio src={src} controls autoPlay style={{ width: "100%" }} />}
        {isImage && <img src={src} alt={file.filename} />}
        {!isVideo && !isAudio && !isImage && (
          <div style={{ padding: 30, textAlign: "center" }}>
            <p>Preview not supported for this file type.</p>
            <a className="btn btn-primary" href={src} download={file.filename}>Download</a>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Library page
// ---------------------------------------------------------------------------
function Library() {
  const [files, setFiles] = useState([]);
  const [folders, setFolders] = useState([]);
  const [breadcrumb, setBreadcrumb] = useState([]);
  const [currentFolder, setCurrentFolder] = useState(null); // folder id or null (root)
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(null);
  const [shareInfo, setShareInfo] = useState(null);
  const [filter, setFilter] = useState("all");
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const { addFilesWithPaths, addFiles } = useUploadContext();
  const folderUploadRef = useRef();

  const load = async () => {
    try {
      const qs = currentFolder ? `?folder_id=${currentFolder}` : "";
      const [filesRes, foldersRes] = await Promise.all([
        api(`/files${qs}`),
        api(`/folders${qs}`),
      ]);
      setFiles(filesRes.files);
      setFolders(foldersRes.folders);
      setBreadcrumb(foldersRes.breadcrumb);
    } catch (e) { setError(e.message); }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 6000);
    return () => clearInterval(interval);
  }, [currentFolder]);

  const toggleShare = async (file) => {
    const newVisibility = file.visibility === "public" ? "private" : "public";
    try {
      const res = await api(`/files/${file.id}/share`, { method: "POST", body: JSON.stringify({ visibility: newVisibility }) });
      await load();
      if (res.shareUrl) {
        setShareInfo({ file, url: res.shareUrl });
        navigator.clipboard?.writeText(res.shareUrl).catch(() => {});
      } else {
        setShareInfo(null);
      }
    } catch (e) { setError(e.message); }
  };

  const deleteFile = async (file) => {
    if (!confirm(`Remove "${file.filename}" from ${APP_NAME}? (Stays in your Telegram Saved Messages.)`)) return;
    try {
      await api(`/files/${file.id}`, { method: "DELETE" });
      await load();
    } catch (e) { setError(e.message); }
  };

  const startRename = (file) => {
    setRenamingId(file.id);
    setRenameValue(file.filename);
  };

  const submitRename = async (file) => {
    if (!renameValue.trim() || renameValue === file.filename) { setRenamingId(null); return; }
    try {
      await api(`/files/${file.id}`, { method: "PATCH", body: JSON.stringify({ filename: renameValue.trim() }) });
      setRenamingId(null);
      await load();
    } catch (e) { setError(e.message); }
  };

  const createFolder = async () => {
    if (!newFolderName.trim()) return;
    try {
      await api("/folders", { method: "POST", body: JSON.stringify({ name: newFolderName.trim(), parent_id: currentFolder }) });
      setNewFolderName("");
      setNewFolderOpen(false);
      await load();
    } catch (e) { setError(e.message); }
  };

  const deleteFolder = async (folder) => {
    if (!confirm(`Delete empty folder "${folder.name}"?`)) return;
    try {
      await api(`/folders/${folder.id}`, { method: "DELETE" });
      await load();
    } catch (e) { setError(e.message); }
  };

  const handleFolderUpload = (fileList) => addFilesWithPaths(fileList, currentFolder);
  const handleFilesHere = (fileList) => addFiles(fileList, { folderId: currentFolder });

  const filtered = files.filter((f) => {
    if (filter === "all") return true;
    if (filter === "video") return f.mimetype?.startsWith("video/");
    if (filter === "image") return f.mimetype?.startsWith("image/");
    if (filter === "other") return !f.mimetype?.startsWith("video/") && !f.mimetype?.startsWith("image/");
    return true;
  });

  return (
    <div className="page animate-in">
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <h2 style={{ margin: 0 }}>Library</h2>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {["all", "video", "image", "other"].map((f) => (
              <button key={f} className="btn btn-sm" style={filter === f ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}} onClick={() => setFilter(f)}>
                {f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="breadcrumb" style={{ marginTop: 14 }}>
          <a onClick={() => setCurrentFolder(null)}>🏠 Root</a>
          {breadcrumb.map((b) => (
            <React.Fragment key={b.id}>
              <span className="sep">/</span>
              <a onClick={() => setCurrentFolder(b.id)}>{b.name}</a>
            </React.Fragment>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          <button className="btn btn-sm" onClick={() => setNewFolderOpen((v) => !v)}>+ New folder</button>
          <button className="btn btn-sm" onClick={() => folderUploadRef.current.click()}>📁 Upload folder here</button>
          <label className="btn btn-sm" style={{ cursor: "pointer" }}>
            ⬆️ Upload files here
            <input type="file" multiple style={{ display: "none" }} onChange={(e) => e.target.files.length && handleFilesHere(e.target.files)} />
          </label>
          <input
            ref={folderUploadRef}
            type="file"
            webkitdirectory=""
            directory=""
            multiple
            style={{ display: "none" }}
            onChange={(e) => e.target.files.length && handleFolderUpload(e.target.files)}
          />
        </div>

        {newFolderOpen && (
          <div className="inline-edit" style={{ marginBottom: 16, maxWidth: 320 }}>
            <input
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createFolder()}
              autoFocus
            />
            <button className="btn btn-sm btn-primary" onClick={createFolder}>Create</button>
          </div>
        )}

        {error && <div className="error-box">{error}</div>}
        {shareInfo && (
          <div className="info-box">
            Link {shareInfo.file.visibility === "public" ? "copied to clipboard" : "removed"} for <strong>{shareInfo.file.filename}</strong>:
            {shareInfo.url && <div style={{ marginTop: 6 }}><a href={shareInfo.url} target="_blank" rel="noreferrer">{shareInfo.url}</a></div>}
          </div>
        )}

        {folders.length === 0 && filtered.length === 0 && <div className="empty-state">Nothing here yet.</div>}

        {folders.length > 0 && (
          <div className="file-grid" style={{ marginBottom: 16 }}>
            {folders.map((folder) => (
              <div key={folder.id} className="folder-card" onClick={() => setCurrentFolder(folder.id)}>
                <div className="folder-icon">📂</div>
                <div className="folder-name">{folder.name}</div>
                <button className="uw-icon-btn" onClick={(e) => { e.stopPropagation(); deleteFolder(folder); }}>✕</button>
              </div>
            ))}
          </div>
        )}

        <div className="file-grid">
          {filtered.map((f) => {
            const isImage = f.mimetype?.startsWith("image/");
            return (
              <div className="file-card" key={f.id} onClick={() => renamingId !== f.id && setPlaying(f)}>
                {isImage ? (
                  <img className="file-card-thumb" src={`/files/${f.id}/stream`} alt={f.filename} loading="lazy" />
                ) : (
                  <div className="file-card-icon">{fileIcon(f.mimetype)}</div>
                )}
                {renamingId === f.id ? (
                  <div className="inline-edit" onClick={(e) => e.stopPropagation()}>
                    <input
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && submitRename(f)}
                      autoFocus
                    />
                    <button className="btn btn-sm btn-primary" onClick={() => submitRename(f)}>✓</button>
                  </div>
                ) : (
                  <div className="file-card-name">{f.filename}</div>
                )}
                <div className="file-card-sub">{fmtSize(f.size)} · <span className={`badge ${f.visibility}`}>{f.visibility}</span></div>
                <div className="file-card-actions" onClick={(e) => e.stopPropagation()}>
                  <a className="btn btn-sm" href={`/files/${f.id}/stream?download=1`} download={f.filename}>⬇ Download</a>
                  <button className="btn btn-sm" onClick={() => toggleShare(f)}>{f.visibility === "public" ? "Unshare" : "Share"}</button>
                  <button className="btn btn-sm" onClick={() => startRename(f)}>Rename</button>
                  <button className="btn btn-sm btn-danger" onClick={() => deleteFile(f)}>Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <PlayerModal file={playing} onClose={() => setPlaying(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public viewer
// ---------------------------------------------------------------------------
function PublicViewer({ token }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/public/${token}/info`)
      .then((r) => { if (!r.ok) throw new Error("This link is invalid, private, or has been removed."); return r.json(); })
      .then(setInfo)
      .catch((e) => setError(e.message));
  }, [token]);

  const src = `/public/${token}`;
  const isVideo = info?.mimetype?.startsWith("video/");
  const isImage = info?.mimetype?.startsWith("image/");
  const isAudio = info?.mimetype?.startsWith("audio/");

  return (
    <div className="page animate-in">
      <div className="card public-page">
        {error && <div className="error-box">{error}</div>}
        {!error && !info && <p className="hint">Loading…</p>}
        {info && (
          <>
            <h3 style={{ wordBreak: "break-all" }}>{info.filename}</h3>
            <p className="hint">{fmtSize(info.size)}</p>
            {isVideo && <video src={src} controls style={{ width: "100%", borderRadius: 8, background: "black" }} />}
            {isAudio && <audio src={src} controls style={{ width: "100%" }} />}
            {isImage && <img src={src} alt={info.filename} style={{ width: "100%", borderRadius: 8 }} />}
            {!isVideo && !isAudio && !isImage && <p>Preview not available for this file type.</p>}
            <div style={{ marginTop: 16 }}>
              <a className="btn btn-primary" href={src} download={info.filename}>Download</a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Docs page
// ---------------------------------------------------------------------------
function Docs() {
  const sections = ["overview", "quickstart", "how-it-works", "folders", "rename", "multi-upload", "cancel", "sharing", "speed", "admin", "security-tips", "github", "credits"];
  return (
    <div className="page animate-in">
      <div className="docs-layout">
        <div className="docs-toc">
          {sections.map((s) => (
            <a key={s} onClick={() => document.getElementById(s)?.scrollIntoView({ behavior: "smooth" })}>{s.replace("-", " ")}</a>
          ))}
        </div>
        <div className="docs-content">
          <h2 id="overview">Overview</h2>
          <p>
            {APP_NAME} turns your own Telegram account into free, effectively unlimited cloud
            storage. Files upload straight to your Telegram <strong>Saved Messages</strong>,
            stream back with full seek support, and can be shared publicly or kept private —
            without your files ever sitting on our server disk.
          </p>

          <h2 id="quickstart">Quickstart</h2>
          <p>Backend:</p>
          <pre><code>{`cd backend
cp .env.example .env   # add TG_API_ID, TG_API_HASH, two random secrets
npm install
npm start`}</code></pre>
          <p>Frontend:</p>
          <pre><code>{`cd frontend
npm install
npm run dev`}</code></pre>
          <div className="tip-box">💡 Tip: get <code>TG_API_ID</code>/<code>TG_API_HASH</code> free at my.telegram.org — takes under 2 minutes.</div>

          <h2 id="how-it-works">How it works</h2>
          <p>
            Login uses Telegram's real MTProto protocol (via the <code>telegram</code> / GramJS
            library) — the same flow the official Telegram apps use — instead of the Bot API,
            which caps downloads at 20MB. That's why large videos work here.
          </p>
          <pre><code>{`await client.sendFile("me", {
  file: filePath,
  workers: 12,           // 12 parallel parts = faster upload
  progressCallback: onProgress,
});`}</code></pre>

          <h2 id="folders">Folders</h2>
          <p>
            Create folders from the Library page, navigate into them, and upload directly
            inside one. You can also upload an entire folder from your computer at once — the
            folder structure is recreated automatically on the server side from each file's
            relative path.
          </p>

          <h2 id="rename">Renaming files</h2>
          <p>
            Renaming a file updates it in <strong>both</strong> places: your local database and
            the actual Telegram message caption in Saved Messages (via <code>messages.EditMessage</code>),
            so the name stays consistent whether you view it here or directly in Telegram.
          </p>

          <h2 id="multi-upload">Multiple files & background uploads</h2>
          <p>
            The Upload page accepts multiple files at once. Upload progress lives in a floating
            tray in the corner, not tied to any single page, so you can navigate anywhere else
            on the site while uploads keep running. Minimize it to a slim strip, or enlarge it
            to see every file's status at once.
          </p>

          <h2 id="cancel">Cancelling an upload</h2>
          <p>
            Each in-progress upload has a ✕ button. If it's still in the browser→server leg,
            cancelling is instant. If it has already moved into the server→Telegram leg, cancel
            is best-effort: the server force-disconnects that upload's Telegram connection,
            which stops the transfer, and a fresh connection is made automatically next time.
          </p>

          <h2 id="sharing">Sharing</h2>
          <p>
            Toggling a file to <strong>public</strong> generates a random share token and a link
            at <code>/public/&lt;token&gt;</code>, viewable with no login. Toggle back to{" "}
            <strong>private</strong> any time to revoke it.
          </p>
          <div className="tip-box">
            💡 If a share link doesn't load: check <code>PUBLIC_BASE_URL</code> in your backend's{" "}
            <code>.env</code> points at your frontend's real address, not the backend port.
          </div>

          <h2 id="speed">Upload speed</h2>
          <p>
            Uploads have two legs: browser → our server (fast) and our server → Telegram (the
            real bottleneck). Live speed/ETA shown is driven by GramJS's actual{" "}
            <code>progressCallback</code> during the real Telegram upload, streamed to the
            browser over Server-Sent Events — not a guess based on the fast local leg.
          </p>

          <h2 id="admin">Admin panel</h2>
          <p>
            A separate monitoring dashboard lives at <code>/admin</code>, with its own login
            (kept fully independent from user auth). It intentionally shows{" "}
            <strong>metadata only</strong> — user count, storage used per account, file counts,
            last-active times, and a full file listing. It never decrypts or displays a user's
            Telegram session string, because that string is equivalent to a live login to their
            real Telegram account — no admin panel should be able to read or reuse it.
          </p>
          <div className="tip-box">
            💡 Default admin credentials are set via <code>ADMIN_ID</code>/<code>ADMIN_PASSWORD</code>{" "}
            in <code>backend/.env</code>. Change the password before deploying this anywhere
            public — a hardcoded/default admin login is a real risk if the source is ever shared.
          </div>


          <ul>
            <li>The encrypted session stored per user is equivalent to a live Telegram login — protect <code>SESSION_ENCRYPT_KEY</code> like a database credential.</li>
            <li>Never commit your real <code>.env</code> file or paste API credentials into public chats/issues.</li>
            <li>Add rate limiting and retry/backoff for Telegram's <code>FLOOD_WAIT</code> errors before opening this to many strangers.</li>
            <li>Consider a secondary login method — losing Telegram access currently means losing {APP_NAME} access too.</li>
          </ul>

          <h2 id="github">Source & Development</h2>
          <p>
            Full source is on GitHub: <a href={GITHUB_REPO} target="_blank" rel="noreferrer">{GITHUB_REPO}</a>.
            Clone it, open issues, or submit pull requests there.
          </p>
          <ul>
            <li>Discuss or follow updates on Telegram: <a href={TG_CHANNEL_2} target="_blank" rel="noreferrer">t.me/shreeapi</a> and <a href={TG_CHANNEL_1} target="_blank" rel="noreferrer">t.me/nepalimomoswala</a>.</li>
            <li>Add a <code>.env.example</code> (already included) — never commit real secrets.</li>
            <li>Consider a "Deploy" button (Render/Railway/Fly.io) once you've added persistent storage beyond the local JSON db.</li>
          </ul>

          <h2 id="credits">Credits</h2>
          <p>{APP_NAME} — Powered by <strong>ShreeAPI</strong> · Designed by <strong>AnshAPI</strong>.</p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  const path = useRoute();
  const [loggedIn, setLoggedIn] = useState(null);
  const [theme, setTheme] = useTheme();
  const uploadManager = useUploadManager();

  useEffect(() => {
    api("/auth/me").then((r) => setLoggedIn(r.loggedIn));
  }, []);

  useEffect(() => {
    if (loggedIn === true && path === "/login") navigate("/library");
    if (loggedIn === false && (path === "/upload" || path === "/library")) navigate("/login");
  }, [loggedIn, path]);

  const publicMatch = path.match(/^\/public\/([^/]+)/);
  const isAdminRoute = path === "/admin";

  const logout = async () => {
    await api("/auth/logout", { method: "POST" });
    setLoggedIn(false);
    navigate("/");
  };

  if (isAdminRoute) {
    return (
      <>
        <BubbleBackground />
        <div className="app-shell">
          <AdminPanel />
        </div>
      </>
    );
  }

  let body;
  if (publicMatch) body = <PublicViewer token={publicMatch[1]} />;
  else if (path === "/login") body = <LoginForm onLoggedIn={() => setLoggedIn(true)} />;
  else if (path === "/upload") body = loggedIn ? <UploadPage /> : null;
  else if (path === "/library") body = loggedIn ? <Library /> : null;
  else if (path === "/docs") body = <Docs />;
  else body = <Landing />;

  return (
    <UploadContext.Provider value={uploadManager}>
      <BubbleBackground />
      <div className="app-shell">
        {!publicMatch && <NavBar loggedIn={!!loggedIn} onLogout={logout} path={path} theme={theme} setTheme={setTheme} />}
        {body}
        {!publicMatch && <Footer />}
      </div>
      <UploadWidget />
    </UploadContext.Provider>
  );
}
