"use strict";

/* Implementation Trends — client-side engine + UI. All processing in-browser; nothing uploaded.
   History persists in localStorage; back it up with the Data menu. */

const CONFIG = {
  columns: {
    record_id: "Record ID", name: "Implementation Name", impl_type: "Implementation Type",
    current_stage: "Implementation pipeline stage", time_in_current_stage: "Time in current stage",
    date_entered_current_stage: "Date entered current stage", po_date: "PO Date",
    live_complete_date: "Implementation Live/Complete",
    duration_po_to_live: "Duration between PO date and Live/Complete Date",
    create_date: "Object create date/time",
  },
  durationColsMs: ["time_in_current_stage", "duration_po_to_live"],
  typeLabels: { "CAREpoint": ["carepoint", "cp3"], "e-Bridge": ["e-bridge", "ebridge"] },
  filenameDateRegex: /(\d{4})-(\d{2})-\d{2}/,
  // Full Implementation Pipeline (ordered). Panel always shows every stage; update if HubSpot changes stages.
  pipelineStages: [
    "Not Started", "Pending Sales Purchase Review", "Pending Kickoff Call",
    "Pending Technical Readiness", "Pending Server Tour", "Pending Server/Remote Access",
    "Pending Software Installation", "Software Installation Completed", "Network Testing",
    "Network Testing Completed", "In Progress", "In Training", "Waiting on Customer",
    "Waiting on GD", "On-hold", "Go-Live Scheduled", "Implementation Live/Complete",
  ],
};
const MS_PER_DAY = 86400000, STORE_KEY = "impl_trends_history_v1", THEME_KEY = "impl_trends_theme";
const CP = "#2f6ded", EB = "#ea8a2f", GOOD = "#15803d", BAD = "#dc2626", GRAY = "#9aa2af";
const FLOOR_YEAR = 2025, MAX_YEAR = 2030;   // Implementation object created Aug 2025; picker scales to 2030
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LIVE_STAGE = "Implementation Live/Complete";
let viewRange = { from: null, to: null };
let selectedStage = null;
let cohort = "all";                                      // "all" | "CAREpoint" | "e-Bridge"
function m2Map(store) { const m = store.m2 || {}; return m.all ? m : { all: m }; }               // legacy stores wrap as all
function sdMap(store) { const s = store.stageDaily || {}; return s.all ? s : { all: s }; }
function m2Sel(store) { return m2Map(store)[cohort] || {}; }
function sdSel(store) { return sdMap(store)[cohort] || { days: [], series: {}, open: {} }; }
function cohortLabel() { return cohort === "all" ? "" : " · " + cohort; }
function addDay(d) { return new Date(d.getTime() + MS_PER_DAY); }
function dstr(d) { return d.toISOString().slice(0, 10); }
function fmtDay(ds) { const d = new Date(ds + "T00:00:00Z"); return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit", timeZone: "UTC" }); }

/* ---------- CSV / parse ---------- */
function parseCSV(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; } else if (c === "\r") { } else f += c; }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  if (!rows.length) return [];
  const h = rows[0].map(x => x.trim());
  return rows.slice(1).filter(r => r.some(v => v && v.trim())).map(r => { const o = {}; h.forEach((k, i) => o[k] = (r[i] || "").trim()); return o; });
}
function parseDate(v) { if (!v) return null; const s = String(v).trim(); if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
  const d = new Date(s); return isNaN(d) ? null : d; }
function parseDurationDays(v) { if (!v) return null; const s = String(v).replace(/,/g, "").trim(); if (!s) return null; const n = Number(s); return isNaN(n) ? null : n / MS_PER_DAY; }
function resolveTypes(raw) { if (!raw) return []; const t = String(raw).split(/[;,]/).map(x => x.trim().toLowerCase()).filter(Boolean); const o = [];
  for (const [l, a] of Object.entries(CONFIG.typeLabels)) if (t.some(x => a.map(z => z.toLowerCase()).includes(x))) o.push(l); return o; }
function monthKey(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; }
function monthStart(k) { const [y, m] = k.split("-").map(Number); return new Date(Date.UTC(y, m - 1, 1)); }
function snapshotMonthFromName(n) { const m = (n || "").match(CONFIG.filenameDateRegex); return m ? `${m[1]}-${m[2]}` : monthKey(new Date()); }
function normalize(rows) { const C = CONFIG.columns;
  const miss = Object.values(C).filter(c => rows.length && !(c in rows[0])); if (miss.length) throw new Error("Missing column(s): " + miss.join(", "));
  const mapped = rows.map(r => { const live = parseDate(r[C.live_complete_date]), po = parseDate(r[C.po_date]);
    const intervals = {};                              // per-stage entered/exited (for daily reconstruction)
    for (const s of CONFIG.pipelineStages) {
      const en = parseDate(r[`Date entered "${s} (Implementation Pipeline)"`]);
      if (en) intervals[s] = { enter: en, exit: parseDate(r[`Date exited "${s} (Implementation Pipeline)"`]) };
    }
    const stage = (r[C.current_stage] || "").trim();
    // Authoritative signals: went live = the date property; exited pipeline = the stage move
    // (timestamped by HubSpot's stage-entry date; fall back to the live date for legacy rows).
    const closedDate = (intervals[LIVE_STAGE] && intervals[LIVE_STAGE].enter) || (stage === LIVE_STAGE ? live : null);
    return { id: (r[C.record_id] || "").trim(), name: (r[C.name] || "").trim(), types: resolveTypes(r[C.impl_type]),
      stage, timeInStageDays: parseDurationDays(r[C.time_in_current_stage]),
      poToLiveDays: parseDurationDays(r[C.duration_po_to_live]), poDate: po, liveDate: live, closedDate,
      createDate: parseDate(r[C.create_date]), isOpen: stage !== LIVE_STAGE, intervals }; }).filter(r => r.id);
  const byId = new Map(); mapped.forEach(r => byId.set(r.id, r));   // dedupe by Record ID (last wins)
  return [...byId.values()]; }

