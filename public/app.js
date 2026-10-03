/* Deck frontend — zero deps. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var state = { apps: [], conflicts: {}, wire: [], orphans: [], scanned: false, scanFrom: 3000, scanTo: 3030 };
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
    opts = opts || {};
    var noRedirect = !!opts.noAuthRedirect;
    var fetchOpts = {};
    for (var k in opts) if (k !== "noAuthRedirect" && Object.prototype.hasOwnProperty.call(opts, k)) fetchOpts[k] = opts[k];
    var r = await fetch(path, fetchOpts);
    var data = null;
    try { data = await r.json(); } catch (e) {}
    if (r.status === 401 && !noRedirect) {
      authed = false;
      showLogin();
      throw new Error("signed out");
    }
    if (!r.ok || (data && data.error)) throw new Error((data && data.error) || ("HTTP " + r.status));
    return data;
  }
  var authed = false;

  /* ---------- auth gate ---------- */
  function showAuth(html) {
    $("auth-body").innerHTML = html;
    $("auth").hidden = false;
  }
  function hideAuth() {
    $("auth").hidden = true;
    authed = true;
  }

  function codeInputHtml(btnLabel) {
    return '<div class="auth-err" id="auth-err"></div>' +
      '<input type="text" id="auth-code" class="code-input" inputmode="numeric" pattern="[0-9]*" ' +
      'maxlength="6" autocomplete="one-time-code" placeholder="••••••" aria-label="6-digit code">' +
      '<button class="btn primary" id="auth-go">' + btnLabel + "</button>";
  }

  function wireCodeInput(url, onOk) {
    var inp = $("auth-code");
    inp.focus();
    var busy = false;
    async function submit() {
      var code = inp.value.replace(/\D/g, "");
      if (code.length !== 6 || busy) return;
      busy = true;
      $("auth-err").textContent = "";
      $("auth-go").classList.add("busy");
      try {
        await api(url, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: code }), noAuthRedirect: true,
        });
        onOk();
      } catch (e) {
        $("auth-err").textContent = e.message;
        inp.value = "";
        inp.focus();
        busy = false;
        $("auth-go").classList.remove("busy");
      }
    }
    inp.addEventListener("input", function () {
      inp.value = inp.value.replace(/\D/g, "").slice(0, 6);
      if (inp.value.length === 6) submit();
    });
    $("auth-go").addEventListener("click", submit);
  }

  async function showSetup() {
    authed = false;
    showAuth('<h2>Two-factor setup</h2><p>Scan with your authenticator app, then enter the 6-digit code to confirm.</p><p class="muted">Loading…</p>');
    var d;
    try {
      d = await api("/api/auth/setup", { method: "POST", noAuthRedirect: true });
    } catch (e) {
      showAuth('<h2>Two-factor setup</h2><p class="auth-err">' + esc(e.message) + "</p>");
      return;
    }
    showAuth('<h2>Two-factor setup</h2>' +
      '<p>Scan with your authenticator app, then enter the 6-digit code to confirm.</p>' +
      '<div class="auth-qr">' + d.qr_svg + "</div>" +
      '<div class="auth-secret"><input type="text" id="auth-secret" readonly value="' + esc(d.secret) + '" aria-label="Manual setup key">' +
      '<button class="icon-btn" id="copy-secret" title="Copy">⧉</button></div>' +
      codeInputHtml("Enable two-factor"));
    var cp = $("copy-secret");
    if (cp) cp.addEventListener("click", function () {
      var s = $("auth-secret");
      s.select();
      try { document.execCommand("copy"); } catch (e) {}
      if (navigator.clipboard) navigator.clipboard.writeText(s.value).catch(function () {});
      toast("Setup key copied");
    });
    wireCodeInput("/api/auth/enable", function () {
      hideAuth();
      toast("Two-factor enabled — Deck is locked down");
      refresh();
    });
  }

  function showLogin() {
    if (!$("auth").hidden && $("auth-body").innerHTML.indexOf("auth-code") >= 0) return; // already showing
    authed = false;
    showAuth('<h2>Welcome back</h2><p>Enter the 6-digit code from your authenticator app.</p>' + codeInputHtml("Unlock"));
    wireCodeInput("/api/auth/login", function () {
      hideAuth();
      refresh();
    });
  }

  async function checkAuth() {
    var d;
    try {
      d = await api("/api/auth/status", { noAuthRedirect: true });
    } catch (e) {
      $("fleet-summary").textContent = "Couldn't reach Deck server.";
      return;
    }
    if (!d.configured) showSetup();
    else if (!d.authenticated) showLogin();
    else {
      hideAuth();
      refresh();
    }
  }

  $("lock-btn").addEventListener("click", function () {
    if (!authed) { checkAuth(); return; }
    openSheet("🔒 Session",
      '<p class="muted">Signed in. Sessions last 30 days on this browser.</p>' +
      '<div class="form-actions"><button class="btn" id="sess-out">Sign out</button>' +
      '<button class="btn danger" id="sess-disable">Disable two-factor</button></div>',
      { kind: "session" });
    $("sess-out").addEventListener("click", async function () {
      try { await api("/api/auth/logout", { method: "POST", noAuthRedirect: true }); } catch (e) {}
      closeSheet();
      showLogin();
    });
    $("sess-disable").addEventListener("click", async function () {
      var code = prompt("Enter your current 6-digit code to disable two-factor:");
      if (!code) return;
      try {
        await api("/api/auth/disable", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: code }), noAuthRedirect: true,
        });
        closeSheet();
        toast("Two-factor disabled");
        showSetup();
      } catch (e) { toast("Couldn't disable: " + e.message, true); }
    });
  });

  function fmtUptime(s) {
    if (s == null) return "stopped";
    if (s < 60) return s + "s up";
    if (s < 3600) return Math.floor(s / 60) + "m up";
    if (s < 86400) return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m up";
    return Math.floor(s / 86400) + "d up";
  }

  /* ---------- fleet list ---------- */
  function iconHtml(a, small) {
    var letter = esc(((a.name || "?").charAt(0) || "?").toUpperCase());
    return '<span class="app-icon-wrap' + (small ? " small" : "") + '">' +
      '<span class="app-fallback" aria-hidden="true">' + letter + "</span>" +
      '<img class="app-icon" src="/api/apps/' + a.id + '/icon" alt="" loading="lazy"' +
      ' onload="this.classList.add(\'loaded\')" onerror="this.remove()">' +
      '<span class="dot" aria-hidden="true"></span>' +
      "</span>";
  }

  function fleetSig() {
    return JSON.stringify(state.apps.map(function (a) {
      return [a.id, a.name, a.port, a.running ? 1 : 0, a.pid || 0, a.adopted ? 1 : 0];
    })) + "|" + Object.keys(state.conflicts || {}).sort().join(",");
  }
  var lastSig = "";
  var firstPaint = true;

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
      lastSig = "";
      return;
    }
    // skip DOM churn (and replaying entrance animations) when nothing changed —
    // the 15s poll must be invisible
    var sig = fleetSig();
    if (sig === lastSig && !firstPaint) return;
    lastSig = sig;
    firstPaint = false;
    wrap.classList.add("settled");
    wrap.innerHTML = apps.map(function (a, i) {
      var conflict = ports.some(function (pt) { return (state.conflicts[pt] || []).indexOf(a.id) >= 0; });
      return '<button class="card' + (a.running ? " running" : "") + '" data-id="' + a.id + '" style="animation-delay:' + Math.min(i * 35, 420) + 'ms">' +
        iconHtml(a) +
        '<span class="card-name">' + esc(a.name) + "</span>" +
        (conflict ? '<span class="conflict-flag" title="Port conflict">⚠</span>' : "") +
        '<span class="port-badge">:' + a.port + "</span>" +
        '<span class="card-chev" aria-hidden="true">›</span>' +
        "</button>";
    }).join("");
    renderWidgets();
  }

  /* ---------- glassy app detail sheet (stats live here) ---------- */
  function openApp(id) {
    var a = state.apps.find(function (x) { return x.id === id; });
    if (!a) return;
    var dirShort = esc(a.dir.replace(/^.*\/workspace\/your_files\//, "~/"));
    openSheet('<span style="display:inline-flex;align-items:center;gap:10px">' + iconHtml(a, true) + esc(a.name) + "</span>",
      '<div class="stat-grid">' +
        statHtml("Status", a.running ? "Running" : "Stopped") +
        statHtml("Uptime", fmtUptime(a.uptime_s)) +
        statHtml("Port", ":" + a.port, true) +
        statHtml("PID", a.pid ? String(a.pid) + (a.adopted ? " · adopted" : "") : "—", true) +
      "</div>" +
      '<p class="muted fine" style="margin:0 0 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + dirShort + "</p>" +
      '<div class="sheet-actions">' +
        '<button class="btn toggle' + (a.running ? " is-running" : "") + '" data-app-act="toggle" data-id="' + a.id + '">' + (a.running ? "Stop" : "Start") + "</button>" +
        '<div class="sheet-actions-row">' +
          '<button class="btn ghost" data-app-act="restart" data-id="' + a.id + '">↻ Restart</button>' +
          '<button class="btn ghost" data-app-act="env" data-id="' + a.id + '">⚙ Env</button>' +
        "</div>" +
        '<div class="sheet-actions-row">' +
          '<button class="btn ghost" data-app-act="logs" data-id="' + a.id + '">≣ Logs</button>' +
          '<button class="btn ghost" data-app-act="edit" data-id="' + a.id + '">✎ Settings</button>' +
        "</div>" +
      "</div>",
      { kind: "app", appId: id });
  }

  function statHtml(label, val, mono) {
    return '<div class="stat glass"><div class="w-label">' + label + '</div>' +
      '<div class="w-val' + (mono ? " mono" : "") + '">' + esc(val) + "</div></div>";
  }

  /* ---------- widget tray (fleet stats behind the ▦ icon) ---------- */
  function renderWidgets() {
    var tray = $("widgets");
    if (tray.hidden) return;
    var apps = state.apps;
    var running = apps.filter(function (a) { return a.running; }).length;
    var nConf = Object.keys(state.conflicts || {}).length;
    var nOrph = (state.orphans || []).length;
    var pct = apps.length ? Math.round((running / apps.length) * 100) : 0;
    tray.innerHTML =
      '<button class="widget glass" data-widget="fleet">' +
        '<div class="w-label">Fleet</div>' +
        '<div class="w-big">' + running + '<span class="dim">/' + apps.length + "</span></div>" +
        '<div class="w-sub">apps running</div>' +
        '<div class="w-bar"><i style="width:' + pct + '%"></i></div>' +
      "</button>" +
      '<button class="widget glass' + (nConf ? " warn" : "") + '" data-widget="conflicts">' +
        '<div class="w-label">Port conflicts</div>' +
        '<div class="w-big">' + nConf + "</div>" +
        '<div class="w-sub">' + (nConf ? "needs attention" : "all clear") + "</div>" +
      "</button>" +
      '<button class="widget glass" data-widget="orphans">' +
        '<div class="w-label">Stray listeners</div>' +
        '<div class="w-big">' + nOrph + "</div>" +
        '<div class="w-sub">' + (state.scanned ? "on the wire" : "tap ⌁ Scan") + "</div>" +
      "</button>";
  }

  $("widgets-btn").addEventListener("click", function () {
    var tray = $("widgets");
    tray.hidden = !tray.hidden;
    if (!tray.hidden) renderWidgets();
    try { localStorage.setItem("deck-widgets", tray.hidden ? "0" : "1"); } catch (e) {}
  });

  $("widgets").addEventListener("click", function (e) {
    var w = e.target.closest("[data-widget]");
    if (!w) return;
    var kind = w.getAttribute("data-widget");
    if (kind === "orphans" || kind === "conflicts") {
      document.querySelector(".wire").scrollIntoView({ behavior: "smooth", block: "start" });
      if (kind === "orphans" && !state.scanned) scan();
    }
  });

  /* ---------- theme: auto / light / dark ---------- */
  var THEMES = ["auto", "light", "dark"];
  var THEME_ICON = { auto: "◐", light: "☀", dark: "☾" };
  function applyTheme(t) {
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    var b = $("theme-btn");
    b.textContent = THEME_ICON[t];
    b.title = "Theme: " + t;
    try { localStorage.setItem("deck-theme", t); } catch (e) {}
  }
  (function initTheme() {
    var t = "auto";
    try { t = localStorage.getItem("deck-theme") || "auto"; } catch (e) {}
    if (THEMES.indexOf(t) < 0) t = "auto";
    applyTheme(t);
  })();
  $("theme-btn").addEventListener("click", function () {
    var cur = "auto";
    try { cur = localStorage.getItem("deck-theme") || "auto"; } catch (e) {}
    applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
  });

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
    $("sheet-title").innerHTML = title;
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
    var card = e.target.closest(".card");
    if (!card) return;
    openApp(Number(card.getAttribute("data-id")));
  });

  $("sheet-body").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-app-act]");
    if (!btn) return;
    var id = Number(btn.getAttribute("data-id"));
    var act = btn.getAttribute("data-app-act");
    if (act === "toggle") { toggleApp(id, btn); setTimeout(function () { if (!$("sheet").hidden && sheetCtx && sheetCtx.kind === "app") openApp(id); }, 600); }
    else if (act === "restart") { closeSheet(); restartApp(id); }
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
      state.orphans = d.hits || [];
      state.scanned = true;
      renderWidgets();
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
  try {
    if (localStorage.getItem("deck-widgets") === "1") {
      $("widgets").hidden = false;
      renderWidgets();
    }
  } catch (e) {}
  checkAuth();
  setInterval(function () { if (authed) refresh(); }, 15000);
})();
