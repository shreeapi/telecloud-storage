import React, { useEffect, useState } from "react";

async function adminApi(path, opts = {}) {
  const res = await fetch(`/admin${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function fmtSize(bytes) {
  if (!bytes) return "0 MB";
  const mb = bytes / 1024 / 1024;
  if (mb > 1024) return (mb / 1024).toFixed(2) + " GB";
  return mb.toFixed(1) + " MB";
}
function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

function AdminLogin({ onLoggedIn }) {
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const login = async () => {
    setLoading(true);
    setError("");
    try {
      await adminApi("/login", { method: "POST", body: JSON.stringify({ id, password }) });
      onLoggedIn();
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  return (
    <div className="page animate-in">
      <div className="card auth-card">
        <h2>Admin Login</h2>
        <p className="hint">Metadata-only monitoring dashboard. Never exposes user Telegram sessions.</p>
        <input className="field" placeholder="Admin ID" value={id} onChange={(e) => setId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && login()} />
        <input className="field" placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && login()} />
        <button className="btn btn-primary" style={{ width: "100%" }} onClick={login} disabled={loading || !id || !password}>
          {loading ? "Checking…" : "Log in"}
        </button>
        {error && <div className="error-box">{error}</div>}
      </div>
    </div>
  );
}

function AdminDashboard({ onLogout }) {
  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [files, setFiles] = useState([]);
  const [tab, setTab] = useState("users");
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const [ov, us, fl] = await Promise.all([
        adminApi("/overview"),
        adminApi("/users"),
        adminApi("/files"),
      ]);
      setOverview(ov);
      setUsers(us.users);
      setFiles(fl.files);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 8000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="page animate-in">
      <div className="card" style={{ maxWidth: 1100 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>Admin — Monitoring</h2>
          <button className="btn btn-sm" onClick={onLogout}>Log out</button>
        </div>

        {error && <div className="error-box">{error}</div>}

        {overview && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 22 }}>
            {[
              ["Total users", overview.totalUsers],
              ["Total files", overview.totalFiles],
              ["Total storage", fmtSize(overview.totalStorageBytes)],
              ["Active today", overview.activeToday],
            ].map(([label, val]) => (
              <div key={label} className="feature-card" style={{ padding: 16 }}>
                <div className="hint" style={{ margin: 0 }}>{label}</div>
                <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{val}</div>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          <button className="btn btn-sm" style={tab === "users" ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}} onClick={() => setTab("users")}>Users</button>
          <button className="btn btn-sm" style={tab === "files" ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}} onClick={() => setTab("files")}>All Files</button>
        </div>

        {tab === "users" && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-dim)" }}>
                  <th style={{ padding: 8 }}>Phone</th>
                  <th style={{ padding: 8 }}>Files</th>
                  <th style={{ padding: 8 }}>Storage</th>
                  <th style={{ padding: 8 }}>Joined</th>
                  <th style={{ padding: 8 }}>Last active</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: 8 }}>{u.phone}</td>
                    <td style={{ padding: 8 }}>{u.fileCount}</td>
                    <td style={{ padding: 8 }}>{fmtSize(u.storageBytes)}</td>
                    <td style={{ padding: 8 }}>{fmtDate(u.created_at)}</td>
                    <td style={{ padding: 8 }}>{fmtDate(u.last_active)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {users.length === 0 && <div className="empty-state">No users yet.</div>}
          </div>
        )}

        {tab === "files" && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-dim)" }}>
                  <th style={{ padding: 8 }}>Filename</th>
                  <th style={{ padding: 8 }}>Owner</th>
                  <th style={{ padding: 8 }}>Size</th>
                  <th style={{ padding: 8 }}>Visibility</th>
                  <th style={{ padding: 8 }}>Uploaded</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.id} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: 8, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.filename}</td>
                    <td style={{ padding: 8 }}>{f.ownerPhone}</td>
                    <td style={{ padding: 8 }}>{fmtSize(f.size)}</td>
                    <td style={{ padding: 8 }}><span className={`badge ${f.visibility}`}>{f.visibility}</span></td>
                    <td style={{ padding: 8 }}>{fmtDate(f.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {files.length === 0 && <div className="empty-state">No files yet.</div>}
          </div>
        )}

        <p className="hint" style={{ marginTop: 18 }}>
          This dashboard shows metadata only. It never decrypts or displays user Telegram
          sessions — that data grants live account access and is intentionally kept out of
          reach here, even for admins.
        </p>
      </div>
    </div>
  );
}

export default function AdminPanel() {
  const [loggedIn, setLoggedIn] = useState(null);

  useEffect(() => {
    adminApi("/me").then((r) => setLoggedIn(r.isAdmin)).catch(() => setLoggedIn(false));
  }, []);

  const logout = async () => {
    await adminApi("/logout", { method: "POST" });
    setLoggedIn(false);
  };

  if (loggedIn === null) return null;
  return loggedIn ? <AdminDashboard onLogout={logout} /> : <AdminLogin onLoggedIn={() => setLoggedIn(true)} />;
}