/* ---------- metrics ---------- */
function mean(a) { const v = a.filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; }
function m1StageAge(records) { const b = {};
  for (const r of records) { const st = r.stage || "(unknown)"; (b[st] ||= { open: 0, times: [] });
    if (r.isOpen) { b[st].open++; if (r.timeInStageDays != null) b[st].times.push(r.timeInStageDays); } }
  const o = {}; for (const [st, v] of Object.entries(b)) o[st] = { avg: v.times.length ? Math.round(mean(v.times)) : null, n: v.open }; return o; }
function m2History(records) { const b = {};
  for (const r of records) { if (!r.liveDate) continue; let d = r.poToLiveDays; if (d == null && r.poDate) d = Math.round((r.liveDate - r.poDate) / MS_PER_DAY);
    if (d == null || d < 0) continue; (b[monthKey(r.liveDate)] ||= []).push(d); }
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(mean(v))])); }
function m3Daily(records) {                             // open pipeline per DAY, by type — open until the STAGE moves to Live/Complete
  const labels = Object.keys(CONFIG.typeLabels); let minD = null, maxD = null;
  records.forEach(r => { if (r.createDate) { if (!minD || r.createDate < minD) minD = r.createDate; if (!maxD || r.createDate > maxD) maxD = r.createDate; } if (r.closedDate && (!maxD || r.closedDate > maxD)) maxD = r.closedDate; });
  if (!minD) return [];
  const end = maxD || minD, out = [];
  for (let d = new Date(Date.UTC(minD.getUTCFullYear(), minD.getUTCMonth(), minD.getUTCDate())); d <= end && out.length < 1500; d = addDay(d)) {
    const D = d.getTime(), row = { date: dstr(d), total: 0 }; labels.forEach(l => row[l] = 0);
    for (const r of records) { if (!r.createDate || r.createDate.getTime() > D) continue; if (r.closedDate && r.closedDate.getTime() <= D) continue; row.total++; r.types.forEach(t => { if (labels.includes(t)) row[t]++; }); }
    out.push(row);
  }
  return out; }
function pendingClose(records, snapMonth) {             // live date set but stage not yet Live/Complete — summary stats
  const asOf = monthStart(snapMonth); const end = new Date(Math.max(asOf.getTime(), ...records.map(r => r.liveDate ? r.liveDate.getTime() : 0)));
  return records.filter(r => r.liveDate && r.stage !== LIVE_STAGE)
    .map(r => ({ name: r.name, stage: r.stage, types: r.types, live: dstr(r.liveDate), days: Math.max(0, Math.round((end - r.liveDate) / MS_PER_DAY)) }))
    .sort((a, b) => b.days - a.days); }
function pendingDaily(records) {                        // DAILY count of live-but-not-closed — timeline of the bucket
  const withLive = records.filter(r => r.liveDate); if (!withLive.length) return [];
  let minD = null, maxD = null;
  withLive.forEach(r => { if (!minD || r.liveDate < minD) minD = r.liveDate; const e = r.closedDate || r.liveDate; if (!maxD || e > maxD) maxD = e; });
  const out = [];
  for (let d = new Date(Date.UTC(minD.getUTCFullYear(), minD.getUTCMonth(), minD.getUTCDate())); d <= maxD && out.length < 1500; d = addDay(d)) {
    const D = d.getTime(); let c = 0;
    for (const r of withLive) { if (r.liveDate.getTime() <= D && (!r.closedDate || r.closedDate.getTime() > D)) c++; }
    out.push({ date: dstr(d), v: c });
  }
  return out; }
function m4GoLives(records) { const b = {}; for (const r of records) if (r.liveDate) b[dstr(r.liveDate)] = (b[dstr(r.liveDate)] || 0) + 1; return b; }  // by DAY

function buildStageDaily(records) {                    // daily avg-days-in-stage per stage, from entered/exited dates
  const stages = CONFIG.pipelineStages.filter(s => s !== LIVE_STAGE);
  const open = {}; stages.forEach(s => open[s] = 0);
  records.forEach(r => { if (r.isOpen && open[r.stage] != null) open[r.stage]++; });
  const byStage = {}; stages.forEach(s => byStage[s] = []);
  let minD = null, maxD = null;
  records.forEach(r => { for (const [s, iv] of Object.entries(r.intervals || {})) {
    if (s === LIVE_STAGE || !byStage[s] || !iv.enter) continue;
    byStage[s].push(iv);
    if (!minD || iv.enter < minD) minD = iv.enter;
    if (!maxD || iv.enter > maxD) maxD = iv.enter;
    if (iv.exit && iv.exit > maxD) maxD = iv.exit;
  } });
  if (!minD) return { days: [], series: {}, open };
  const end = maxD || minD;
  const days = []; for (let d = new Date(Date.UTC(minD.getUTCFullYear(), minD.getUTCMonth(), minD.getUTCDate())); d <= end && days.length < 1200; d = addDay(d)) days.push(dstr(d));
  const series = {}; stages.forEach(s => series[s] = new Array(days.length).fill(null));
  days.forEach((ds, di) => { const D = new Date(ds + "T00:00:00Z").getTime();
    stages.forEach(s => { let sum = 0, c = 0;
      for (const iv of byStage[s]) { const en = iv.enter.getTime(), ex = iv.exit ? iv.exit.getTime() : Infinity;
        if (en <= D && ex > D) { sum += (D - en) / MS_PER_DAY; c++; } }
      if (c) series[s][di] = Math.round(sum / c);
    });
  });
  return { days, series, open };
}

