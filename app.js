/* Orbit — editorial ledger. Focus, reading, breath, caffeine, projects.
   Shares the Focus Supabase project + the same sync phrase.
   Presentation rewrite; data layer unchanged. */
(function () {
  "use strict";
  // Backend config is supplied at runtime by config.js (see config.example.js).
  // config.js is gitignored so credentials are never committed.
  const CFG = (typeof window !== "undefined" && window.ORBIT_CONFIG) || {};
  const SB_URL = CFG.SUPABASE_URL || "";
  const SB_KEY = CFG.SUPABASE_KEY || "";
  if (!SB_URL || !SB_KEY) console.error("Orbit: missing Supabase config. Copy config.example.js to config.js and fill in your project URL + publishable key. See SUPABASE_SETUP.md.");
  const K = (n) => "orbit." + n;

  // caffeine is coffee-only; the cup's mg is configurable in settings
  const PATTERNS = [
    { id: "calm", name: "3·2·5", inhale: 3, hold1: 2, exhale: 5, hold2: 0 },
    { id: "box", name: "Box", inhale: 4, hold1: 4, exhale: 4, hold2: 4 },
    { id: "478", name: "4·7·8", inhale: 4, hold1: 7, exhale: 8, hold2: 0 },
    { id: "deep", name: "4·6", inhale: 4, hold1: 0, exhale: 6, hold2: 0 },
    { id: "med", name: "Meditate", kind: "meditation", inhale: 0, hold1: 0, exhale: 0, hold2: 0 },
  ];
  const DURATIONS = [3, 5, 10, 15];
  const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const DL = ["M", "T", "W", "T", "F", "S", "S"];

  let vault = localStorage.getItem(K("vault")) || null;
  let settings = Object.assign({ focusMin: 50, breakMin: 10, soundOn: true, coffeeMg: 95 }, readJSON(K("settings"), {}));
  let lastSyncAt = null;

  let focusBlocks = [], books = [], readSess = [], wellSess = [], cafLogs = [], projects = [], projSess = [];
  let curBookId = localStorage.getItem(K("curBook")) || "";
  let curProjId = localStorage.getItem(K("curProj")) || "";
  let custom = readJSON(K("patterns"), []);
  let selPat = localStorage.getItem(K("selPat")) || "calm";
  let durMin = parseInt(localStorage.getItem(K("durMin"))) || 5;
  let editBook = null, editRating = null, pendingRead = null, editProj = null, pendingProj = null;
  let wakeLock = null, actx = null;

  const $ = (id) => document.getElementById(id);
  function readJSON(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch { return d; } }
  const pad = (n) => String(n).padStart(2, "0");
  function localDateStr(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function startOfWeek(d) { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  function wd(d) { return (d.getDay() + 6) % 7; }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function fmtMin(sec) { const m = Math.round(sec / 60); if (m < 60) return m + "m"; const h = Math.floor(m / 60), r = m % 60; return r ? h + "h" + pad(r) : h + "h"; }
  function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2200); }

  /* ---------- crypto / rpc / sync (unchanged data layer) ---------- */
  async function deriveVault(p) { const d = new TextEncoder().encode("focus-vault:" + p.trim().toLowerCase()); const b = await crypto.subtle.digest("SHA-256", d); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
  async function rpc(fn, args) { const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" }, body: JSON.stringify(args) }); if (!r.ok) throw new Error(`${fn} ${r.status}`); const t = await r.text(); return t ? JSON.parse(t) : null; }
  function setSync(s) { const b = $("syncBadge"); const label = { ok: "Synced", syncing: "Syncing", offline: "Offline", error: "Retry" }[s] || "Synced"; b.textContent = label; b.className = "sync-badge" + (s === "ok" ? "" : " " + s); }

  function cacheAll() {
    localStorage.setItem(K("focus." + vault), JSON.stringify(focusBlocks));
    localStorage.setItem(K("books." + vault), JSON.stringify(books));
    localStorage.setItem(K("readsess." + vault), JSON.stringify(readSess));
    localStorage.setItem(K("well." + vault), JSON.stringify(wellSess));
    localStorage.setItem(K("caf." + vault), JSON.stringify(cafLogs));
    localStorage.setItem(K("projects." + vault), JSON.stringify(projects));
    localStorage.setItem(K("projsess." + vault), JSON.stringify(projSess));
  }
  function loadCache() {
    focusBlocks = readJSON(K("focus." + vault), []); books = readJSON(K("books." + vault), []);
    readSess = readJSON(K("readsess." + vault), []); wellSess = readJSON(K("well." + vault), []);
    cafLogs = readJSON(K("caf." + vault), []); projects = readJSON(K("projects." + vault), []);
    projSess = readJSON(K("projsess." + vault), []);
  }
  function readQueue() { return readJSON(K("queue." + vault), []); }
  function writeQueue(q) { localStorage.setItem(K("queue." + vault), JSON.stringify(q)); }
  async function flushQueue() { let q = readQueue(); if (!q.length) return; const rem = []; for (const it of q) { try { await rpc(it.fn, { p_vault: vault, p_payload: it.payload }); } catch (e) { rem.push(it); } } writeQueue(rem); }
  async function logRow(arr, fn, payload) {
    const row = Object.assign({ id: "local-" + Date.now() + Math.random() }, payload);
    arr.push(row); cacheAll();
    try { setSync("syncing"); const nid = await rpc(fn, { p_vault: vault, p_payload: payload }); if (typeof nid === "string" && nid) { row.id = nid; cacheAll(); } await flushQueue(); lastSyncAt = new Date(); setSync("ok"); }
    catch (e) { const q = readQueue(); q.push({ fn, payload }); writeQueue(q); setSync(navigator.onLine ? "error" : "offline"); }
  }
  function tkey(x, f) { return x && x[f] ? new Date(x[f]).getTime() : null; }
  async function mergeList(localArr, listFn, keyField, logFn, payloadFn) {
    const cloud = (await rpc(listFn, { p_vault: vault })) || [];
    const ck = new Set(cloud.map((x) => tkey(x, keyField)).filter((k) => k != null));
    const only = localArr.filter((x) => { const k = tkey(x, keyField); return k != null && !ck.has(k); });
    if (only.length) { for (const x of only) { try { await rpc(logFn, { p_vault: vault, p_payload: payloadFn(x) }); } catch (e) {} } return (await rpc(listFn, { p_vault: vault })) || cloud; }
    return cloud;
  }
  const pFocus = (b) => ({ started_at: b.started_at, ended_at: b.ended_at, planned_seconds: b.planned_seconds, actual_seconds: b.actual_seconds, kind: "focus", label: b.label || null, completed: b.completed !== false, tz_offset_minutes: b.tz_offset_minutes, local_date: b.local_date, local_hour: b.local_hour, weekday: b.weekday });
  const pRead = (s) => ({ book_id: s.book_id || null, book_title: s.book_title || null, started_at: s.started_at, ended_at: s.ended_at, seconds: s.seconds, pages_read: s.pages_read || 0, local_date: s.local_date, local_hour: s.local_hour, weekday: s.weekday });
  const pWell = (s) => ({ kind: s.kind, pattern_name: s.pattern_name, inhale: s.inhale, hold1: s.hold1, exhale: s.exhale, hold2: s.hold2, planned_seconds: s.planned_seconds, actual_seconds: s.actual_seconds, started_at: s.started_at, ended_at: s.ended_at, local_date: s.local_date, local_hour: s.local_hour, weekday: s.weekday });
  const pCaf = (c) => ({ drink: c.drink, caffeine_mg: c.caffeine_mg, note: c.note || null, consumed_at: c.consumed_at, local_date: c.local_date, local_hour: c.local_hour, weekday: c.weekday });
  const pProj = (s) => ({ project_id: s.project_id || null, project_name: s.project_name || null, note: s.note || null, started_at: s.started_at, ended_at: s.ended_at, seconds: s.seconds, local_date: s.local_date, local_hour: s.local_hour, weekday: s.weekday });

  async function refreshFromCloud() {
    if (!navigator.onLine) { setSync("offline"); return; }
    try {
      setSync("syncing"); await flushQueue();
      const [cb, cp] = await Promise.all([rpc("reading_list_books", { p_vault: vault }), rpc("project_list", { p_vault: vault })]);
      const [nf, nr, nw, nc, np] = await Promise.all([
        mergeList(focusBlocks, "focus_list_blocks", "started_at", "focus_log_block", pFocus),
        mergeList(readSess, "reading_list_sessions", "started_at", "reading_log_session", pRead),
        mergeList(wellSess, "wellness_list_sessions", "started_at", "wellness_log_session", pWell),
        mergeList(cafLogs, "caffeine_list", "consumed_at", "caffeine_log", pCaf),
        mergeList(projSess, "project_list_sessions", "started_at", "project_log_session", pProj),
      ]);
      focusBlocks = nf; readSess = nr; wellSess = nw; cafLogs = nc; projSess = np;
      books = Array.isArray(cb) ? cb : books; projects = Array.isArray(cp) ? cp : projects;
      lastSyncAt = new Date(); cacheAll(); renderAll(); setSync("ok");
    } catch (e) { setSync("error"); }
  }

  /* ---------- figure / chart helpers ---------- */
  function dailySeries(arr, field, valFn) {
    const base = startOfDay(new Date()), out = [];
    for (let i = 13; i >= 0; i--) { const d = new Date(base); d.setDate(d.getDate() - i); const key = d.getTime(); const v = arr.filter((x) => startOfDay(new Date(x[field])).getTime() === key).reduce((a, x) => a + valFn(x), 0); out.push({ d, v }); }
    return out;
  }
  function barsHTML(series, fmt) {
    const max = Math.max(1, ...series.map((s) => s.v)), recVal = Math.max(...series.map((s) => s.v));
    const todayKey = startOfDay(new Date()).getTime();
    return series.map((s) => {
      const empty = s.v === 0, h = empty ? 4 : Math.round((s.v / max) * 94) + 8;
      const record = !empty && s.v === recVal, today = startOfDay(s.d).getTime() === todayKey;
      return `<div class="bar-col${today ? " today" : ""}"><div class="bar${empty ? " empty" : ""}${record ? " record" : ""}" data-c="${fmt(s.v)}" style="height:${h}px"></div><div class="blab">${DL[wd(s.d)]}</div></div>`;
    }).join("");
  }
  function hoursHTML(buckets, fmt) {
    const max = Math.max(1, ...buckets); let peak = -1, pv = 0; buckets.forEach((v, h) => { if (v > pv) { pv = v; peak = h; } });
    return { html: buckets.map((v, h) => { const empty = v === 0, hh = empty ? 3 : Math.round((v / max) * 72) + 6; return `<div class="hour-bar${empty ? " empty" : ""}${h === peak && pv > 0 ? " peak" : ""}" data-c="${fmtHour(h)} ${fmt(v)}" style="height:${hh}px"></div>`; }).join(""), peak: pv > 0 ? peak : -1 };
  }
  function fmtHour(h) { const ap = h < 12 ? "a" : "p"; let x = h % 12; if (x === 0) x = 12; return x + ap; }
  function deltaToday(series) {
    const today = series[series.length - 1].v, prior = series.slice(0, -1).map((s) => s.v);
    const avg = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;
    if (avg <= 0 && today <= 0) return null;
    if (avg <= 0) return { text: "first today", dir: "up" };
    const pct = Math.round((today - avg) / avg * 100);
    return { text: (pct >= 0 ? "+" : "") + pct + "% vs avg", dir: pct >= 0 ? "up" : "down" };
  }
  function figHTML(lab, val, unit, delta, accent) {
    const d = delta ? `<span class="delta ${delta.dir}">${delta.dir === "up" ? "▲" : "▼"} ${delta.text}</span>` : "";
    return `<div class="fig${accent ? " accent" : ""}"><span class="lab">${lab}</span><span class="val">${val}${unit ? `<span class="u">${unit}</span>` : ""}</span>${d}</div>`;
  }
  function streakInfo(arr, field) {
    const days = new Set(arr.map((x) => startOfDay(new Date(x[field])).getTime()));
    const todayHas = days.has(startOfDay(new Date()).getTime());
    let n = 0, cur = startOfDay(new Date()); if (!todayHas) cur.setDate(cur.getDate() - 1);
    while (days.has(cur.getTime())) { n++; cur.setDate(cur.getDate() - 1); }
    return { n, today: todayHas };
  }
  function sumDay(arr, field, valFn) { const t = startOfDay(new Date()).getTime(); return arr.filter((x) => startOfDay(new Date(x[field])).getTime() === t).reduce((a, x) => a + valFn(x), 0); }
  function sumWeek(arr, field, valFn) { const w = startOfWeek(new Date()).getTime(); return arr.filter((x) => new Date(x[field]).getTime() >= w).reduce((a, x) => a + valFn(x), 0); }
  const secFn = (x) => x.actual_seconds || x.seconds || 0;
  const oneFn = () => 1;
  function recentHTML(arr, field, titleFn, metaFn, rightFn, activeId) {
    const rows = arr.slice().sort((a, b) => new Date(b[field]) - new Date(a[field])).slice(0, 6);
    if (!rows.length) return '<li class="recent-empty">No entries yet</li>';
    return rows.map((x) => `<li class="recent-item" data-id="${esc(String(x.id))}"><span class="recent-dot${activeId && x.id === activeId ? " active" : ""}"></span><div class="recent-main"><div class="recent-title">${titleFn(x)}</div><div class="recent-meta">${metaFn(x)}</div></div><span class="recent-dur">${rightFn(x)}</span></li>`).join("");
  }
  function whenStr(d) { return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + " · " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }

  /* ---------- analysis windows ---------- */
  const WINDOWS = [{ key: "1w", label: "1W", days: 7, bucket: "day" }, { key: "4w", label: "4W", days: 28, bucket: "day" }, { key: "3m", label: "3M", days: 91, bucket: "week" }, { key: "1y", label: "1Y", days: 365, bucket: "month" }];
  let insWindow = localStorage.getItem(K("insWin")) || "4w";
  function curWin() { return WINDOWS.find((w) => w.key === insWindow) || WINDOWS[1]; }
  function sumRange(arr, field, vf, start, end) { return arr.filter((x) => { const t = new Date(x[field]).getTime(); return t >= start && t < end; }).reduce((a, x) => a + vf(x), 0); }
  function deltaPct(cur, prev) { if (prev <= 0 && cur <= 0) return null; if (prev <= 0) return { text: "new", dir: "up" }; const p = Math.round((cur - prev) / prev * 100); return { text: (p >= 0 ? "+" : "") + p + "% vs prev", dir: p >= 0 ? "up" : "down" }; }
  function winSeries(arr, field, vf, win) {
    const now = new Date(), out = [];
    if (win.bucket === "day") { const base = startOfDay(now); for (let i = win.days - 1; i >= 0; i--) { const d = new Date(base); d.setDate(d.getDate() - i); const k = d.getTime(); const v = arr.filter((x) => startOfDay(new Date(x[field])).getTime() === k).reduce((a, x) => a + vf(x), 0); out.push({ v, label: win.days <= 7 ? DL[wd(d)] : String(d.getDate()), show: win.days <= 7 || d.getDay() === 1 }); } }
    else if (win.bucket === "week") { const nW = Math.ceil(win.days / 7); const ws = startOfWeek(now); for (let i = nW - 1; i >= 0; i--) { const s = new Date(ws); s.setDate(s.getDate() - i * 7); const e = new Date(s); e.setDate(e.getDate() + 7); out.push({ v: sumRange(arr, field, vf, s.getTime(), e.getTime()), label: (s.getMonth() + 1) + "/" + s.getDate(), show: i % 2 === 0 }); } }
    else { for (let i = 11; i >= 0; i--) { const s = new Date(now.getFullYear(), now.getMonth() - i, 1); const e = new Date(now.getFullYear(), now.getMonth() - i + 1, 1); out.push({ v: sumRange(arr, field, vf, s.getTime(), e.getTime()), label: MON[s.getMonth()][0], show: true }); } }
    return out;
  }
  function barsWin(series, fmt) {
    const max = Math.max(1, ...series.map((s) => s.v)), recVal = Math.max(...series.map((s) => s.v));
    return series.map((s, i) => { const empty = s.v === 0, h = empty ? 4 : Math.round((s.v / max) * 94) + 8, record = !empty && s.v === recVal, cur = i === series.length - 1; return `<div class="bar-col${cur ? " today" : ""}"><div class="bar${empty ? " empty" : ""}${record ? " record" : ""}" data-c="${fmt(s.v)}" style="height:${h}px"></div><div class="blab">${s.show ? s.label : ""}</div></div>`; }).join("");
  }
  function hoursWin(arr, field, win) {
    const now = Date.now(), span = win.days * 86400000, buckets = new Array(24).fill(0);
    arr.filter((x) => new Date(x[field]).getTime() >= now - span).forEach((x) => { buckets[typeof x.local_hour === "number" ? x.local_hour : new Date(x[field]).getHours()]++; });
    return hoursHTML(buckets, (v) => v + "");
  }
  function fmtDur(min) { min = Math.round(min); if (min < 60) return min + "m"; const h = Math.floor(min / 60), r = min % 60; return r ? h + "h " + r + "m" : h + "h"; }
  function setWinMeta() { const lbl = curWin().label; document.querySelectorAll(".win-meta").forEach((e) => e.textContent = lbl); document.querySelectorAll(".winbtn").forEach((b) => b.classList.toggle("active", b.dataset.win === insWindow)); }
  function setWindow(w) { insWindow = w; localStorage.setItem(K("insWin"), w); renderView(view); }

  /* ---------- view router ---------- */
  let view = "index";
  let subView = { focus: "log", read: "log", breathe: "log", caffeine: "log", project: "log" };
  const VIEWS = ["index", "focus", "read", "breathe", "caffeine", "project"];
  function setView(name) {
    view = name;
    VIEWS.forEach((v) => { const el = $("view-" + v); if (el) el.hidden = v !== name; });
    document.querySelectorAll(".navbtn").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    document.body.classList.toggle("med", name === "breathe" && currentPat().kind === "meditation");
    renderView(name);
    if (name !== "index") { subView[name] = "log"; applySub(name); }  // a sub-app always opens on its Log page
    window.scrollTo(0, 0);
  }
  function applySub(app) {
    const sub = subView[app] || "log";
    if ($(app + "-log")) $(app + "-log").hidden = sub !== "log";
    if ($(app + "-insights")) $(app + "-insights").hidden = sub !== "insights";
    document.querySelectorAll(`.subtab[data-app="${app}"]`).forEach((b) => b.classList.toggle("active", b.dataset.sub === sub));
  }
  function setSub(app, sub) { subView[app] = sub; applySub(app); renderView(app); window.scrollTo(0, 0); }
  function renderView(name) {
    if (name === "index") renderIndex();
    else if (name === "focus") renderFocusInsights();
    else if (name === "read") renderReading();
    else if (name === "breathe") renderBreatheInsights();
    else if (name === "caffeine") renderCaffeine();
    else if (name === "project") renderProjects();
  }

  /* ============ FOCUS ============ */
  let fMode = "focus", fRemain = settings.focusMin * 60, fRun = false, fTick = null, fEnd = 0, fStartedAt = null;
  function fTotal() { return (fMode === "focus" ? settings.focusMin : settings.breakMin) * 60; }
  function fRender() { const m = Math.floor(fRemain / 60), s = fRemain % 60; $("fTime").textContent = pad(m) + ":" + pad(s); $("fGauge").style.width = (Math.max(0, Math.min(1, 1 - fRemain / fTotal())) * 100) + "%"; }
  function fSetMode(m, reset) { fMode = m; $("pillFocus").classList.toggle("active", m === "focus"); $("pillBreak").classList.toggle("active", m === "break"); $("fModeSub").textContent = m === "focus" ? "focus block" : "break"; if (reset) fRemain = fTotal(); fRender(); fHint(); }
  function fHint() { $("fHint").textContent = fRun ? (fMode === "focus" ? "In session — finishing logs a block" : "Break — step away") : (fMode === "focus" ? "Start a " + settings.focusMin + "-minute focus block" : "Start a " + settings.breakMin + "-minute break"); }
  function fStartFn() { if (fRun) { fRun = false; clearInterval(fTick); releaseWake(); $("fStart").textContent = "Resume"; fHint(); return; } fRun = true; if (fMode === "focus" && !fStartedAt) fStartedAt = new Date(); fEnd = Date.now() + fRemain * 1000; $("fStart").textContent = "Pause"; acquireWake(); fHint(); fTick = setInterval(fTk, 250); }
  function fTk() { fRemain = Math.max(0, Math.round((fEnd - Date.now()) / 1000)); fRender(); if (fRemain <= 0) fDone(); }
  function fReset() { if (fMode === "focus" && fStartedAt) { const el = Math.round((Date.now() - fStartedAt.getTime()) / 1000); if (el >= 60 && fRemain > 0) fLog(false, el); } fRun = false; clearInterval(fTick); releaseWake(); fStartedAt = null; fRemain = fTotal(); $("fStart").textContent = "Start"; fHint(); fRender(); }
  function fDone() { fRun = false; clearInterval(fTick); releaseWake(); if (settings.soundOn) chime(true); if (fMode === "focus") { fLog(true, settings.focusMin * 60); fStartedAt = null; fSetMode("break", true); } else fSetMode("focus", true); $("fStart").textContent = "Start"; fRender(); }
  function fLog(done, sec) { const ended = new Date(), begun = fStartedAt || new Date(ended.getTime() - sec * 1000); logRow(focusBlocks, "focus_log_block", { started_at: begun.toISOString(), ended_at: ended.toISOString(), planned_seconds: settings.focusMin * 60, actual_seconds: sec, kind: "focus", label: ($("fLabel").value || "").trim() || null, completed: done, tz_offset_minutes: -begun.getTimezoneOffset(), local_date: localDateStr(begun), local_hour: begun.getHours(), weekday: wd(begun) }).then(renderFocusInsights); $("fLabel").value = ""; }
  function renderFocusInsights() {
    const done = focusBlocks.filter((b) => b.kind === "focus"), win = curWin(), now = Date.now(), span = win.days * 86400000;
    const total = sumRange(done, "started_at", oneFn, now - span, now + 1), prev = sumRange(done, "started_at", oneFn, now - 2 * span, now - span);
    const stk = streakInfo(done, "started_at");
    $("fFigures").innerHTML = figHTML("Total", Math.round(total), "blk", deltaPct(total, prev)) + figHTML("Per day", (total / win.days).toFixed(1), "", null) + figHTML("Streak", stk.n, "d", null, stk.today && stk.n > 0);
    $("fPlate").innerHTML = barsWin(winSeries(done, "started_at", oneFn, win), (v) => v + " blk");
    const hh = hoursWin(done, "started_at", win); $("fHours").innerHTML = hh.html; $("fHoursMeta").textContent = hh.peak >= 0 ? "peak " + fmtHour(hh.peak) : "";
    $("fRecent").innerHTML = recentHTML(done, "started_at", (b) => b.label ? esc(b.label) : (b.completed ? "Focus block" : "Partial"), (b) => whenStr(new Date(b.started_at)), (b) => Math.round((b.actual_seconds || 0) / 60) + "m");
    setWinMeta();
  }

  /* ============ READING ============ */
  let rRun = false, rAnchor = 0, rAccum = 0, rTick = null, rStart = null;
  const rElapsed = () => rAccum + (rRun ? Date.now() - rAnchor : 0);
  function swFmt(ms) { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return (h ? h + ":" + pad(m) : pad(m)) + ":" + pad(s % 60); }
  function rRender() { $("rSW").textContent = swFmt(rElapsed()); }
  function rStartFn() { if (rRun) { rAccum = rElapsed(); rRun = false; clearInterval(rTick); releaseWake(); $("rStart").textContent = "Resume"; return; } if (!curBookId) { toast("Pick a book first"); return; } rRun = true; rAnchor = Date.now(); if (!rStart) rStart = new Date(); $("rStart").textContent = "Pause"; $("rStop").hidden = false; acquireWake(); $("rHint").textContent = "Reading…"; rTick = setInterval(rRender, 500); }
  function rFinish() { rRun = false; clearInterval(rTick); releaseWake(); const total = Math.round(rElapsed() / 1000); if (total < 10) { rReset(); toast("Too short to log"); return; } const bk = books.find((b) => b.id === curBookId); pendingRead = { seconds: total, book: bk, start: rStart || new Date(Date.now() - total * 1000) }; $("logSummary").textContent = `${Math.max(1, Math.round(total / 60))} min${bk ? " · " + bk.title : ""}`; $("logPages").value = ""; $("logBackdrop").hidden = false; }
  function rReset() { rRun = false; clearInterval(rTick); rAccum = 0; rStart = null; $("rStart").textContent = "Start"; $("rStop").hidden = true; $("rHint").textContent = "Pick a book and start when you sit down."; rRender(); }
  function rSaveLog() { const ps = pendingRead; if (!ps) return; const begun = ps.start, ended = new Date(begun.getTime() + ps.seconds * 1000); const pages = Math.max(0, parseInt($("logPages").value) || 0); logRow(readSess, "reading_log_session", { book_id: ps.book ? ps.book.id : null, book_title: ps.book ? ps.book.title : null, started_at: begun.toISOString(), ended_at: ended.toISOString(), seconds: ps.seconds, pages_read: pages, local_date: localDateStr(begun), local_hour: begun.getHours(), weekday: wd(begun) }); if (ps.book && pages > 0) { ps.book.current_page = (ps.book.current_page || 0) + pages; cacheAll(); rpc("reading_upsert_book", { p_vault: vault, p_payload: { id: ps.book.id, current_page: ps.book.current_page } }).catch(() => {}); } $("logBackdrop").hidden = true; pendingRead = null; rReset(); renderReading(); toast("Session saved"); }
  function renderReading() {
    const sel = $("currentBook"), active = books.filter((b) => b.status !== "finished");
    sel.innerHTML = '<option value="">— pick or add —</option>' + active.map((b) => `<option value="${b.id}">${esc(b.title)}</option>`).join("");
    if (curBookId && active.some((b) => b.id === curBookId)) sel.value = curBookId; else { sel.value = ""; curBookId = ""; }
    const list = $("bookList"); list.innerHTML = books.length ? "" : '<li class="empty-row">No books yet</li>';
    const ord = { reading: 0, want: 1, finished: 2 };
    books.slice().sort((a, b) => (ord[a.status] - ord[b.status]) || (new Date(b.updated_at) - new Date(a.updated_at))).forEach((b) => { const li = document.createElement("li"); li.className = "mini-item" + (b.id === curBookId ? " active-row" : ""); const pct = b.total_pages ? Math.min(100, Math.round(((b.current_page || 0) / b.total_pages) * 100)) : 0; const badge = b.status === "finished" ? "FIN" + (b.rating ? " " + b.rating + "/5" : "") : (b.status === "want" ? "WANT" : ""); li.innerHTML = `<span class="mi-spine"></span><div class="mi-main"><div class="mi-title">${esc(b.title)}</div><div class="mi-meta">${b.author ? esc(b.author) : "—"}${badge ? " · " + badge : ""}</div>${b.total_pages ? `<div class="mini-bar"><i style="width:${pct}%"></i></div>` : ""}</div><span class="mi-right">${b.total_pages ? pct + "%" : (b.current_page || 0) + "p"}</span>`; li.onclick = () => openBook(b.id); list.appendChild(li); });
    const win = curWin(), vf = (x) => secFn(x) / 60, now = Date.now(), span = win.days * 86400000;
    const total = sumRange(readSess, "started_at", vf, now - span, now + 1), prev = sumRange(readSess, "started_at", vf, now - 2 * span, now - span);
    const sessN = sumRange(readSess, "started_at", oneFn, now - span, now + 1), stk = streakInfo(readSess, "started_at");
    $("rFigures").innerHTML = figHTML("Total", fmtDur(total), "", deltaPct(total, prev)) + figHTML("Per day", Math.round(total / win.days), "min", null) + figHTML("Sessions", Math.round(sessN), "", null) + figHTML("Streak", stk.n, "d", null, stk.today && stk.n > 0);
    $("rPlate").innerHTML = barsWin(winSeries(readSess, "started_at", vf, win), (v) => Math.round(v) + "m");
    const hh = hoursWin(readSess, "started_at", win); $("rHours").innerHTML = hh.html; $("rHoursMeta").textContent = hh.peak >= 0 ? "peak " + fmtHour(hh.peak) : "";
    $("rRecent").innerHTML = recentHTML(readSess, "started_at", (s) => (s.book_title ? esc(s.book_title) : "Reading") + (s.pages_read ? " · " + s.pages_read + "p" : ""), (s) => whenStr(new Date(s.started_at)), (s) => Math.round((s.seconds || 0) / 60) + "m");
    setWinMeta();
  }
  function openBook(id) { editBook = id; editRating = null; const b = id ? books.find((x) => x.id === id) : null; $("bookSheetTitle").textContent = b ? "Edit book" : "Add a book"; $("bTitle").value = b ? b.title : ""; $("bAuthor").value = b && b.author ? b.author : ""; $("bPages").value = b && b.total_pages ? b.total_pages : ""; $("bCurrent").value = b ? (b.current_page || 0) : 0; $("bStatus").value = b ? b.status : "reading"; editRating = b && b.rating ? b.rating : null; $("bookDelete").hidden = !b; starsSync(); $("ratingField").hidden = $("bStatus").value !== "finished"; $("bookBackdrop").hidden = false; }
  function starsSync() { [...$("starRow").children].forEach((s) => s.classList.toggle("on", editRating != null && +s.dataset.v <= editRating)); }
  async function saveBook() { const title = ($("bTitle").value || "").trim(); if (!title) { toast("Add a title"); return; } const status = $("bStatus").value; const payload = { title, author: ($("bAuthor").value || "").trim() || null, total_pages: $("bPages").value || "", current_page: parseInt($("bCurrent").value) || 0, status }; if (editBook) payload.id = editBook; if (status === "finished") { payload.rating = editRating || ""; payload.finished_on = localDateStr(new Date()); } if (editBook) { const b = books.find((x) => x.id === editBook); if (b) Object.assign(b, { title, author: payload.author, total_pages: parseInt(payload.total_pages) || null, current_page: payload.current_page, status, rating: editRating }); } else books.unshift({ id: "local-" + Date.now(), title, author: payload.author, total_pages: parseInt(payload.total_pages) || null, current_page: payload.current_page, status, rating: editRating, updated_at: new Date().toISOString() }); cacheAll(); renderReading(); $("bookBackdrop").hidden = true; try { setSync("syncing"); await rpc("reading_upsert_book", { p_vault: vault, p_payload: payload }); setSync("ok"); } catch (e) { setSync("error"); } refreshFromCloud(); }
  async function delBook() { if (!editBook) return; if (!confirm("Delete this book and its sessions?")) return; books = books.filter((b) => b.id !== editBook); readSess = readSess.filter((s) => s.book_id !== editBook); if (curBookId === editBook) { curBookId = ""; localStorage.setItem(K("curBook"), ""); } cacheAll(); renderReading(); $("bookBackdrop").hidden = true; if (!String(editBook).startsWith("local-")) { try { await rpc("reading_delete_book", { p_vault: vault, p_id: editBook }); } catch (e) {} } }

  /* ============ PROJECT ============ */
  let pRun = false, pAnchor = 0, pAccum = 0, pTick = null, pStartT = null;
  const pElapsed = () => pAccum + (pRun ? Date.now() - pAnchor : 0);
  function pRender() { $("pSW").textContent = swFmt(pElapsed()); }
  function pStartFn() { if (pRun) { pAccum = pElapsed(); pRun = false; clearInterval(pTick); releaseWake(); $("pStart").textContent = "Resume"; return; } if (!curProjId) { toast("Pick a project first"); return; } pRun = true; pAnchor = Date.now(); if (!pStartT) pStartT = new Date(); $("pStart").textContent = "Pause"; $("pStop").hidden = false; acquireWake(); $("pHint").textContent = "Working…"; pTick = setInterval(pRender, 500); }
  function pFinish() { pRun = false; clearInterval(pTick); releaseWake(); const total = Math.round(pElapsed() / 1000); if (total < 10) { pReset(); toast("Too short to log"); return; } const pr = projects.find((x) => x.id === curProjId); pendingProj = { seconds: total, proj: pr, start: pStartT || new Date(Date.now() - total * 1000) }; $("plogSummary").textContent = `${Math.max(1, Math.round(total / 60))} min${pr ? " · " + pr.name : ""}`; $("plogNote").value = ""; $("plogBackdrop").hidden = false; }
  function pReset() { pRun = false; clearInterval(pTick); pAccum = 0; pStartT = null; $("pStart").textContent = "Start"; $("pStop").hidden = true; $("pHint").textContent = "Pick a project and start the clock."; pRender(); }
  function pSaveLog() { const ps = pendingProj; if (!ps) return; const begun = ps.start, ended = new Date(begun.getTime() + ps.seconds * 1000); logRow(projSess, "project_log_session", { project_id: ps.proj ? ps.proj.id : null, project_name: ps.proj ? ps.proj.name : null, note: ($("plogNote").value || "").trim() || null, started_at: begun.toISOString(), ended_at: ended.toISOString(), seconds: ps.seconds, local_date: localDateStr(begun), local_hour: begun.getHours(), weekday: wd(begun) }); $("plogBackdrop").hidden = true; pendingProj = null; pReset(); renderProjects(); toast("Session saved"); }
  function projSeconds(id, since) { return projSess.filter((s) => s.project_id === id && (!since || new Date(s.started_at).getTime() >= since)).reduce((a, s) => a + (s.seconds || 0), 0); }
  function renderProjects() {
    const sel = $("currentProject"), act = projects.filter((p) => !p.archived);
    sel.innerHTML = '<option value="">— pick or add —</option>' + act.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    if (curProjId && act.some((p) => p.id === curProjId)) sel.value = curProjId; else { sel.value = ""; curProjId = ""; }
    const list = $("projList"); list.innerHTML = projects.length ? "" : '<li class="empty-row">No projects yet</li>';
    const wkStart = startOfWeek(new Date()).getTime();
    projects.slice().forEach((p) => { const li = document.createElement("li"); li.className = "mini-item" + (p.id === curProjId ? " active-row" : ""); li.innerHTML = `<span class="mi-spine"></span><div class="mi-main"><div class="mi-title">${esc(p.name)}</div><div class="mi-meta">${fmtMin(projSeconds(p.id, wkStart))} this week</div></div><span class="mi-right">${fmtMin(projSeconds(p.id))}</span>`; li.onclick = () => openProj(p.id); list.appendChild(li); });
    const win = curWin(), vf = (x) => secFn(x) / 60, now = Date.now(), span = win.days * 86400000;
    const total = sumRange(projSess, "started_at", vf, now - span, now + 1), prev = sumRange(projSess, "started_at", vf, now - 2 * span, now - span), stk = streakInfo(projSess, "started_at");
    $("pFigures").innerHTML = figHTML("Total", fmtDur(total), "", deltaPct(total, prev)) + figHTML("Per day", Math.round(total / win.days), "min", null) + figHTML("Streak", stk.n, "d", null, stk.today && stk.n > 0);
    const byProj = {}; projSess.filter((s) => new Date(s.started_at).getTime() >= now - span).forEach((s) => { const k = s.project_name || "Other"; byProj[k] = (byProj[k] || 0) + (s.seconds || 0); });
    const ent = Object.entries(byProj).sort((a, b) => b[1] - a[1]).slice(0, 6), pmax = Math.max(1, ...ent.map((e) => e[1]));
    $("projBreak").innerHTML = ent.length ? ent.map(([n, s]) => `<div class="bd-row"><span class="bd-name">${esc(n)}</span><div class="bd-track"><i style="width:${Math.round((s / pmax) * 100)}%"></i></div><span class="bd-val">${fmtMin(s)}</span></div>`).join("") : '<div class="empty-row">Nothing logged</div>';
    $("pPlate").innerHTML = barsWin(winSeries(projSess, "started_at", vf, win), (v) => Math.round(v) + "m");
    $("pRecent").innerHTML = recentHTML(projSess, "started_at", (s) => s.project_name ? esc(s.project_name) : "Project", (s) => whenStr(new Date(s.started_at)) + (s.note ? " · " + esc(s.note) : ""), (s) => fmtMin(s.seconds || 0));
    setWinMeta();
  }
  function openProj(id) { editProj = id; const p = id ? projects.find((x) => x.id === id) : null; $("projSheetTitle").textContent = p ? "Edit project" : "Add a project"; $("pName").value = p ? p.name : ""; $("projDelete").hidden = !p; $("projBackdrop").hidden = false; }
  async function saveProj() { const name = ($("pName").value || "").trim(); if (!name) { toast("Add a name"); return; } const payload = { name }; if (editProj) payload.id = editProj; if (editProj) { const p = projects.find((x) => x.id === editProj); if (p) p.name = name; } else projects.unshift({ id: "local-" + Date.now(), name, updated_at: new Date().toISOString() }); cacheAll(); renderProjects(); $("projBackdrop").hidden = true; try { await rpc("project_upsert", { p_vault: vault, p_payload: payload }); } catch (e) {} refreshFromCloud(); }
  async function delProj() { if (!editProj) return; if (!confirm("Delete this project and its sessions?")) return; projects = projects.filter((p) => p.id !== editProj); projSess = projSess.filter((s) => s.project_id !== editProj); if (curProjId === editProj) { curProjId = ""; localStorage.setItem(K("curProj"), ""); } cacheAll(); renderProjects(); $("projBackdrop").hidden = true; if (!String(editProj).startsWith("local-")) { try { await rpc("project_delete", { p_vault: vault, p_id: editProj }); } catch (e) {} } }

  /* ============ BREATHE ============ */
  function currentPat() { return PATTERNS.concat(custom).find((p) => p.id === selPat) || PATTERNS[0]; }
  let bRun = false, bStartMs = 0, bStartDate = null, bLen = 0, bPlanned = 0, bPhases = [], bIdx = 0, bPhaseEnd = 0, bPhaseTimer = null, bUi = null, bKind = "breathing", bPat = null;
  function renderPatterns() { const row = $("patternRow"); row.innerHTML = ""; PATTERNS.concat(custom).forEach((p) => { const b = document.createElement("button"); b.className = "chip" + (p.id === selPat ? " active" : ""); b.textContent = p.name; b.onclick = () => { if (bRun) return; selPat = p.id; localStorage.setItem(K("selPat"), selPat); renderPatterns(); resetOrb(); }; row.appendChild(b); }); const a = document.createElement("button"); a.className = "chip add"; a.textContent = "+"; a.onclick = openPattern; row.appendChild(a); }
  function renderDurations() { const row = $("durRow"); row.innerHTML = ""; DURATIONS.forEach((d) => { const b = document.createElement("button"); b.className = "chip" + (d === durMin ? " active" : ""); b.textContent = d + "m"; b.onclick = () => { if (bRun) return; durMin = d; localStorage.setItem(K("durMin"), d); renderDurations(); }; row.appendChild(b); }); }
  function resetOrb() { const o = $("orb"); o.style.transition = "transform 1.2s ease"; o.style.transform = "scale(.6)"; o.classList.remove("idle-pulse"); $("orbLabel").textContent = "Ready"; $("orbSub").textContent = currentPat().name; document.body.classList.toggle("med", view === "breathe" && currentPat().kind === "meditation"); }
  function bStartFn() { if (bRun) { bStop(); return; } const pat = currentPat(); bPat = pat; bKind = pat.kind || "breathing"; document.body.classList.toggle("med", bKind === "meditation"); bPlanned = durMin * 60; bLen = bPlanned * 1000; bStartMs = Date.now(); bStartDate = new Date(); bRun = true; bIdx = 0; $("bStart").textContent = "Stop"; acquireWake(); if (bKind === "meditation") { $("orb").classList.add("idle-pulse"); $("orbLabel").textContent = "Meditate"; } else { $("orb").classList.remove("idle-pulse"); bPhases = [{ label: "Breathe in", secs: pat.inhale, scale: 1 }, { label: "Hold", secs: pat.hold1, scale: 1 }, { label: "Breathe out", secs: pat.exhale, scale: .58 }, { label: "Hold", secs: pat.hold2, scale: .58 }].filter((p) => p.secs > 0); bPhase(); } bUi = setInterval(bTick, 200); $("bHint").textContent = ""; }
  function bPhase() { if (!bRun) return; if (Date.now() - bStartMs >= bLen) { bComplete(); return; } const p = bPhases[bIdx % bPhases.length]; bIdx++; bPhaseEnd = Date.now() + p.secs * 1000; const o = $("orb"); o.style.transition = "transform " + p.secs + "s ease-in-out"; o.style.transform = "scale(" + p.scale + ")"; $("orbLabel").textContent = p.label; bPhaseTimer = setTimeout(bPhase, p.secs * 1000); }
  function bTick() { const remain = bLen - (Date.now() - bStartMs); if (bKind === "meditation") $("orbSub").textContent = mmss(remain); else { const pr = Math.ceil((bPhaseEnd - Date.now()) / 1000); $("orbSub").textContent = pr > 0 ? String(pr) : ""; } $("bHint").textContent = mmss(remain) + " remaining"; }
  function mmss(ms) { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ":" + pad(s % 60); }
  function bClear() { clearTimeout(bPhaseTimer); clearInterval(bUi); bPhaseTimer = bUi = null; }
  function bComplete() { if (!bRun) return; bRun = false; bClear(); releaseWake(); bLogIt(bPlanned); if (settings.soundOn) chime(false); $("bStart").textContent = "Start"; resetOrb(); $("orbLabel").textContent = "Done"; $("orbSub").textContent = ""; $("bHint").textContent = "Session saved."; }
  function bStop() { if (!bRun) return; bRun = false; bClear(); releaseWake(); const el = Math.round((Date.now() - bStartMs) / 1000); $("bStart").textContent = "Start"; resetOrb(); if (el >= 30) { bLogIt(el); $("bHint").textContent = "Saved " + Math.round(el / 60) + " min."; } else $("bHint").textContent = "Ended early — not logged."; }
  function bLogIt(sec) { const begun = bStartDate, ended = new Date(begun.getTime() + sec * 1000), p = bPat; logRow(wellSess, "wellness_log_session", { kind: bKind, pattern_name: p.name, inhale: bKind === "meditation" ? null : p.inhale, hold1: bKind === "meditation" ? null : p.hold1, exhale: bKind === "meditation" ? null : p.exhale, hold2: bKind === "meditation" ? null : p.hold2, planned_seconds: bPlanned, actual_seconds: sec, started_at: begun.toISOString(), ended_at: ended.toISOString(), local_date: localDateStr(begun), local_hour: begun.getHours(), weekday: wd(begun) }).then(renderBreatheInsights); }
  function openPattern() { $("patName").value = ""; $("pIn").value = 4; $("pH1").value = 2; $("pOut").value = 6; $("pH2").value = 0; $("patBackdrop").hidden = false; }
  function savePattern() { const name = ($("patName").value || "").trim() || "Custom"; const cl = (id) => Math.max(0, Math.min(20, parseInt($(id).value) || 0)); const p = { id: "c" + Date.now(), name, inhale: cl("pIn"), hold1: cl("pH1"), exhale: cl("pOut"), hold2: cl("pH2") }; if (p.inhale + p.exhale === 0) { toast("Add inhale/exhale time"); return; } custom.push(p); localStorage.setItem(K("patterns"), JSON.stringify(custom)); selPat = p.id; localStorage.setItem(K("selPat"), selPat); $("patBackdrop").hidden = true; renderPatterns(); toast("Pattern added"); }
  function renderBreatheInsights() {
    const win = curWin(), vf = (x) => secFn(x) / 60, now = Date.now(), span = win.days * 86400000;
    const total = sumRange(wellSess, "started_at", vf, now - span, now + 1), prev = sumRange(wellSess, "started_at", vf, now - 2 * span, now - span);
    const sessN = sumRange(wellSess, "started_at", oneFn, now - span, now + 1), stk = streakInfo(wellSess, "started_at");
    $("bFigures").innerHTML = figHTML("Total", fmtDur(total), "", deltaPct(total, prev)) + figHTML("Sessions", Math.round(sessN), "", null) + figHTML("Streak", stk.n, "d", null, stk.today && stk.n > 0);
    $("bPlate").innerHTML = barsWin(winSeries(wellSess, "started_at", vf, win), (v) => Math.round(v) + "m");
    $("bRecent").innerHTML = recentHTML(wellSess, "started_at", (s) => s.kind === "meditation" ? "Meditation" : esc(s.pattern_name || "Breathing"), (s) => whenStr(new Date(s.started_at)), (s) => Math.round((s.actual_seconds || 0) / 60) + "m");
    setWinMeta();
  }

  /* ============ CAFFEINE ============ */
  function logCaffeine(drink, mg) { const now = new Date(); logRow(cafLogs, "caffeine_log", { drink, caffeine_mg: mg, note: null, consumed_at: now.toISOString(), local_date: localDateStr(now), local_hour: now.getHours(), weekday: wd(now) }).then(() => { renderCaffeine(); renderIndex(); }); toast("Coffee logged"); }
  function todayCaf() { const t = localDateStr(new Date()); return cafLogs.filter((c) => (c.local_date === t) || (localDateStr(new Date(c.consumed_at)) === t)); }
  function renderCaffeine() {
    const tc = todayCaf(); $("cafBig").textContent = tc.length; $("cafMg").textContent = tc.reduce((a, c) => a + (c.caffeine_mg || 0), 0);
    const late = tc.filter((c) => { const h = typeof c.local_hour === "number" ? c.local_hour : new Date(c.consumed_at).getHours(); return h >= 14; }).length;
    $("cafNote").textContent = tc.length === 0 ? "No coffee yet today" : (late > 0 ? late + " after 14:00 — may affect sleep" : "All before 14:00");
    const list = $("cafList"); list.innerHTML = tc.length ? "" : '<li class="empty-row">No coffee today</li>';
    tc.slice().sort((a, b) => new Date(b.consumed_at) - new Date(a.consumed_at)).forEach((c) => { const t = new Date(c.consumed_at); const li = document.createElement("li"); li.className = "mini-item"; li.dataset.id = c.id; li.innerHTML = `<span class="mi-spine"></span><div class="mi-main"><div class="mi-title">${esc(c.drink)}</div><div class="mi-meta">${t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${c.caffeine_mg}mg</div></div><span class="mi-right">${c.caffeine_mg}mg</span>`; list.appendChild(li); });
    // insights (window-aware)
    const win = curWin(), now = Date.now(), span = win.days * 86400000;
    const total = sumRange(cafLogs, "consumed_at", oneFn, now - span, now + 1), prev = sumRange(cafLogs, "consumed_at", oneFn, now - 2 * span, now - span);
    $("cFigures").innerHTML = figHTML("Total", Math.round(total), "cups", deltaPct(total, prev)) + figHTML("Per day", (total / win.days).toFixed(1), "", null);
    $("cafPlate").innerHTML = barsWin(winSeries(cafLogs, "consumed_at", oneFn, win), (v) => v + " cups");
    const hh = hoursWin(cafLogs, "consumed_at", win); $("cafHours").innerHTML = hh.html; $("cafHoursMeta").textContent = hh.peak >= 0 ? "peak " + fmtHour(hh.peak) : "";
    setWinMeta();
  }

  /* ============ INDEX ============ */
  function renderIndex() {
    const now = new Date();
    $("mastDate").textContent = "Ledger · " + DOW[now.getDay()] + " " + now.getDate() + " " + MON[now.getMonth()];
    $("greeting").textContent = now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
    const fS = dailySeries(focusBlocks.filter((b) => b.kind === "focus"), "started_at", oneFn);
    const rS = dailySeries(readSess, "started_at", secFn).map((x) => ({ d: x.d, v: Math.round(x.v / 60) }));
    const bS = dailySeries(wellSess, "started_at", secFn).map((x) => ({ d: x.d, v: Math.round(x.v / 60) }));
    const pS = dailySeries(projSess, "started_at", secFn).map((x) => ({ d: x.d, v: Math.round(x.v / 60) }));
    const tc = todayCaf();
    const rows = [
      ["Focus", "focus", fS[13].v, "blk", deltaToday(fS)],
      ["Reading", "read", rS[13].v, "min", deltaToday(rS)],
      ["Breath", "breathe", bS[13].v, "min", deltaToday(bS)],
      ["Projects", "project", pS[13].v, "min", deltaToday(pS)],
      ["Coffee", "caffeine", tc.length, "cups", null],
    ];
    $("idxLedger").innerHTML = rows.map(([l, go, v, u, d]) => `<div class="ledger-row" data-go="${go}"><span class="l-label">${l}</span><span class="l-fig">${v}<span class="u">${u}</span></span><span class="l-delta ${d ? d.dir : ""}">${d ? (d.dir === "up" ? "▲ " : "▼ ") + d.text : "—"}<span class="l-go">→</span></span></div>`).join("");
    $("idxLedger").querySelectorAll(".ledger-row").forEach((r) => r.onclick = () => setView(r.dataset.go));
    const total = focusBlocks.length + readSess.length + wellSess.length + cafLogs.length + projSess.length;
    $("footNote").textContent = total + " entries saved to Supabase" + (lastSyncAt ? " · " + lastSyncAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
  }

  /* ---------- backfill (add a past entry) ---------- */
  let bfModule = null;
  function bfShow(ids) { ["bfDurWrap", "bfSelWrap", "bfNumWrap", "bfTextWrap"].forEach((id) => $(id).hidden = !ids.includes(id)); }
  function openBackfill(m) {
    bfModule = m; const now = new Date();
    $("bfDate").value = localDateStr(now); $("bfTime").value = pad(now.getHours()) + ":" + pad(now.getMinutes());
    if (m === "focus") { $("bfTitle").textContent = "Add past focus block"; bfShow(["bfDurWrap", "bfTextWrap"]); $("bfDur").value = settings.focusMin; $("bfTextLabel").textContent = "Subject (optional)"; $("bfText").value = ""; }
    else if (m === "read") { $("bfTitle").textContent = "Add past reading"; bfShow(["bfDurWrap", "bfSelWrap", "bfNumWrap"]); $("bfDur").value = 30; $("bfSelLabel").textContent = "Book"; $("bfSel").innerHTML = '<option value="">(no book)</option>' + books.filter((b) => b.status !== "finished").map((b) => `<option value="${b.id}">${esc(b.title)}</option>`).join(""); if (curBookId) $("bfSel").value = curBookId; $("bfNumLabel").textContent = "Pages (optional)"; $("bfNum").value = ""; }
    else if (m === "breathe") { $("bfTitle").textContent = "Add past session"; bfShow(["bfDurWrap", "bfSelWrap"]); $("bfDur").value = durMin; $("bfSelLabel").textContent = "Pattern"; $("bfSel").innerHTML = PATTERNS.concat(custom).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join(""); $("bfSel").value = selPat; }
    else if (m === "caffeine") { $("bfTitle").textContent = "Add past coffee"; bfShow(["bfNumWrap"]); $("bfNumLabel").textContent = "Caffeine (mg)"; $("bfNum").value = settings.coffeeMg; }
    else if (m === "project") { $("bfTitle").textContent = "Add past work"; bfShow(["bfDurWrap", "bfSelWrap", "bfTextWrap"]); $("bfDur").value = 30; $("bfSelLabel").textContent = "Project"; $("bfSel").innerHTML = '<option value="">(none)</option>' + projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join(""); if (curProjId) $("bfSel").value = curProjId; $("bfTextLabel").textContent = "Note (optional)"; $("bfText").value = ""; }
    $("bfBackdrop").hidden = false;
  }
  function saveBackfill() {
    const d = $("bfDate").value, t = $("bfTime").value || "12:00";
    if (!d) { toast("Pick a date"); return; }
    const begun = new Date(`${d}T${t}`); if (isNaN(begun.getTime())) { toast("Bad date/time"); return; }
    const m = bfModule, dur = Math.max(1, parseInt($("bfDur").value) || 1) * 60, ended = new Date(begun.getTime() + dur * 1000);
    const base = { started_at: begun.toISOString(), ended_at: ended.toISOString(), local_date: localDateStr(begun), local_hour: begun.getHours(), weekday: wd(begun) };
    if (m === "focus") logRow(focusBlocks, "focus_log_block", Object.assign({}, base, { planned_seconds: settings.focusMin * 60, actual_seconds: dur, kind: "focus", label: ($("bfText").value || "").trim() || null, completed: true, tz_offset_minutes: -begun.getTimezoneOffset() })).then(() => { renderFocusInsights(); renderIndex(); });
    else if (m === "read") { const bid = $("bfSel").value, bk = books.find((b) => b.id === bid); logRow(readSess, "reading_log_session", Object.assign({}, base, { book_id: bid || null, book_title: bk ? bk.title : null, seconds: dur, pages_read: Math.max(0, parseInt($("bfNum").value) || 0) })).then(() => { renderReading(); renderIndex(); }); }
    else if (m === "breathe") { const p = PATTERNS.concat(custom).find((x) => x.id === $("bfSel").value) || PATTERNS[0], med = p.kind === "meditation"; logRow(wellSess, "wellness_log_session", Object.assign({}, base, { kind: med ? "meditation" : "breathing", pattern_name: p.name, inhale: med ? null : p.inhale, hold1: med ? null : p.hold1, exhale: med ? null : p.exhale, hold2: med ? null : p.hold2, planned_seconds: dur, actual_seconds: dur })).then(() => { renderBreatheInsights(); renderIndex(); }); }
    else if (m === "caffeine") { const mg = Math.max(0, parseInt($("bfNum").value) || settings.coffeeMg); logRow(cafLogs, "caffeine_log", { drink: "Coffee", caffeine_mg: mg, note: null, consumed_at: begun.toISOString(), local_date: localDateStr(begun), local_hour: begun.getHours(), weekday: wd(begun) }).then(() => { renderCaffeine(); renderIndex(); }); }
    else if (m === "project") { const pid = $("bfSel").value, pr = projects.find((x) => x.id === pid); logRow(projSess, "project_log_session", Object.assign({}, base, { project_id: pid || null, project_name: pr ? pr.name : null, note: ($("bfText").value || "").trim() || null, seconds: dur })).then(() => { renderProjects(); renderIndex(); }); }
    $("bfBackdrop").hidden = true; toast("Entry added");
  }

  /* ---------- delete an entry ---------- */
  const DEL = {
    focus: { get: () => focusBlocks, set: (v) => focusBlocks = v, fn: "focus_delete_block", field: "started_at", title: (x) => x.label || "Focus block", val: (x) => Math.round((x.actual_seconds || 0) / 60) + "m", re: () => { renderFocusInsights(); renderIndex(); } },
    read: { get: () => readSess, set: (v) => readSess = v, fn: "reading_delete_session", field: "started_at", title: (x) => x.book_title || "Reading", val: (x) => Math.round((x.seconds || 0) / 60) + "m", re: () => { renderReading(); renderIndex(); } },
    breathe: { get: () => wellSess, set: (v) => wellSess = v, fn: "wellness_delete", field: "started_at", title: (x) => x.pattern_name || "Breathing", val: (x) => Math.round((x.actual_seconds || 0) / 60) + "m", re: () => { renderBreatheInsights(); renderIndex(); } },
    caffeine: { get: () => cafLogs, set: (v) => cafLogs = v, fn: "caffeine_delete", field: "consumed_at", title: (x) => x.drink || "Drink", val: (x) => (x.caffeine_mg || 0) + "mg", re: () => { renderCaffeine(); renderIndex(); } },
    project: { get: () => projSess, set: (v) => projSess = v, fn: "project_delete_session", field: "started_at", title: (x) => x.project_name || "Project", val: (x) => fmtMin(x.seconds || 0), re: () => { renderProjects(); renderIndex(); } },
  };
  let entryCtx = null;
  function openEntry(m, id) { const cfg = DEL[m]; const x = cfg.get().find((r) => String(r.id) === String(id)); if (!x) return; entryCtx = { m, id, x }; $("entryTitle").textContent = cfg.title(x); $("entryMeta").textContent = whenStr(new Date(x[cfg.field])) + " · " + cfg.val(x); $("entryBackdrop").hidden = false; }
  async function doDelete() {
    if (!entryCtx) return; const { m, id, x } = entryCtx, cfg = DEL[m];
    // server first: only remove locally once the cloud delete succeeds (prevents resurrection)
    if (!String(id).startsWith("local-")) {
      try { setSync("syncing"); await rpc(cfg.fn, { p_vault: vault, p_id: id }); setSync("ok"); }
      catch (e) { setSync("error"); toast("Couldn't delete — try again later"); $("entryBackdrop").hidden = true; entryCtx = null; return; }
    }
    cfg.set(cfg.get().filter((r) => String(r.id) !== String(id)));
    writeQueue(readQueue().filter((it) => !(it.payload && it.payload[cfg.field] === x[cfg.field])));
    cacheAll(); cfg.re(); $("entryBackdrop").hidden = true; entryCtx = null; toast("Entry deleted");
  }

  function renderAll() { renderView(view); }

  /* ---------- wake + chime ---------- */
  async function acquireWake() { try { if ("wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => (wakeLock = null)); } } catch (e) {} }
  async function releaseWake() { try { if (wakeLock && !fRun && !rRun && !pRun && !bRun) { await wakeLock.release(); wakeLock = null; } } catch (e) {} }
  function chime(isFocus) { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); const notes = isFocus ? [587, 880] : [523, 659, 784]; notes.forEach((f, i) => { const o = actx.createOscillator(), g = actx.createGain(); o.type = "sine"; o.frequency.value = f; o.connect(g); g.connect(actx.destination); const t = actx.currentTime + i * 0.18; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4); o.start(t); o.stop(t + 0.42); }); } catch (e) {} }

  function exportData() { const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), focusBlocks, books, readSess, wellSess, cafLogs, projects, projSess }, null, 2)], { type: "application/json" }); const u = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = u; a.download = `orbit-${localDateStr(new Date())}.json`; a.click(); URL.revokeObjectURL(u); }

  /* ---------- boot ---------- */
  function showApp() { $("unlock").hidden = true; $("app").hidden = false; loadCache(); fSetMode("focus", true); fRender(); rReset(); pReset(); renderPatterns(); renderDurations(); resetOrb(); setView("index"); refreshFromCloud(); }
  async function unlock(p) { if (!p || p.trim().length < 3) { toast("Use at least 3 characters"); return; } vault = await deriveVault(p); localStorage.setItem(K("vault"), vault); showApp(); }
  function saveSettings() { settings.focusMin = Math.max(1, Math.min(180, parseInt($("setFocus").value) || 50)); settings.breakMin = Math.max(1, Math.min(60, parseInt($("setBreak").value) || 10)); settings.coffeeMg = Math.max(0, Math.min(800, parseInt($("setCoffeeMg").value) || 95)); settings.soundOn = $("soundOn").checked; localStorage.setItem(K("settings"), JSON.stringify(settings)); if (!fRun) { fRemain = fTotal(); fRender(); } fHint(); }

  function bind() {
    $("unlockForm").addEventListener("submit", (e) => { e.preventDefault(); unlock($("passphrase").value); });
    document.querySelectorAll(".navbtn").forEach((t) => t.addEventListener("click", () => setView(t.dataset.tab)));
    document.querySelectorAll(".subtab").forEach((b) => b.addEventListener("click", () => setSub(b.dataset.app, b.dataset.sub)));
    document.querySelectorAll(".winbtn").forEach((b) => b.addEventListener("click", () => setWindow(b.dataset.win)));
    $("fStart").onclick = fStartFn; $("fReset").onclick = fReset; $("pillFocus").onclick = () => { if (!fRun) fSetMode("focus", true); }; $("pillBreak").onclick = () => { if (!fRun) fSetMode("break", true); };
    $("rStart").onclick = rStartFn; $("rStop").onclick = rFinish; $("currentBook").onchange = (e) => { curBookId = e.target.value; localStorage.setItem(K("curBook"), curBookId); renderReading(); };
    $("addBookBtn").onclick = () => openBook(null); $("bookSave").onclick = saveBook; $("bookCancel").onclick = () => ($("bookBackdrop").hidden = true); $("bookDelete").onclick = delBook; $("bStatus").onchange = () => ($("ratingField").hidden = $("bStatus").value !== "finished"); $("starRow").onclick = (e) => { if (e.target.dataset.v) { editRating = +e.target.dataset.v; starsSync(); } }; $("bookBackdrop").onclick = (e) => { if (e.target === $("bookBackdrop")) $("bookBackdrop").hidden = true; };
    $("logSave").onclick = rSaveLog; $("logDiscard").onclick = () => { $("logBackdrop").hidden = true; pendingRead = null; rReset(); };
    $("bStart").onclick = bStartFn; $("patSave").onclick = savePattern; $("patCancel").onclick = () => ($("patBackdrop").hidden = true); $("patBackdrop").onclick = (e) => { if (e.target === $("patBackdrop")) $("patBackdrop").hidden = true; };
    $("pStart").onclick = pStartFn; $("pStop").onclick = pFinish; $("currentProject").onchange = (e) => { curProjId = e.target.value; localStorage.setItem(K("curProj"), curProjId); renderProjects(); };
    $("addProjBtn").onclick = () => openProj(null); $("projSave").onclick = saveProj; $("projCancel").onclick = () => ($("projBackdrop").hidden = true); $("projDelete").onclick = delProj; $("projBackdrop").onclick = (e) => { if (e.target === $("projBackdrop")) $("projBackdrop").hidden = true; };
    $("plogSave").onclick = pSaveLog; $("plogDiscard").onclick = () => { $("plogBackdrop").hidden = true; pendingProj = null; pReset(); };
    $("logCoffee").onclick = () => logCaffeine("Coffee", settings.coffeeMg);
    $("openSettings").onclick = () => { $("setFocus").value = settings.focusMin; $("setBreak").value = settings.breakMin; $("setCoffeeMg").value = settings.coffeeMg; $("soundOn").checked = settings.soundOn; $("settingsBackdrop").hidden = false; };
    $("closeSettings").onclick = () => { saveSettings(); $("settingsBackdrop").hidden = true; }; $("settingsBackdrop").onclick = (e) => { if (e.target === $("settingsBackdrop")) { saveSettings(); $("settingsBackdrop").hidden = true; } };
    $("exportBtn").onclick = exportData;
    // backfill
    $("bfFocus").onclick = () => openBackfill("focus"); $("bfRead").onclick = () => openBackfill("read"); $("bfBreathe").onclick = () => openBackfill("breathe"); $("bfCaf").onclick = () => openBackfill("caffeine"); $("bfProj").onclick = () => openBackfill("project");
    $("bfCancel").onclick = () => ($("bfBackdrop").hidden = true); $("bfSave").onclick = saveBackfill; $("bfBackdrop").onclick = (e) => { if (e.target === $("bfBackdrop")) $("bfBackdrop").hidden = true; };
    // delete (tap a session row → entry sheet)
    [["fRecent", "focus"], ["rRecent", "read"], ["bRecent", "breathe"], ["cafList", "caffeine"], ["pRecent", "project"]].forEach(([id, m]) => { const el = $(id); if (el) el.onclick = (e) => { const li = e.target.closest(".recent-item, .mini-item"); if (li && li.dataset.id) openEntry(m, li.dataset.id); }; });
    $("entryCancel").onclick = () => { $("entryBackdrop").hidden = true; entryCtx = null; }; $("entryDelete").onclick = doDelete; $("entryBackdrop").onclick = (e) => { if (e.target === $("entryBackdrop")) { $("entryBackdrop").hidden = true; entryCtx = null; } };
    $("forgetBtn").onclick = () => { if (confirm("Sign out on this device? Your data stays in the cloud.")) { localStorage.removeItem(K("vault")); location.reload(); } };
    $("eraseBtn").onclick = async () => { const a = prompt("Permanently erase ALL Orbit data from Supabase (focus, reading, breath, caffeine, projects). Type ERASE to confirm:"); if (a === null) return; if (a.trim().toUpperCase() !== "ERASE") { toast("Not erased"); return; } try { await Promise.all(["focus_erase", "reading_erase", "wellness_erase", "caffeine_erase", "project_erase"].map((fn) => rpc(fn, { p_vault: vault }))); focusBlocks = []; books = []; readSess = []; wellSess = []; cafLogs = []; projects = []; projSess = []; cacheAll(); renderAll(); $("settingsBackdrop").hidden = true; toast("All data erased"); } catch (e) { toast("Couldn't erase — check connection"); } };
    window.addEventListener("online", () => { if (vault) refreshFromCloud(); });
    window.addEventListener("offline", () => setSync("offline"));
    document.addEventListener("visibilitychange", () => { if (!document.hidden && vault) { refreshFromCloud(); if (fRun || rRun || pRun || bRun) acquireWake(); fRender(); rRender(); pRender(); } });
  }

  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  bind();
  if (vault) showApp();
})();
