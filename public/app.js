/* Deck frontend — zero deps. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var state = { apps: [], conflicts: {}, wire: [], scanFrom: 3000, scanTo: 3030 };
  var sheetCtx = null; // {kind, appId, ...}

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function toast(msg, isErr) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.toggle("error", !!isErr);
    t.hidden = false;
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.hidden = true; }, 2600);
  }

  async function api(path, opts) {
    var r = await fetch(path, opts);
    var data = null;
    try { data = await r.json(); } catch (e) {}
    if (!r.ok || (data && data.error)) throw new Error((data && data.error) || ("HTTP " + r.status));
    return data;
  }

  function fmtUptime(s) {
    if (s == null) return "stopped";
    if (s < 60) return s + "s up";
    if (s < 3600) return Math.floor(s / 60) + "m up";
    if (s < 86400) return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m up";
    return Math.floor(s / 86400) + "d up";
  }

  /* ---------- fleet list ---------- */
  function render() {
    var apps = state.apps;
    var running = apps.filter(function (a) { return a.running; }).length;
    $("fleet-summary").innerHTML =
      "<strong>" + running + " running</strong> · " + (apps.length - running) + " stopped";

    // conflicts
    var banner = $("conflict-banner");
    var ports = Object.keys(state.conflicts || {});
    if (ports.length) {
      var names = ports.map(function (pt) {
        var ids = state.conflicts[pt];
        var ns = ids.map(function (id) {
          var a = apps.find(function (x) { return x.id === id; });
          return a ? esc(a.name) : "#" + id;
        }).join(", ");
        return ":" + pt + " → " + ns;
      }).join(" · ");
      banner.innerHTML = "⚠ Port conflict — " + names + ". Only one app can hold a port.";
      banner.hidden = false;
    } else banner.hidden = true;

    var wrap = $("apps");
    if (!apps.length) {
      wrap.innerHTML = '<p class="muted">No apps registered. Tap ＋ to add one, or wait for auto-discovery.</p>';
      return;
    }
    wrap.innerHTML = apps.map(function (a) {
      var conflict = ports.some(function (pt) { return (state.conflicts[pt] || []).indexOf(a.id) >= 0; });
      var dirShort = esc(a.dir.replace(/^.*\/workspace\/your_files\//, "~/"));
      return '<article class="card' + (a.running ? " running" : "") + '" data-id="' + a.id + '">' +
        '<div class="card-top">' +
          '<span class="dot" aria-hidden="true"></span>' +
          '<span class="card-name">' + esc(a.name) + '</span>' +
          (conflict ? '<span class="conflict-flag" title="Port conflict">⚠</span>' : "") +
          '<span class="port-badge">:' + a.port + "</span>" +
        "</div>" +
        '<p class="card-meta"><span>' + fmtUptime(a.uptime_s) + "</span>" +
          (a.pid ? '<span class="mono">pid ' + a.pid + (a.adopted ? " (adopted)" : "") + "</span>" : "") +
          '<span class="mono">' + dirShort + "</span></p>" +
        '<div class="card-actions">' +
          '<button class="btn toggle' + (a.running ? " is-running" : "") + '" data-act="toggle">' +
            (a.running ? "Stop" : "Start") + "</button>" +
          '<button class="btn small ghost" data-act="restart" title="Restart">↻</button>' +
          '<button class="btn small ghost" data-act="env" title="Environment">⚙</button>' +
          '<button class="btn small ghost" data-act="logs" title="Logs">≣</button>' +
          '<button class="btn small ghost" data-act="edit" title="Settings">✎</button>' +
        "</div></article>";
    }).join("");
  }

  async function refresh() {
    try {
      var d = await api("/api/apps");
      state.apps = d.apps;
      state.conflicts = d.conflicts || {};
      render();
    } catch (e) {
      $("fleet-summary").textContent = "Couldn't reach Deck server: " + e.message;
    }
  }

  /* ---------- sheet ---------- */
  function openSheet(title, html, ctx) {
    $("sheet-title").textContent = title;
    $("sheet-body").innerHTML = html;
    $("sheet").hidden = false;
    $("sheet-backdrop").hidden = false;
    document.body.style.overflow = "hidden";
    sheetCtx = ctx || null;
  }
  function closeSheet() {
    $("sheet").hidden = true;
    $("sheet-backdrop").hidden = true;
    document.body.style.overflow = "";
    if (sheetCtx && sheetCtx.onClose) { var f = sheetCtx.onClose; sheetCtx = null; f(); }
    sheetCtx = null;
  }
  $("sheet-close").addEventListener("click", closeSheet);
  $("sheet-backdrop").addEventListener("click", closeSheet);

  /* ---------- app actions ---------- */
  async function toggleApp(id, btn) {
    var a = state.apps.find(function (x) { return x.id === id; });
    if (!a) return;
    btn.classList.add("busy");
    try {
      var d = await api("/api/apps/" + id + (a.running ? "/stop" : "/start"), { method: "POST" });
      var i = state.apps.findIndex(function (x) { return x.id === id; });
      state.apps[i] = d.app;
      render();
      toast(a.name + (a.running ? " stopped" : " started on :" + d.app.port));
    } catch (e) {
      toast("Couldn't " + (a.running ? "stop " : "start ") + a.name + ": " + e.message, true);
    }
  }

  async function restartApp(id) {
    var a = state.apps.find(function (x) { return x.id === id; });
    toast("Restarting " + (a ? a.name : "app") + "…");
    try {
      var d = await api("/api/apps/" + id + "/restart", { method: "POST" });
      var i = state.apps.findIndex(function (x) { return x.id === id; });
      state.apps[i] = d.app;
      render();
      toast((a ? a.name : "App") + " restarted");
    } catch (e) {
      toast("Restart failed: " + e.message, true);
      refresh();
    }
  }

  $("apps").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var card = e.target.closest(".card");
    var id = Number(card.getAttribute("data-id"));
    var act = btn.getAttribute("data-act");
    if (act === "toggle") toggleApp(id, btn);
    else if (act === "restart") restartApp(id);
    else if (act === "env") openEnv(id);
    else if (act === "logs") openLogs(id);
    else if (act === "edit") openEdit(id);
  });

  /* ---------- env editor ---------- */
  var envRows = []; // {key, secret, revealed, value, keep, deleted, isNew}

  function envRowHtml(r, i) {
    var valHtml;
    if (r.secret && !r.revealed) {
      valHtml = '<input type="password" value="••••••••" disabled aria-label="masked secret value">' +
        '<button class="icon-btn" data-env="reveal" data-i="' + i + '" title="Reveal">👁</button>';
    } else {
      valHtml = '<input type="text" data-env="val" data-i="' + i + '" value="' + esc(r.value) + '" placeholder="value" aria-label="value for ' + esc(r.key) + '">';
    }
    return '<div class="env-row">' +
      '<span class="env-key" title="' + esc(r.key) + '">' + esc(r.key) + "</span>" +
      '<span class="env-val">' + valHtml + "</span>" +
      '<button class="icon-btn" data-env="del" data-i="' + i + '" title="Delete">✕</button>' +
      "</div>";
  }

  async function openEnv(id) {
    var a = state.apps.find(function (x) { return x.id === id; });
    var d;
    try { d = await api("/api/apps/" + id + "/env"); }
    catch (e) { toast("Couldn't load env: " + e.message, true); return; }
    envRows = d.vars.map(function (v) {
      return { key: v.key, secret: v.secret, revealed: false, value: v.secret ? "" : v.value, keep: v.secret };
    });
    openSheet("⚙ " + a.name + " — env", "", { kind: "env", appId: id, envPath: d.path });
    paintEnv();
  }

  function paintEnv() {
    if (!sheetCtx || sheetCtx.kind !== "env") return;
    $("sheet-body").innerHTML = renderEnv({ path: sheetCtx.envPath || "" });
  }

  function renderEnv(d) {
    var rows = envRows.map(envRowHtml).join("");
    return '<div class="env-note">Reads <span class="mono">' + esc(d.path) + "</span>. " +
      "Secrets stay masked — reveal only the ones you need to change. " +
      "<strong>PORT is managed by Deck</strong> (injected at start from the registered port); a PORT line would be ignored.</div>" +
      '<div id="env-rows">' + (rows || '<p class="muted">No variables yet — add the first below.</p>') + "</div>" +
      '<div class="env-add">' +
        '<input type="text" id="new-key" placeholder="KEY" aria-label="New key" style="flex:0 0 38%">' +
        '<input type="text" id="new-val" placeholder="value" aria-label="New value">' +
        '<button class="icon-btn" id="add-var" title="Add variable">＋</button>' +
      "</div>" +
      '<div class="env-actions"><button class="btn primary" id="save-env">Save env</button></div>' +
      '<div id="env-msg" class="fine muted" style="margin-top:10px"></div>';
  }

  $("sheet-body").addEventListener("click", async function (e) {
    var b = e.target.closest("[data-env]");
    if (b) {
      var i = Number(b.getAttribute("data-i"));
      var act = b.getAttribute("data-env");
      var r = envRows[i];
      if (act === "reveal" && sheetCtx && sheetCtx.kind === "env") {
        try {
          var d = await api("/api/apps/" + sheetCtx.appId + "/env/reveal", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: r.key }),
          });
          r.revealed = true; r.value = d.value; r.keep = false;
          b.closest(".env-row").outerHTML = envRowHtml(r, i);
        } catch (err) { toast("Reveal failed: " + err.message, true); }
      } else if (act === "del") {
        if (!confirm('Delete "' + r.key + '" from .env?')) return;
        envRows.splice(i, 1);
        paintEnv();
      }
      return;
    }
    if (e.target.id === "add-var") {
      var k = $("new-key").value.trim();
      var v = $("new-val").value;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { toast("Key must look like ENV_VAR", true); return; }
      if (k === "PORT") { toast("PORT is managed by Deck — set it on the app card instead", true); return; }
      if (envRows.some(function (x) { return x.key === k; })) { toast("Key already exists", true); return; }
      envRows.push({ key: k, secret: false, revealed: true, value: v, keep: false });
      paintEnv();
      return;
    }
    if (e.target.id === "save-env" && sheetCtx && sheetCtx.kind === "env") {
      // harvest edited values
      document.querySelectorAll('[data-env="val"]').forEach(function (inp) {
        var idx = Number(inp.getAttribute("data-i"));
        if (envRows[idx]) { envRows[idx].value = inp.value; envRows[idx].keep = false; }
      });
      var payload = envRows.map(function (x) {
        return x.keep ? { key: x.key, keep: true } : { key: x.key, value: x.value };
      });
      e.target.classList.add("busy");
      e.target.textContent = "Saving…";
      try {
        var res = await api("/api/apps/" + sheetCtx.appId + "/env", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vars: payload }),
        });
        var msg = "Saved " + res.count + " variables.";
        if (res.restart_needed) msg += " Restart the app to apply.";
        $("env-msg").textContent = msg;
        if (res.restart_needed) {
          var btn = document.createElement("button");
          btn.className = "btn primary";
          btn.style.marginTop = "10px";
          btn.textContent = "Restart now";
          var rid = sheetCtx.appId;
          btn.onclick = function () { closeSheet(); restartApp(rid); };
          $("env-msg").appendChild(document.createElement("br"));
          $("env-msg").appendChild(btn);
        }
        toast("Env saved");
      } catch (err) {
        toast("Save failed: " + err.message, true);
        e.target.classList.remove("busy");
        e.target.textContent = "Save env";
      }
    }
  });

  /* ---------- logs ---------- */
  var logTimer = null;
  async function openLogs(id) {
    var a = state.apps.find(function (x) { return x.id === id; });
    openSheet("≣ " + a.name + " — logs",
      '<div class="log-bar"><button class="btn small" id="log-refresh">↻ Refresh</button>' +
      '<label class="fine muted" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="log-follow" checked> follow</label></div>' +
      '<div class="log-view" id="log-view"><span class="muted">Loading…</span></div>',
      { kind: "logs", appId: id, onClose: function () { clearInterval(logTimer); logTimer = null; } });
    async function load() {
      try {
        var d = await api("/api/apps/" + id + "/logs?lines=300");
        var v = $("log-view");
        if (!v) return;
        v.textContent = d.lines.length ? d.lines.join("\n") : "(no output yet)";
        if ($("log-follow") && $("log-follow").checked) v.scrollTop = v.scrollHeight;
      } catch (e) { /* sheet may be closed */ }
    }
    await load();
    var rb = $("log-refresh");
    if (rb) rb.addEventListener("click", load);
    clearInterval(logTimer);
    logTimer = setInterval(load, 3000);
  }

  /* ---------- add / edit app ---------- */
  function appFormHtml(a, candidates) {
    var cand = (candidates || []).map(function (c) {
      return '<option value="' + esc(c.dir) + '">' + esc(c.name) + "</option>";
    }).join("");
    return '<div class="field"><label>Directory</label>' +
      '<input type="text" id="f-dir" list="dir-candidates" value="' + esc(a ? a.dir : "") + '" placeholder="/home/…/my-app">' +
      '<datalist id="dir-candidates">' + cand + "</datalist></div>" +
      '<div class="field"><label>Name</label><input type="text" id="f-name" value="' + esc(a ? a.name : "") + '" placeholder="my-app"></div>' +
      '<div class="field"><label>Port</label><input type="text" id="f-port" inputmode="numeric" value="' + (a ? a.port : "") + '" placeholder="3001"></div>' +
      '<div class="field"><label>Start command</label><input type="text" id="f-cmd" value="' + esc(a ? a.start_cmd : "bun src/server.ts") + '"></div>' +
      '<div class="form-actions">' +
      (a ? '<button class="btn danger" id="f-delete">Delete</button>' : "") +
      '<button class="btn primary" id="f-save">' + (a ? "Save" : "Add app") + "</button></div>";
  }

  async function openAdd() {
    var cands = [];
    try { cands = (await api("/api/discover")).candidates; } catch (e) {}
    openSheet("＋ Add app", appFormHtml(null, cands), { kind: "add" });
    wireForm(null);
  }

  async function openEdit(id) {
    var a = state.apps.find(function (x) { return x.id === id; });
    openSheet("✎ " + a.name, appFormHtml(a, []), { kind: "edit", appId: id });
    wireForm(a);
  }

  function wireForm(a) {
    $("f-save").addEventListener("click", async function () {
      var body = {
        name: $("f-name").value.trim(),
        dir: $("f-dir").value.trim(),
        port: Number($("f-port").value),
        start_cmd: $("f-cmd").value.trim() || "bun src/server.ts",
      };
      if (!body.name || !body.dir || !body.port) { toast("Name, directory and port are required", true); return; }
      try {
        if (a) await api("/api/apps/" + a.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        else await api("/api/apps", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        closeSheet();
        await refresh();
        toast(a ? "Saved" : "App added — tap Start when ready");
      } catch (e) { toast("Save failed: " + e.message, true); }
    });
    var del = $("f-delete");
    if (del) del.addEventListener("click", async function () {
      if (!confirm('Delete "' + a.name + '" from Deck? (Stops it first. The app files are untouched.)')) return;
      try {
        await api("/api/apps/" + a.id, { method: "DELETE" });
        closeSheet();
        await refresh();
        toast(a.name + " removed");
      } catch (e) { toast("Delete failed: " + e.message, true); }
    });
    // auto-fill name from directory
    $("f-dir").addEventListener("change", function () {
      if ($("f-name").value) return;
      var d = $("f-dir").value.replace(/\/$/, "");
      $("f-name").value = d.split("/").pop() || "";
    });
  }

  $("add-btn").addEventListener("click", openAdd);

  /* ---------- port scan ---------- */
  function renderWire(hits) {
    var list = $("wire-list");
    var orphans = hits.filter(function (h) { return h.app_id == null; });
    state.wire = orphans;
    if (!orphans.length) {
      list.innerHTML = '<p class="muted">Nothing unregistered on the wire. ' +
        hits.length + " listener" + (hits.length === 1 ? "" : "s") + " found, all accounted for.</p>";
      return;
    }
    list.innerHTML = orphans.map(function (h, i) {
      return '<div class="wire-row"><span class="port-badge">:' + h.port + "</span>" +
        '<span class="title">' + esc(h.title || "unknown service") + "</span>" +
        '<button class="btn small" data-adopt="' + i + '">Adopt</button></div>';
    }).join("");
  }

  $("wire-list").addEventListener("click", async function (e) {
    var b = e.target.closest("[data-adopt]");
    if (!b) return;
    var h = state.wire[Number(b.getAttribute("data-adopt"))];
    if (!h) return;
    var name = prompt("Name for :" + h.port + ":", (h.title || "app").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app");
    if (!name) return;
    var dir = prompt("App directory (full path):", "");
    if (!dir) return;
    try {
      await api("/api/apps", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name, dir: dir, port: h.port, start_cmd: "bun src/server.ts" }),
      });
      await refresh();
      renderWire([]);
      $("wire-list").innerHTML = '<p class="muted">Adopted. Hit ⌁ Scan again to confirm.</p>';
      toast(name + " adopted");
    } catch (err) { toast("Adopt failed: " + err.message, true); }
  });

  async function scan() {
    var btn = $("scan-btn");
    btn.classList.add("busy");
    var from = Math.max(1, Number($("scan-from").value) || 3000);
    var to = Math.min(65535, Number($("scan-to").value) || 3030);
    $("wire-list").innerHTML = '<p class="muted">Sweeping :' + from + "–:" + to + "…</p>";
    try {
      var d = await api("/api/scan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: from, to: to }),
      });
      renderWire(d.hits);
      var now = new Date();
      $("scan-info").textContent = "scanned :" + d.from + "–:" + d.to + " at " +
        now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } catch (e) {
      $("wire-list").innerHTML = '<p class="muted">Scan failed: ' + esc(e.message) + "</p>";
    }
    btn.classList.remove("busy");
  }
  $("scan-btn").addEventListener("click", scan);

  /* ---------- boot ---------- */
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !$("sheet").hidden) closeSheet();
  });
  refresh();
  setInterval(refresh, 15000);
})();