/* ---------- storage ---------- */
function blankStore() { return { m1: {}, m2: {}, m3: [], m4: {}, stageDaily: null, lastImport: null, asOfMonth: null }; }
function loadStore() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || blankStore(); } catch { return blankStore(); } }
function saveStore(s) { localStorage.setItem(STORE_KEY, JSON.stringify(s)); }
function applyImport(store, records, snap) {
  store.m1[snap] = m1StageAge(records);                 // stage snapshot always recorded for its month
  const older = store.asOfMonth && snap < store.asOfMonth;
  if (!older) {                                          // newest file wins for the backfilled metrics
    const byType = t => records.filter(r => r.types.includes(t));
    store.m3 = m3Daily(records);
    store.m4 = { all: m4GoLives(records), "CAREpoint": m4GoLives(byType("CAREpoint")), "e-Bridge": m4GoLives(byType("e-Bridge")) };
    store.m2 = { all: m2History(records), "CAREpoint": m2History(byType("CAREpoint")), "e-Bridge": m2History(byType("e-Bridge")) };
    store.stageDaily = { all: buildStageDaily(records), "CAREpoint": buildStageDaily(byType("CAREpoint")), "e-Bridge": buildStageDaily(byType("e-Bridge")) };
    store.pendingClose = pendingClose(records, snap);
    store.pendingDaily = { all: pendingDaily(records), "CAREpoint": pendingDaily(byType("CAREpoint")), "e-Bridge": pendingDaily(byType("e-Bridge")) };
    store.asOfMonth = snap;
  }
  store.lastImport = { month: snap, records: records.length, when: new Date().toISOString(), older: !!older };
  store.demo = false;
  viewRange = { from: null, to: null }; return store; }

/* ---------- helpers ---------- */
function fmtMonth(k) { if (!k) return "—"; const [y, m] = k.split("-").map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }); }
function pill(d, lowerBetter) { if (d == null) return `<span class="pill flat">new</span>`; if (d === 0) return `<span class="pill flat">0</span>`;
  const down = d < 0, ok = lowerBetter ? down : !down; return `<span class="pill ${ok ? "good" : "bad"}">${down ? "&#9660;" : "&#9650;"} ${Math.abs(d)}</span>`; }
function m4Map(store) { const m = store.m4 || {}; return m.all ? m : { all: m }; }                 // legacy stores wrap as all
function m4Sel(store) { return m4Map(store)[cohort] || {}; }
function dataDayBounds(store) {                          // [firstDay, lastDay] across every series
  const days = [];
  (store.m3 || []).forEach(r => days.push(r.date));
  (sdMap(store).all.days || []).forEach(d => days.push(d));
  Object.keys(m4Map(store).all || {}).forEach(d => days.push(d));
  Object.keys(m2Map(store).all || {}).forEach(m => days.push(m + "-01"));
  days.sort();
  return days.length ? [days[0], days[days.length - 1]] : null;
}
function inRange(m) {                                     // month key overlaps the selected day range
  if (!viewRange.from || !viewRange.to) return true;
  const [y, mo] = m.split("-").map(Number); const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return (m + "-01") <= viewRange.to && (m + "-" + String(last).padStart(2, "0")) >= viewRange.from;
}
function inDayRange(ds) { return (!viewRange.from || ds >= viewRange.from) && (!viewRange.to || ds <= viewRange.to); }
function priorWindow() {                                  // the equal-length window immediately before the selected one
  const f = new Date(viewRange.from + "T00:00:00Z"), t = new Date(viewRange.to + "T00:00:00Z");
  const len = Math.round((t - f) / MS_PER_DAY) + 1;
  return [dstr(new Date(f.getTime() - len * MS_PER_DAY)), dstr(new Date(f.getTime() - MS_PER_DAY))];
}
function themeColors() { const dark = document.documentElement.getAttribute("data-theme") === "dark";
  return { grid: dark ? "#222a39" : "#eef1f5", tick: dark ? "#7c8798" : "#9aa2af", line: getComputedStyle(document.documentElement).getPropertyValue("--blue").trim() || "#2f6ded" }; }

/* ---------- charts ---------- */
const charts = {};
function destroy(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }
function areaChart(id, pts, height, labelFmt) {
  labelFmt = labelFmt || fmtMonth;
  destroy(id); const el = document.getElementById(id); if (!el) return; const tc = themeColors();
  const g = el.getContext("2d").createLinearGradient(0, 0, 0, height || 220); g.addColorStop(0, tc.line + "33"); g.addColorStop(1, tc.line + "00");
  charts[id] = new Chart(el, { type: "line",
    data: { labels: pts.map(p => p.m), datasets: [{ data: pts.map(p => p.v), borderColor: tc.line, backgroundColor: g, borderWidth: 2.5, fill: true, tension: .38, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: tc.line, pointHoverBorderColor: "#fff", pointHoverBorderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: c => labelFmt(c[0].label), label: c => ` ${c.parsed.y}` } } },
      scales: { x: { grid: { display: false }, ticks: { color: tc.tick, maxRotation: 0, autoSkip: true, maxTicksLimit: 7, callback: function (v) { return labelFmt(this.getLabelForValue(v)); } } },
        y: { grid: { color: tc.grid, drawBorder: false }, ticks: { color: tc.tick, maxTicksLimit: 5 }, beginAtZero: true } } } });
}
function barChart(id, pts) {
  destroy(id); const el = document.getElementById(id); if (!el) return; const tc = themeColors();
  charts[id] = new Chart(el, { type: "bar",
    data: { labels: pts.map(p => p.m), datasets: [{ data: pts.map(p => p.v), backgroundColor: tc.line, borderRadius: 5, borderSkipped: false, barPercentage: .7, categoryPercentage: .8 }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: c => fmtMonth(c[0].label), label: c => ` ${c.parsed.y} go-lives` } } },
      scales: { x: { grid: { display: false }, ticks: { color: tc.tick, maxRotation: 0, autoSkip: true, maxTicksLimit: 8, callback: function (v) { return this.getLabelForValue(v).slice(2); } } },
        y: { grid: { color: tc.grid, drawBorder: false }, ticks: { color: tc.tick, maxTicksLimit: 5, precision: 0 }, beginAtZero: true } } } });
}

