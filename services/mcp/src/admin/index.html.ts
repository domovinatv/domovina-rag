// HTML template za /admin dashboard. TS template literal — bez bundler-a, bez
// template engine-a. Sva interaktivnost preko inline <script nonce="...">.
//
// CSP: per-request nonce → strict-dynamic ostaje OFF, ali script-src 'self' + nonce
// znači da bilo koji injected inline-script bez nonce-a neće runnati. style-src
// dopušta 'unsafe-inline' jer cijeli styling ide kroz <style> u dokumentu.

export function renderAdminPage(nonce: string): string {
  return `<!doctype html>
<html lang="hr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Domovina MCP Admin</title>
  <style>
    :root {
      --bg: #0f1115;
      --panel: #181b21;
      --panel-2: #1f232b;
      --border: #2a2f38;
      --text: #e6e9ef;
      --muted: #8a93a6;
      --accent: #5aa9ff;
      --danger: #ff6b6b;
      --ok: #4ade80;
      --warn: #fbbf24;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    header {
      padding: 16px 24px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    h1 { margin: 0; font-size: 18px; font-weight: 600; }
    main { padding: 24px; max-width: 1400px; margin: 0 auto; }
    section { margin-bottom: 32px; }
    section h2 {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin: 0 0 12px;
      font-weight: 600;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
    }
    .stat {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
    }
    .stat .label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
    }
    .stat .value {
      font-size: 22px;
      font-weight: 600;
      margin-top: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }
    th, td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
      vertical-align: top;
    }
    th {
      background: var(--panel-2);
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.05em;
    }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover { background: var(--panel-2); }
    code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    button {
      background: var(--panel-2);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 12px;
      cursor: pointer;
      font: inherit;
    }
    button:hover { border-color: var(--accent); }
    button.danger { color: var(--danger); border-color: var(--border); }
    button.danger:hover { background: var(--danger); color: white; border-color: var(--danger); }
    .row-actions { display: flex; gap: 6px; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      background: var(--panel-2);
      font-size: 11px;
      color: var(--muted);
    }
    .badge.system { background: rgba(90, 169, 255, 0.15); color: var(--accent); }
    .status-ok { color: var(--ok); }
    .status-warn { color: var(--warn); }
    .status-err { color: var(--danger); }
    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      gap: 12px;
    }
    .empty {
      padding: 24px;
      text-align: center;
      color: var(--muted);
    }
    .error-banner {
      background: rgba(255, 107, 107, 0.15);
      border: 1px solid var(--danger);
      color: var(--danger);
      padding: 12px 16px;
      border-radius: 8px;
      margin-bottom: 16px;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <header>
    <h1>Domovina MCP Admin</h1>
    <div>
      <button id="refresh-btn" type="button">Refresh</button>
      <button id="logout-btn" type="button">Logout</button>
    </div>
  </header>
  <main>
    <div id="error-banner" class="error-banner" style="display:none"></div>

    <section>
      <h2>Stats (last 24h)</h2>
      <div id="stats" class="stats">
        <div class="empty">Loading…</div>
      </div>
    </section>

    <section>
      <h2>Clients</h2>
      <div class="toolbar">
        <label><input type="checkbox" id="include-static"> include static-api-key</label>
      </div>
      <table id="clients-table">
        <thead>
          <tr>
            <th>client_id</th>
            <th>name</th>
            <th>active</th>
            <th>reqs</th>
            <th>last used</th>
            <th></th>
          </tr>
        </thead>
        <tbody><tr><td colspan="6" class="empty">Loading…</td></tr></tbody>
      </table>
    </section>

    <section>
      <h2>Recent audit (last 50)</h2>
      <table id="audit-table">
        <thead>
          <tr>
            <th>time</th>
            <th>client</th>
            <th>method</th>
            <th>path</th>
            <th>status</th>
            <th>latency</th>
            <th>ip</th>
          </tr>
        </thead>
        <tbody><tr><td colspan="7" class="empty">Loading…</td></tr></tbody>
      </table>
    </section>
  </main>

  <script nonce="${nonce}">
    const STORAGE_KEY = "mcp_admin_api_key";

    function getKey() {
      let key = localStorage.getItem(STORAGE_KEY);
      if (!key) {
        key = prompt("Admin API key:");
        if (key) localStorage.setItem(STORAGE_KEY, key);
      }
      return key;
    }

    async function apiFetch(path, init) {
      const key = getKey();
      if (!key) throw new Error("no api key");
      const r = await fetch(path, {
        ...init,
        headers: { ...(init && init.headers || {}), authorization: "Bearer " + key },
      });
      if (r.status === 401) {
        localStorage.removeItem(STORAGE_KEY);
        throw new Error("unauthorized (key cleared, refresh to re-enter)");
      }
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(r.status + " " + r.statusText + ": " + text);
      }
      return r.json();
    }

    function showError(msg) {
      const banner = document.getElementById("error-banner");
      banner.textContent = msg;
      banner.style.display = "block";
      setTimeout(() => { banner.style.display = "none"; }, 8000);
    }

    function fmtTime(ts) {
      if (!ts) return "—";
      const d = new Date(ts);
      const now = Date.now();
      const diff = now - d.getTime();
      if (diff < 60_000) return Math.floor(diff / 1000) + "s ago";
      if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m ago";
      if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "h ago";
      return d.toISOString().slice(0, 19).replace("T", " ");
    }

    function statusClass(code) {
      if (code >= 500) return "status-err";
      if (code >= 400) return "status-warn";
      return "status-ok";
    }

    async function loadStats() {
      try {
        const s = await apiFetch("/admin/api/stats");
        const errRate = s.requests_24h > 0
          ? ((s.errors_24h / s.requests_24h) * 100).toFixed(1) + "%"
          : "—";
        const el = document.getElementById("stats");
        el.innerHTML = "";
        const items = [
          ["Clients", s.clients_total + " (" + s.clients_dcr + " DCR)"],
          ["Active tokens", s.tokens_active],
          ["Expired tokens", s.tokens_expired],
          ["Requests 24h", s.requests_24h],
          ["Requests 1h", s.requests_1h],
          ["Errors 24h", s.errors_24h + " (" + errRate + ")"],
          ["P95 latency", s.p95_latency_ms_24h !== null ? s.p95_latency_ms_24h + " ms" : "—"],
        ];
        for (const [label, value] of items) {
          const div = document.createElement("div");
          div.className = "stat";
          const l = document.createElement("div");
          l.className = "label";
          l.textContent = label;
          const v = document.createElement("div");
          v.className = "value";
          v.textContent = String(value);
          div.appendChild(l);
          div.appendChild(v);
          el.appendChild(div);
        }
      } catch (e) {
        showError("stats: " + e.message);
      }
    }

    async function loadClients() {
      try {
        const includeStatic = document.getElementById("include-static").checked;
        const data = await apiFetch("/admin/api/clients?include_static=" + (includeStatic ? "true" : "false") + "&limit=200");
        const tbody = document.querySelector("#clients-table tbody");
        tbody.innerHTML = "";
        if (!data.clients.length) {
          tbody.innerHTML = '<tr><td colspan="6" class="empty">No clients.</td></tr>';
          return;
        }
        for (const c of data.clients) {
          const tr = document.createElement("tr");
          const isStatic = c.client_id === "static-api-key";

          const idCell = document.createElement("td");
          const idCode = document.createElement("code");
          idCode.textContent = c.client_id;
          idCell.appendChild(idCode);
          tr.appendChild(idCell);

          const nameCell = document.createElement("td");
          if (isStatic) {
            const b = document.createElement("span");
            b.className = "badge system";
            b.textContent = "system";
            nameCell.appendChild(b);
            nameCell.appendChild(document.createTextNode(" " + (c.client_name || "")));
          } else {
            nameCell.textContent = c.client_name || "—";
          }
          tr.appendChild(nameCell);

          const activeCell = document.createElement("td");
          activeCell.textContent = String(c.active_tokens);
          tr.appendChild(activeCell);

          const reqsCell = document.createElement("td");
          reqsCell.textContent = String(c.total_requests);
          tr.appendChild(reqsCell);

          const lastCell = document.createElement("td");
          lastCell.textContent = fmtTime(c.last_used_at);
          tr.appendChild(lastCell);

          const actionsCell = document.createElement("td");
          if (!isStatic) {
            const btn = document.createElement("button");
            btn.className = "danger";
            btn.type = "button";
            btn.textContent = "Revoke";
            btn.addEventListener("click", () => revokeClient(c.client_id, c.client_name));
            actionsCell.appendChild(btn);
          }
          tr.appendChild(actionsCell);

          tbody.appendChild(tr);
        }
      } catch (e) {
        showError("clients: " + e.message);
      }
    }

    async function revokeClient(clientId, name) {
      if (!confirm("Revoke client " + (name || clientId) + "?\\nOvo cascade-briše sve tokene tog klijenta.")) return;
      try {
        await apiFetch("/admin/api/clients/" + encodeURIComponent(clientId), { method: "DELETE" });
        await loadClients();
        await loadStats();
      } catch (e) {
        showError("revoke failed: " + e.message);
      }
    }

    async function loadAudit() {
      try {
        const data = await apiFetch("/admin/api/audit?limit=50");
        const tbody = document.querySelector("#audit-table tbody");
        tbody.innerHTML = "";
        if (!data.entries.length) {
          tbody.innerHTML = '<tr><td colspan="7" class="empty">No audit entries.</td></tr>';
          return;
        }
        for (const e of data.entries) {
          const tr = document.createElement("tr");

          const timeCell = document.createElement("td");
          const time = new Date(e.timestamp).toISOString().slice(11, 19);
          timeCell.appendChild(document.createTextNode(time + " "));
          const ago = document.createElement("span");
          ago.style.color = "var(--muted)";
          ago.textContent = "(" + fmtTime(e.timestamp) + ")";
          timeCell.appendChild(ago);
          tr.appendChild(timeCell);

          const clientCell = document.createElement("td");
          const code = document.createElement("code");
          code.textContent = e.client_id || "—";
          clientCell.appendChild(code);
          tr.appendChild(clientCell);

          const methodCell = document.createElement("td");
          methodCell.textContent = e.method;
          tr.appendChild(methodCell);

          const pathCell = document.createElement("td");
          const pathCode = document.createElement("code");
          pathCode.textContent = e.path;
          pathCell.appendChild(pathCode);
          tr.appendChild(pathCell);

          const statusCell = document.createElement("td");
          statusCell.className = statusClass(e.status_code);
          statusCell.textContent = String(e.status_code);
          tr.appendChild(statusCell);

          const latencyCell = document.createElement("td");
          latencyCell.textContent = (e.latency_ms !== null ? e.latency_ms + " ms" : "—");
          tr.appendChild(latencyCell);

          const ipCell = document.createElement("td");
          ipCell.className = "mono";
          ipCell.textContent = e.ip || "—";
          tr.appendChild(ipCell);

          tbody.appendChild(tr);
        }
      } catch (e) {
        showError("audit: " + e.message);
      }
    }

    function loadAll() {
      loadStats();
      loadClients();
      loadAudit();
    }

    document.getElementById("refresh-btn").addEventListener("click", loadAll);
    document.getElementById("logout-btn").addEventListener("click", () => {
      localStorage.removeItem(STORAGE_KEY);
      location.reload();
    });
    document.getElementById("include-static").addEventListener("change", loadClients);

    loadAll();
  </script>
</body>
</html>`;
}