const crosshair = { id: "xhair", afterDraw(c) {
  if (!c.tooltip || !c.tooltip._active || !c.tooltip._active.length) return;
  const x = c.tooltip._active[0].element.x, { top, bottom } = c.chartArea, ctx = c.ctx;
  ctx.save(); ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom);
  ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.strokeStyle = "#9aa2af"; ctx.stroke(); ctx.restore();
} };

function miniSpark(vals, color) {
  const pts = vals.map((v, i) => ({ v, i })).filter(p => p.v != null);
  if (!pts.length) return `<svg width="100" height="24"></svg>`;
  if (pts.length === 1) return `<svg width="100" height="24"><circle cx="50" cy="12" r="3" fill="${color}"/></svg>`;
  const n = vals.length, min = Math.min(...pts.map(p => p.v)), max = Math.max(...pts.map(p => p.v)), rng = max - min || 1;
  const X = i => 3 + 94 * i / (n - 1), Y = v => 20 - 16 * (v - min) / rng;
  const path = pts.map(p => `${X(p.i).toFixed(1)},${Y(p.v).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return `<svg width="100" height="24" viewBox="0 0 100 24"><polyline points="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${X(last.i).toFixed(1)}" cy="${Y(last.v).toFixed(1)}" r="2.5" fill="${color}"/></svg>`;
}

/* ---------- render ---------- */
function render(store) {
  const dash = document.getElementById("dashboard"), empty = document.getElementById("empty");
  if (currentView === "history") { dash.classList.add("hidden"); empty.classList.add("hidden"); if (!store.lastImport) return; }
  else if (!store.lastImport) { dash.classList.add("hidden"); empty.classList.remove("hidden"); return; }
  else { empty.classList.add("hidden"); dash.classList.remove("hidden"); }

  const bounds = dataDayBounds(store);
  if (bounds) { if (!viewRange.from) viewRange.from = bounds[0]; if (!viewRange.to) viewRange.to = bounds[1]; }
  syncRangeInputs();
  const [pFrom, pTo] = priorWindow();                     // equal-length window immediately before the selection
  const priorHasData = bounds && pTo >= bounds[0];         // suppress comparisons when the prior window predates the data

  const labels = Object.keys(CONFIG.typeLabels);
  const m3 = store.m3 || [];                             // daily rows {date,total,CAREpoint,e-Bridge}
  const bl = r => cohort === "all" ? r.total : (r[cohort] || 0);   // backlog value under the cohort filter
  const win = m3.filter(r => inDayRange(r.date));         // filtered window governs the chart
  const cur = win.length ? win[win.length - 1] : (m3.length ? m3[m3.length - 1] : { total: 0 });
  let prevRow = null; if (priorHasData) for (const r of m3) { if (r.date <= pTo) prevRow = r; else break; }   // state at end of prior window
  const prevLbl = prevRow ? "prior period (ended " + fmtDay(prevRow.date) + ")" : null;
  const backlogDelta = prevRow ? bl(cur) - bl(prevRow) : null;

  // go-lives: cohort-filtered daily counts -> monthly bars within the window; compare = window total vs prior-window total
  const m4c = m4Sel(store);
  const glMonthly = {}; let glWinTotal = 0, glPrevTotal = 0;
  Object.entries(m4c).forEach(([d, c]) => {
    if (inDayRange(d)) { const mk = d.slice(0, 7); glMonthly[mk] = (glMonthly[mk] || 0) + c; glWinTotal += c; }
    else if (d >= pFrom && d <= pTo) glPrevTotal += c;
  });
  const glKeys = Object.keys(glMonthly).sort();
  const goliveDelta = priorHasData ? glWinTotal - glPrevTotal : null;

  const m2c = m2Sel(store);                              // cohort-filtered PO->go-live months
  const m2cropKeys = Object.keys(m2c).filter(inRange).sort();
  const speedTo = m2cropKeys.length ? Math.round(mean(m2cropKeys.map(k => m2c[k]))) : null;   // window average
  const m2prevKeys = Object.keys(m2c).filter(m => { const [y, mo] = m.split("-").map(Number); const last = new Date(Date.UTC(y, mo, 0)).getUTCDate(); return (m + "-01") <= pTo && (m + "-" + String(last).padStart(2, "0")) >= pFrom; }).sort();
  const speedPrevV = m2prevKeys.length ? Math.round(mean(m2prevKeys.map(k => m2c[k]))) : null;
  const speedDelta = (priorHasData && speedTo != null && speedPrevV != null) ? speedTo - speedPrevV : null;

  // KPIs — always show total + both cohorts; deltas compare against the end of the prior equal-length window
  const totalDelta = prevRow ? cur.total - prevRow.total : null;
  const kpis = [
    { label: "Open implementations (backlog)", icon: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>', val: cur.total, pill: pill(totalDelta, true), foot: prevLbl ? "vs prior period" : "open now" },
    { label: "CAREpoint open", icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/>', val: cur["CAREpoint"] || 0, pill: pill(prevRow ? (cur["CAREpoint"] || 0) - (prevRow["CAREpoint"] || 0) : null, true), foot: "vs prior period" },
    { label: "e-Bridge open", icon: '<path d="M4 7h16M4 12h16M4 17h10"/>', val: cur["e-Bridge"] || 0, pill: pill(prevRow ? (cur["e-Bridge"] || 0) - (prevRow["e-Bridge"] || 0) : null, true), foot: "vs prior period" },
  ];
  document.getElementById("kpis").innerHTML = kpis.map(k => `<div class="card kpi">
    <div class="kl">${k.label}<span class="ki"><svg class="ic" viewBox="0 0 24 24" style="width:17px;height:17px">${k.icon}</svg></span></div>
    <div class="kv">${typeof k.val === "number" ? k.val.toLocaleString() : k.val} ${k.pill}</div><div class="kfoot">${k.foot}</div></div>`).join("");

  // backlog — daily line within window, under the cohort filter
  document.getElementById("backlogNow").textContent = bl(cur).toLocaleString() + (cohort === "all" ? "" : "");
  document.querySelector("#sec-backlog h3").textContent = "Open pipeline trend (backlog)" + cohortLabel();
  document.getElementById("backlogPill").innerHTML = pill(backlogDelta, true) + (prevLbl ? ` <span style="font-size:12px;color:var(--hint)">vs ${prevLbl}</span>` : "");
  areaChart("backlogChart", win.map(r => ({ m: r.date, v: bl(r) })), 220, fmtDay);

  // go-lives per month — window bars + prior-period comparison
  document.querySelector("#sec-golive h3").textContent = "Go-lives per month" + cohortLabel();
  document.getElementById("goliveNow").textContent = glWinTotal.toLocaleString();
  document.getElementById("golivePill").innerHTML = pill(goliveDelta, false) + (goliveDelta != null ? ` <span style="font-size:12px;color:var(--hint)">vs prior period</span>` : "");
  barChart("goliveChart", glKeys.map(k => ({ m: k, v: glMonthly[k] })));
  document.getElementById("goliveCap").textContent = glWinTotal
    ? `${glWinTotal} implementation${glWinTotal === 1 ? "" : "s"} went live in the selected period` + (goliveDelta != null ? ` — ${goliveDelta >= 0 ? goliveDelta + " more" : Math.abs(goliveDelta) + " fewer"} than the ${Math.round((new Date(viewRange.to + "T00:00:00Z") - new Date(viewRange.from + "T00:00:00Z")) / MS_PER_DAY) + 1} days before.` : ".")
    : "No go-lives in the selected period.";
  const bdTot = cur.total || 1;
  document.getElementById("breakdown").innerHTML = [
    { l: "Total open", v: cur.total, c: "var(--ink)" }, { l: "CAREpoint", v: cur["CAREpoint"] || 0, c: CP }, { l: "e-Bridge", v: cur["e-Bridge"] || 0, c: EB },
  ].map(b => `<div class="bd"><div class="bd-n">${b.v.toLocaleString()}</div><div class="bd-l">${b.l}</div><div class="bar" style="background:${b.c};width:${Math.max(8, Math.round(b.v / bdTot * 100))}%"></div></div>`).join("");

  // speed to go-live (PO -> live/complete, by go-live month) — also native in HubSpot; here so the monthly story is one page
  if (speedTo != null) {
    document.querySelector("#sec-speed h3").textContent = "Time to go-live" + cohortLabel();
    document.getElementById("speedNow").textContent = speedTo;
    document.getElementById("speedPill").innerHTML = pill(speedDelta, true) + (speedDelta != null ? ` <span style="font-size:12px;color:var(--hint)">vs prior period</span>` : "");
    areaChart("speedChart", m2cropKeys.map(k => ({ m: k, v: m2c[k] })), 240);
    document.getElementById("speedCap").textContent = `${speedTo} days average for go-lives in the selected period` +
      (speedDelta != null ? (speedDelta < 0 ? ` — ${Math.abs(speedDelta)} faster than the prior period.` : speedDelta > 0 ? ` — ${speedDelta} slower than the prior period.` : " — unchanged from the prior period.") : ".");
  } else {
    destroy("speedChart");
    document.getElementById("speedNow").textContent = "—";
    document.getElementById("speedPill").innerHTML = "";
    document.getElementById("speedCap").textContent = "No completed implementations in the selected range.";
  }

  // live-pending-close — timeline of how many sit in the bucket (no individual customers shown)
  const STALE_DAYS = 30;
  const pcAll = (store.pendingClose || []).filter(p => cohort === "all" || (p.types || []).includes(cohort));
  document.querySelector("#sec-pending h3").textContent = "Live, pending close" + cohortLabel();
  const stale = pcAll.filter(p => p.days > STALE_DAYS).length;
  document.getElementById("pendPill").innerHTML = pcAll.length
    ? `<span class="pill ${stale ? "bad" : "flat"}">${pcAll.length} in bucket${stale ? ` · ${stale} over ${STALE_DAYS}d` : ""}</span>` : "";
  const pdMapAll = store.pendingDaily && store.pendingDaily.all ? store.pendingDaily : { all: store.pendingDaily || [] };
  const pd = (pdMapAll[cohort] || []).filter(p => inDayRange(p.date));
  areaChart("pendChart", pd.map(p => ({ m: p.date, v: p.v })), 160, fmtDay);
  const worst = pcAll.length ? pcAll[0].days : 0;
  document.getElementById("pendCap").textContent = pcAll.length
    ? `${pcAll.length} customer${pcAll.length === 1 ? " is" : "s are"} live awaiting close-out today${stale ? ` — ${stale} for more than ${STALE_DAYS} days (longest ${worst}d)` : ""}. A rising line means close-outs are falling behind go-lives.`
    : "No one is waiting on close-out. Clean.";

  // stage feature — TradingView watchlist + DAILY price chart, reconstructed from stage entered/exited dates
  const sd = sdSel(store);                              // respects the cohort filter (All / CAREpoint / e-Bridge)
  document.querySelector("#sec-stage h3").textContent = "Time in stage — where open work is piling up" + cohortLabel();
  const sdDays = sd.days || [];
  function stageArr(s) { return sd.series[s] || []; }
  function stageCur(s) { const a = stageArr(s); return a.length ? a[a.length - 1] : null; }
  function stageTrend(s) {                            // compares now vs ~30 days ago; down = clearing (good)
    const a = stageArr(s); if (!a.length) return { kind: "empty" };
    const cur = a[a.length - 1];
    if (cur == null) return a.some(v => v != null) ? { kind: "cleared" } : { kind: "empty" };
    const target = Math.max(0, a.length - 1 - 30); let prev = null;
    for (let i = target; i >= 0; i--) if (a[i] != null) { prev = a[i]; break; }
    if (prev == null) for (let i = target + 1; i < a.length - 1; i++) if (a[i] != null) { prev = a[i]; break; }
    if (prev == null) return { kind: "new" };
    const d = cur - prev, pct = prev ? d / prev * 100 : 0;
    if (Math.abs(pct) < 10) return { kind: "flat", d };
    return { kind: d > 0 ? "up" : "down", d };
  }
  function trendBadge(t) {
    if (t.kind === "up") return `<span class="pill bad">&#9650; ${t.d}d</span>`;
    if (t.kind === "down") return `<span class="pill good">&#9660; ${Math.abs(t.d)}d</span>`;
    if (t.kind === "cleared") return `<span class="pill good">&#9660; cleared</span>`;
    if (t.kind === "flat") return `<span class="pill flat">&#9644; flat</span>`;
    if (t.kind === "new") return `<span class="pill flat">new</span>`;
    return `<span class="pill flat">—</span>`;
  }
  const rows = CONFIG.pipelineStages.map(st => ({ st, cur: stageCur(st), open: sd.open[st] ?? 0, t: stageTrend(st) }))
    .sort((a, b) => (b.cur ?? -1) - (a.cur ?? -1) || b.open - a.open);

  if (!selectedStage || !CONFIG.pipelineStages.includes(selectedStage)) selectedStage = rows[0] ? rows[0].st : null;

  document.getElementById("stageList").innerHTML = rows.map(s =>
    `<div class="wl-row${s.st === selectedStage ? " sel" : ""}" data-stage="${s.st}">
      <span class="wnm" title="${s.st}">${s.st}</span>
      <span class="wlast">${s.cur != null ? s.cur + "d" : "—"}</span>${trendBadge(s.t)}</div>`).join("");
  document.querySelectorAll("#stageList .wl-row").forEach(el =>
    el.addEventListener("click", () => { selectedStage = el.dataset.stage; render(loadStore()); }));

  const sel = rows.find(r => r.st === selectedStage) || rows[0];
  document.getElementById("cpName").textContent = sel ? sel.st : "—";
  document.getElementById("cpPrice").textContent = sel && sel.cur != null ? sel.cur + "d" : "—";
  document.getElementById("cpBadge").innerHTML = sel ? trendBadge(sel.t) : "";
  destroy("stageBig");
  if (sel && sdDays.length) {
    const fullArr = stageArr(sel.st);
    const wi = sdDays.map((d, i) => ({ d, i })).filter(o => inDayRange(o.d));   // crop chart to the selected window
    const wdays = wi.map(o => o.d), arr = wi.map(o => fullArr[o.i]);
    const col = sel.t.kind === "up" ? BAD : (sel.t.kind === "down" || sel.t.kind === "cleared") ? GOOD : BLUE;
    const tc = themeColors(), el = document.getElementById("stageBig");
    const g = el.getContext("2d").createLinearGradient(0, 0, 0, 300); g.addColorStop(0, col + "33"); g.addColorStop(1, col + "00");
    charts["stageBig"] = new Chart(el, {
      type: "line",
      data: { labels: wdays, datasets: [{ data: arr, borderColor: col, backgroundColor: g, borderWidth: 2, fill: true, tension: .25, spanGaps: false, pointRadius: 0, pointHoverRadius: 5, pointBackgroundColor: col, pointHoverBorderColor: "#fff", pointHoverBorderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        onHover: (e, els) => { const c = charts["stageBig"]; if (!c) return; const pr = document.getElementById("cpPrice"), ro = document.getElementById("cpReadout");
          if (els && els.length) { const i = els[0].index, v = c.data.datasets[0].data[i], d = c.data.labels[i];
            pr.textContent = v == null ? "—" : v + "d"; ro.textContent = " · " + fmtDay(d) + (v == null ? " · no open work" : " · " + v + " days"); } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: c => fmtDay(c[0].label), label: c => c.parsed.y == null ? " no open work" : ` ${c.parsed.y} days` } },
          zoom: { pan: { enabled: true, mode: "x" }, zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" } } },
        scales: { x: { grid: { display: false }, ticks: { color: tc.tick, maxRotation: 0, autoSkip: true, maxTicksLimit: 8, callback: function (v) { return fmtDay(this.getLabelForValue(v)); } } },
          y: { grid: { color: tc.grid, drawBorder: false }, ticks: { color: tc.tick, maxTicksLimit: 5 }, beginAtZero: true } } },
      plugins: [crosshair],
    });
    el.onmouseleave = () => { document.getElementById("cpPrice").textContent = sel.cur != null ? sel.cur + "d" : "—"; document.getElementById("cpReadout").textContent = ""; };
    el.ondblclick = () => { if (charts["stageBig"]) charts["stageBig"].resetZoom(); };
  }

  const up = rows.filter(s => s.t.kind === "up").length;
  const down = rows.filter(s => s.t.kind === "down" || s.t.kind === "cleared").length;
  const flat = rows.filter(s => s.t.kind === "flat").length;
  document.getElementById("stageSummary").innerHTML = sdDays.length
    ? `<span><b style="color:var(--bad)">${up}</b> rising</span><span><b style="color:var(--good)">${down}</b> falling</span><span><b>${flat}</b> flat</span>`
    : `<span>Needs stage date columns in the export</span>`;

  document.getElementById("subtitle").textContent = `Implementation pipeline · ${store.lastImport.records} records · ${fmtDay(viewRange.from)} – ${fmtDay(viewRange.to)}` + (store.demo ? " · SAMPLE DATA — Reset, then import your export" : "");
}

function syncRangeInputs() {                              // reflect viewRange into the day-level date inputs
  const f = document.getElementById("fromDate"), t = document.getElementById("toDate");
  f.min = t.min = `${FLOOR_YEAR}-01-01`; f.max = t.max = `${MAX_YEAR}-12-31`;
  if (viewRange.from) f.value = viewRange.from;
  if (viewRange.to) t.value = viewRange.to;
}
function rangeFromInputs() {
  const f = document.getElementById("fromDate").value, t = document.getElementById("toDate").value;
  if (!f || !t) return null;
  return f <= t ? { from: f, to: t } : { from: t, to: f };  // auto-swap if inverted
}
function setTF(tf) {
  const store = loadStore(), b = dataDayBounds(store); if (!b) return;
  viewRange.to = b[1];
  if (tf === "all") viewRange.from = b[0];
  else {
    const n = parseInt(tf, 10), t = new Date(b[1] + "T00:00:00Z");
    const f = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - n, t.getUTCDate() + 1));
    viewRange.from = dstr(f) < b[0] ? b[0] : dstr(f);
  }
  document.querySelectorAll("#tfPresets button").forEach(x => x.classList.toggle("on", x.dataset.tf === tf));
  render(store);
}

/* ---------- theme ---------- */
function applyTheme(t) { document.documentElement.setAttribute("data-theme", t); localStorage.setItem(THEME_KEY, t);
  document.getElementById("themeIc").innerHTML = t === "dark"
    ? '<path d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z"/>'
    : '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>'; }

/* ---------- share ---------- */
function sharePNG() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  html2canvas(document.getElementById("dashboard"), { backgroundColor: dark ? "#0e1320" : "#eef1f5", scale: 2, useCORS: true }).then(cv => {
    const a = document.createElement("a"); a.href = cv.toDataURL("image/png"); a.download = "implementation-trends.png"; a.click();
  }).catch(() => toast("PNG export failed.", true));
}

/* ---------- import history (log of every import, with the raw file) ---------- */
const IMPORTS_KEY = "impl_trends_imports_v1";
const IMPORTS_MAX = 12;
let currentView = "dash";

function loadImports() { try { return JSON.parse(localStorage.getItem(IMPORTS_KEY)) || []; } catch { return []; } }
function saveImports(arr) {
  // Quota-safe: on overflow, drop the oldest raw files (keep their log lines) and retry.
  for (let attempt = 0; attempt < IMPORTS_MAX + 1; attempt++) {
    try { localStorage.setItem(IMPORTS_KEY, JSON.stringify(arr)); return true; }
    catch { const victim = [...arr].reverse().find(e => e.csv); if (!victim) return false; victim.csv = null; }
  }
  return false;
}
function logImport(entry) {
  const arr = loadImports();
  arr.unshift(entry);
  while (arr.length > IMPORTS_MAX) arr.pop();
  saveImports(arr);
}
function fmtDateTime(iso) { const d = new Date(iso); return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) + " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); }

function showView(v) {
  currentView = v;
  const hist = document.getElementById("history");
  document.querySelectorAll(".nav a").forEach(x => x.classList.toggle("on", (v === "history") === (x.dataset.view === "history") && (v !== "history" ? x.dataset.goto === "kpis" : true)));
  if (v === "history") { hist.classList.remove("hidden"); renderHistory(); render(loadStore()); }
  else { hist.classList.add("hidden"); document.getElementById("histPreview").classList.add("hidden"); render(loadStore()); }
}
function renderHistory() {
  const arr = loadImports();
  document.getElementById("histList").innerHTML = arr.length ? arr.map((e, i) => `
    <div class="hist-row">
      <div class="hf" title="${e.fileName}">${e.fileName}${i === 0 ? ' <span class="pill flat" style="margin-left:6px">latest</span>' : ""}${e.older ? ' <span class="pill flat" style="margin-left:6px">older file — kept newer data</span>' : ""}</div>
      <div class="hm hdate">${fmtDateTime(e.importedAt)}</div>
      <div class="hm">counted as ${fmtMonth(e.snapMonth)} · ${e.records.toLocaleString()} records</div>
      <div class="ha">
        <button class="btn" data-hview="${i}" ${e.csv ? "" : "disabled title='File no longer stored (freed for space) — metadata kept'"}>View</button>
        <button class="btn" data-hexp="${i}" ${e.csv ? "" : "disabled"}>Export</button>
      </div>
    </div>`).join("")
    : `<div style="color:var(--hint);padding:26px 0;text-align:center">No imports yet. Import a HubSpot export from the Dashboard and it will be logged here.</div>`;
  document.querySelectorAll("[data-hview]").forEach(b => b.addEventListener("click", () => previewImport(+b.dataset.hview)));
  document.querySelectorAll("[data-hexp]").forEach(b => b.addEventListener("click", () => exportImport(+b.dataset.hexp)));
}
function previewImport(i) {
  const e = loadImports()[i]; if (!e || !e.csv) return;
  const rows = parseCSV(e.csv), cols = rows.length ? Object.keys(rows[0]) : [];
  const shown = rows.slice(0, 50);
  document.getElementById("hpTitle").textContent = e.fileName;
  document.getElementById("hpSub").textContent = `Imported ${fmtDateTime(e.importedAt)} · counted as ${fmtMonth(e.snapMonth)} · showing ${shown.length} of ${rows.length.toLocaleString()} rows`;
  document.getElementById("hpTable").innerHTML = `<table class="htable"><thead><tr>${cols.map(c => `<th>${c}</th>`).join("")}</tr></thead>
    <tbody>${shown.map(r => `<tr>${cols.map(c => `<td>${(r[c] || "").slice(0, 60)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const pv = document.getElementById("histPreview");
  pv.classList.remove("hidden"); pv.dataset.idx = i;
  pv.scrollIntoView({ behavior: "smooth", block: "start" });
}
function exportImport(i) {
  const e = loadImports()[i]; if (!e || !e.csv) return;
  const blob = new Blob([e.csv], { type: "text/csv" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = e.fileName; a.click();
}

/* ---------- events ---------- */
function toast(msg, err) { const t = document.getElementById("toast"); t.textContent = msg; t.className = "toast show" + (err ? " err" : ""); setTimeout(() => t.className = "toast", 3200); }
function closeMenus() { document.querySelectorAll("details.menu[open]").forEach(d => d.open = false); }
function handleFile(file) { const r = new FileReader(); r.onload = e => {
  try { const records = normalize(parseCSV(e.target.result)); if (!records.length) throw new Error("No records found.");
    const snap = snapshotMonthFromName(file.name); const store = applyImport(loadStore(), records, snap); saveStore(store);
    logImport({ fileName: file.name, importedAt: new Date().toISOString(), snapMonth: snap, records: records.length, older: !!store.lastImport.older, csv: e.target.result });
    showView("dash");
    toast(store.lastImport.older
      ? `Recorded ${fmtMonth(snap)} stage snapshot. Kept newer backlog/speed data (${fmtMonth(store.asOfMonth)}).`
      : `Imported ${records.length} records for ${fmtMonth(snap)}.`); } catch (err) { toast("Import problem: " + err.message, true); } };
  r.readAsText(file); }

function init() {
  const zp = window.ChartZoom || window["chartjs-plugin-zoom"] || window.chartjsPluginZoom;
  if (zp && window.Chart) { try { Chart.register(zp); } catch (e) { } }   // no-op if auto-registered
  applyTheme(localStorage.getItem(THEME_KEY) || "light");

  // Dropdown menus close on outside click or Escape (and opening one closes the others).
  document.addEventListener("click", e => {
    document.querySelectorAll("details.menu[open]").forEach(d => { if (!d.contains(e.target)) d.open = false; });
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenus(); });

  // Day-level date range inputs, populated before the first import.
  syncRangeInputs();
  const file = document.getElementById("file"), pick = () => file.click();
  document.getElementById("importBtn").addEventListener("click", pick);
  document.getElementById("importBtn2").addEventListener("click", pick);
  file.addEventListener("change", e => { if (e.target.files[0]) handleFile(e.target.files[0]); file.value = ""; });
  const main = document.querySelector(".main");
  ["dragover", "dragenter"].forEach(ev => main.addEventListener(ev, e => e.preventDefault()));
  main.addEventListener("drop", e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); });

  document.getElementById("themeBtn").addEventListener("click", () => { applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"); render(loadStore()); });
  document.getElementById("pngBtn").addEventListener("click", () => { closeMenus(); sharePNG(); });
  document.getElementById("pdfBtn").addEventListener("click", () => { closeMenus(); window.print(); });

  document.getElementById("reset").addEventListener("click", () => { closeMenus(); if (confirm("Reset all data? This clears the stored history AND import log in this browser and cannot be undone. Back up first if unsure.")) { localStorage.removeItem(STORE_KEY); localStorage.removeItem(IMPORTS_KEY); localStorage.setItem("impl_trends_demo_off", "1"); location.reload(); } });
  document.getElementById("backup").addEventListener("click", () => { closeMenus();
    const blob = new Blob([localStorage.getItem(STORE_KEY) || JSON.stringify(blankStore())], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "implementation-trends-history.json"; a.click(); });
  const hf = document.getElementById("histFile");
  document.getElementById("restore").addEventListener("click", () => { closeMenus(); hf.click(); });
  hf.addEventListener("change", e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader();
    r.onload = ev => { try { const s = JSON.parse(ev.target.result); saveStore(s); viewRange = { from: null, to: null }; render(s); toast("History restored."); } catch { toast("Not a valid history file.", true); } }; r.readAsText(f); hf.value = ""; });

  ["fromDate", "toDate"].forEach(id =>
    document.getElementById(id).addEventListener("change", () => { const r = rangeFromInputs(); if (!r) return; viewRange.from = r.from; viewRange.to = r.to; document.querySelectorAll("#tfPresets button").forEach(x => x.classList.remove("on")); render(loadStore()); }));
  document.querySelectorAll("#tfPresets button").forEach(b => b.addEventListener("click", () => setTF(b.dataset.tf)));
  document.querySelectorAll("#cohortSel button").forEach(b => b.addEventListener("click", () => {
    cohort = b.dataset.c;
    document.querySelectorAll("#cohortSel button").forEach(x => x.classList.toggle("on", x === b));
    render(loadStore());
  }));

  document.querySelectorAll(".nav a").forEach(a => a.addEventListener("click", () => {
    document.querySelectorAll(".nav a").forEach(x => x.classList.remove("on")); a.classList.add("on");
    if (a.dataset.view === "history") { showView("history"); return; }
    if (currentView === "history") showView("dash");
    const el = document.getElementById(a.dataset.goto); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }));
  document.getElementById("histBack").addEventListener("click", () => { showView("dash"); document.querySelectorAll(".nav a").forEach(x => x.classList.toggle("on", x.dataset.goto === "kpis")); });
  document.getElementById("hpClose").addEventListener("click", () => document.getElementById("histPreview").classList.add("hidden"));
  document.getElementById("hpExport").addEventListener("click", () => { const i = +document.getElementById("histPreview").dataset.idx; exportImport(i); });

  const demoBtn = document.getElementById("demoBtn");
  if (demoBtn) demoBtn.addEventListener("click", () => { localStorage.removeItem("impl_trends_demo_off"); loadDemo(); });

  const s0 = loadStore();
  if (!s0.lastImport && !localStorage.getItem("impl_trends_demo_off")) loadDemo();
  else render(s0);
}
function loadDemo() {                                     // bundled sample so the demo experience works out of the box
  fetch("sample-data.csv").then(r => { if (!r.ok) throw 0; return r.text(); }).then(text => {
    const records = normalize(parseCSV(text));
    const store = applyImport(loadStore(), records, "2026-07");
    store.demo = true; saveStore(store);
    logImport({ fileName: "sample-data.csv (demo)", importedAt: new Date().toISOString(), snapMonth: "2026-07", records: records.length, older: false, csv: text });
    showView("dash");
  }).catch(() => render(loadStore()));
}
document.addEventListener("DOMContentLoaded", init);
