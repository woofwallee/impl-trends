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
  // Live Implementation Pipeline (ordered) — verified against HubSpot 2026-07-03 (15 stages).
  // "Pending Sales Purchase Review" and "Waiting on GD" were deleted in HubSpot and their
  // stage-date columns never carry data in the property family this app parses.
  pipelineStages: [
    "Not Started", "Pending Kickoff Call",
    "Pending Technical Readiness", "Pending Server Tour", "Pending Server/Remote Access",
    "Pending Software Installation", "Software Installation Completed", "Network Testing",
    "Network Testing Completed", "In Progress", "In Training", "Waiting on Customer",
    "On-hold", "Go-Live Scheduled", "Implementation Live/Complete",
  ],
};
const MS_PER_DAY = 86400000, STORE_KEY = "impl_trends_history_v1", THEME_KEY = "impl_trends_theme", TF_KEY = "impl_trends_tf";
const CP = "#2f6ded", EB = "#ea8a2f", GOOD = "#15803d", BAD = "#dc2626", GRAY = "#9aa2af", BLUE = "#2f6ded";
// TradingView Baseline palette, mapped to BUSINESS health (all baseline charts here are lower-is-better):
// above the baseline = worsening (red), below = improving (green). Gray = no baseline / no change.
const TV = { good: "#00C896", goodFill: "rgba(0,200,150,.08)", bad: "#FF4D5A", badFill: "rgba(255,77,90,.08)" };
const FLOOR_YEAR = 2025, MAX_YEAR = 2030;   // Implementation object created Aug 2025; picker scales to 2030
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LIVE_STAGE = "Implementation Live/Complete";
let viewRange = { from: null, to: null };
let selectedStage = null;
let wlCollapsed = false;                                 // stage-list sidebar state; session-only (resets on refresh)
function syncWlToggle() {
  const w = document.getElementById("stageWrap"), b = document.getElementById("wlToggle");
  if (!w || !b) return;
  w.classList.toggle("collapsed", wlCollapsed);
  b.innerHTML = wlCollapsed ? '&#8250;<span class="wl-lbl">Stages</span>' : "&#8249;";
  b.title = wlCollapsed ? "Show stage list" : "Hide stage list";
  b.setAttribute("aria-expanded", String(!wlCollapsed));
  b.setAttribute("aria-label", b.title);
}
let cohort = "all";                                      // "all" | "CAREpoint" | "e-Bridge"
function m2Map(store) { const m = store.m2 || {}; return m.all ? m : { all: m }; }               // legacy stores wrap as all
function sdMap(store) { const s = store.stageDaily || {}; return s.all ? s : { all: s }; }
function m2Sel(store) { return m2Map(store)[cohort] || {}; }
function sdSel(store) { const v = sdMap(store)[cohort]; return v && v.series ? v : { days: [], series: {}, open: {} }; }
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
      createDate: parseDate(r[C.create_date]), estLive: parseDate(r["Estimated Go-Live Date"]), isOpen: stage !== LIVE_STAGE, intervals }; }).filter(r => r.id);
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
  for (let d = new Date(Date.UTC(minD.getUTCFullYear(), minD.getUTCMonth(), minD.getUTCDate())); d <= end && out.length < 2600; d = addDay(d)) {   // safety cap ≈ 7 years of daily rows
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
  for (let d = new Date(Date.UTC(minD.getUTCFullYear(), minD.getUTCMonth(), minD.getUTCDate())); d <= maxD && out.length < 2600; d = addDay(d)) {
    const D = d.getTime(); let c = 0;
    for (const r of withLive) { if (r.liveDate.getTime() <= D && (!r.closedDate || r.closedDate.getTime() > D)) c++; }
    out.push({ date: dstr(d), v: c });
  }
  return out; }
function m4GoLives(records) { const b = {}; for (const r of records) if (r.liveDate) b[dstr(r.liveDate)] = (b[dstr(r.liveDate)] || 0) + 1; return b; }  // by DAY
function m2Daily(records) {                             // PO->live durations by go-live DAY {sum,n} — window averages are record-weighted and exact
  const b = {};
  for (const r of records) { if (!r.liveDate) continue; let d = r.poToLiveDays; if (d == null && r.poDate) d = Math.round((r.liveDate - r.poDate) / MS_PER_DAY);
    if (d == null || d < 0) continue; const k = dstr(r.liveDate); (b[k] ||= { s: 0, n: 0 }); b[k].s += d; b[k].n++; }
  return b; }

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
  const days = []; for (let d = new Date(Date.UTC(minD.getUTCFullYear(), minD.getUTCMonth(), minD.getUTCDate())); d <= end && days.length < 2600; d = addDay(d)) days.push(dstr(d));
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
    store.m2d = { all: m2Daily(records), "CAREpoint": m2Daily(byType("CAREpoint")), "e-Bridge": m2Daily(byType("e-Bridge")) };
    store.stageDaily = { all: buildStageDaily(records), "CAREpoint": buildStageDaily(byType("CAREpoint")), "e-Bridge": buildStageDaily(byType("e-Bridge")) };
    store.pendingClose = pendingClose(records, snap);
    store.pendingDaily = pendingDaily(records);
    const dayCount = (recs2, get) => { const m = {}; for (const r of recs2) { const t = get(r); if (t) { const k = dstr(t); m[k] = (m[k] || 0) + 1; } } return m; };
    store.startedDaily = { all: dayCount(records, r => r.createDate), "CAREpoint": dayCount(byType("CAREpoint"), r => r.createDate), "e-Bridge": dayCount(byType("e-Bridge"), r => r.createDate) };
    store.closedDaily = { all: dayCount(records, r => r.closedDate), "CAREpoint": dayCount(byType("CAREpoint"), r => r.closedDate), "e-Bridge": dayCount(byType("e-Bridge"), r => r.closedDate) };
    store.estUpcoming = records.filter(r => r.isOpen && r.estLive).map(r => ({ d: dstr(r.estLive), types: r.types }));
    store.asOfMonth = snap;
  }
  const unk = {};
  for (const r of records) if (r.stage && !CONFIG.pipelineStages.includes(r.stage)) unk[r.stage] = (unk[r.stage] || 0) + 1;
  store.unknownStages = Object.entries(unk).map(([name, count]) => ({ name, count }));
  store.lastImport = { month: snap, records: records.length, when: new Date().toISOString(), older: !!older };
  store.demo = false;
  viewRange = { from: null, to: null }; return store; }

/* ---------- helpers ---------- */
function fmtMonth(k) { if (!k) return "—"; const [y, m] = k.split("-").map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }); }
function pill(d, lowerBetter) { if (d == null) return `<span class="pill flat">no prior period in data</span>`; if (d === 0) return `<span class="pill flat">0</span>`;
  const down = d < 0, ok = lowerBetter ? down : !down; return `<span class="pill ${ok ? "good" : "bad"}">${down ? "&#9660;" : "&#9650;"} ${Math.abs(d)}</span>`; }
function m4Map(store) { const m = store.m4 || {}; return m.all ? m : { all: m }; }                 // legacy stores wrap as all
function m4Sel(store) { return m4Map(store)[cohort] || {}; }
function m2dSel(store) { return (store.m2d || {})[cohort] || {}; }                                 // absent on legacy stores (self-heal rebuilds)
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
function lblDate(l) { l = String(l); return l.length === 7 ? l + "-01" : l; }          // month keys sort like days
function lblTimes(c) { return c.$lblTimes || (c.$lblTimes = (c.data.labels || []).map(l => new Date(lblDate(l) + "T00:00:00Z").getTime())); }

// TradingView-style last-value marker: dotted line at the latest value, end dot, and a price-style label on the right axis
const lastValue = { id: "lastval", afterDatasetsDraw(c) {
  const ds = c.data.datasets[0]; if (!ds || c.config.type !== "line") return;
  let i = ds.data.length - 1; while (i >= 0 && ds.data[i] == null) i--;
  if (i < 0) return;
  const pt = c.getDatasetMeta(0).data[i]; if (!pt) return;
  const b = (c.options.plugins || {}).baseValue;
  const col = b == null ? themeColors().line : (ds.data[i] > b ? TV.bad : ds.data[i] < b ? TV.good : GRAY);
  const { left, right, top, bottom } = c.chartArea, y = pt.y, ctx = c.ctx;
  if (y < top || y > bottom) return;
  ctx.save();
  ctx.setLineDash([2, 3]); ctx.strokeStyle = col; ctx.globalAlpha = .55; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
  ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.fillStyle = col;
  if (pt.x >= left && pt.x <= right) { ctx.beginPath(); ctx.arc(pt.x, y, 3, 0, Math.PI * 2); ctx.fill(); }
  const txt = ((c.options.plugins || {}).lastValPrefix || "") + String(ds.data[i]); ctx.font = "600 10.5px Inter, system-ui, sans-serif";
  const w = ctx.measureText(txt).width + 10, h = 17;
  ctx.beginPath(); ctx.roundRect(right + 1, y - h / 2, w, h, 4); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.textBaseline = "middle"; ctx.fillText(txt, right + 6, y + .5);
  ctx.restore();
} };

// TV Baseline: thin, subtle dashed reference line at the base level
const baseLine = { id: "baseline", beforeDatasetsDraw(c) {
  const b = (c.options.plugins || {}).baseValue;
  if (b == null || !c.scales.y) return;
  const y = c.scales.y.getPixelForValue(b), { left, right } = c.chartArea, ctx = c.ctx;
  if (y < c.chartArea.top || y > c.chartArea.bottom) return;
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  ctx.save(); ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
  ctx.strokeStyle = dark ? "rgba(255,255,255,.20)" : "rgba(0,0,0,.20)";   // spec color; black-based twin for light theme
  ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); ctx.restore();
} };

// Exact-crossing color split (TV Baseline): the positive/negative line copies are clipped at the
// baseline pixel, so the stroke changes color exactly where it crosses — not per data segment.
const tvClip = { id: "tvclip",
  beforeDatasetDraw(c, args) {
    const ds = c.data.datasets[args.index]; if (!ds || !ds._tvRole) return;
    const b = (c.options.plugins || {}).baseValue; if (b == null || !c.scales.y) return;
    const a = c.chartArea, yb = Math.min(Math.max(c.scales.y.getPixelForValue(b), a.top), a.bottom), ctx = c.ctx;
    ctx.save(); ctx.beginPath();
    if (ds._tvRole === "pos") ctx.rect(a.left, a.top, a.right - a.left, yb - a.top);
    else ctx.rect(a.left, yb, a.right - a.left, a.bottom - yb);
    ctx.clip();
  },
  afterDatasetDraw(c, args) {
    const ds = c.data.datasets[args.index]; if (!ds || !ds._tvRole) return;
    const b = (c.options.plugins || {}).baseValue; if (b == null || !c.scales.y) return;
    c.ctx.restore();
  } };

/* TV Baseline datasets. Baseline = first VISIBLE value; fill splits exactly at the baseline;
   above = positive, below = negative. Flat colors — no gradients, no trend-direction coloring. */
function firstVisible(vals, lo, hi) {
  for (let i = Math.max(0, Math.ceil(lo)); i <= Math.min(vals.length - 1, Math.floor(hi)); i++) if (vals[i] != null) return vals[i];
  return null;
}
function tvBaselineDatasets(vals, i0, i1, extra) {
  const base = firstVisible(vals, i0, i1);
  const core = Object.assign({ data: vals, borderWidth: 1.6, tension: 0, pointRadius: 0 }, extra || {});
  if (base == null) return { base, datasets: [Object.assign({}, core, { borderColor: GRAY, fill: false })] };
  const carrier = Object.assign({}, core, {               // interaction + fill carrier; the visible strokes are the clipped copies
    borderColor: "rgba(0,0,0,0)", borderWidth: 0,
    pointHoverBackgroundColor: t => { const b = t.chart.options.plugins.baseValue, v = t.parsed ? t.parsed.y : null; return v == null || b == null ? GRAY : v > b ? TV.bad : v < b ? TV.good : GRAY; },
    fill: { target: { value: base }, above: TV.badFill, below: TV.goodFill },
  });
  const line = role => Object.assign({}, core, { borderColor: role === "pos" ? TV.bad : TV.good, fill: false, pointRadius: 0, pointHoverRadius: 0, _tvRole: role });
  return { base, datasets: [carrier, line("pos"), line("neg")] };
}

/* ---------- shared TV interaction layer (viewport, pan/zoom, toolbar, crosshair sync) ---------- */
function vpIdx(labels, vp) {                              // [i0,i1] viewport indices for the selected date range
  let i0 = 0, i1 = Math.max(0, labels.length - 1);
  if (vp && vp.from) { const j = labels.findIndex(l => lblDate(l) >= vp.from); if (j >= 0) i0 = j; }
  if (vp && vp.to) { let j = -1; for (let k = labels.length - 1; k >= 0; k--) if (lblDate(labels[k]) <= vp.to) { j = k; break; } if (j >= 0) i1 = j; }
  if (i1 <= i0) { i0 = 0; i1 = Math.max(0, labels.length - 1); }
  return [i0, i1];
}
let vpUserSet = false;                                    // becomes true when the user picks a preset/date range
function chartVp(labels, vp) {                            // viewport = the selected range, always: what the pill judges is what the chart shows
  return vpIdx(labels, vp);
}
function lastMonthRange(b) {                              // last full calendar month ending on or before the last data day
  const t = new Date(b[1] + "T00:00:00Z");
  let y = t.getUTCFullYear(), m = t.getUTCMonth();
  const lastOfM = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  if (t.getUTCDate() !== lastOfM) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  const from = dstr(new Date(Date.UTC(y, m, 1))), to = dstr(new Date(Date.UTC(y, m + 1, 0)));
  return { from: from < b[0] ? b[0] : from, to: to > b[1] ? b[1] : to };
}
function yBounds(vals, i0, i1, base) {                    // TV-style: y axis fits the visible data (+ the baseline)
  let lo = Infinity, hi = -Infinity;
  for (let i = Math.max(0, Math.floor(i0)); i <= Math.min(vals.length - 1, Math.ceil(i1)); i++) {
    const v = vals[i]; if (v == null) continue; if (v < lo) lo = v; if (v > hi) hi = v;
  }
  if (base != null) { lo = Math.min(lo, base); hi = Math.max(hi, base); }
  if (!isFinite(lo)) return null;
  const pad = ((hi - lo) || Math.max(1, Math.abs(hi) * .1)) * .12;
  return { min: Math.max(0, lo - pad), max: hi + pad };
}
function tvRebase(c) {                                    // after a viewport change: recompute baseline + refit y in ONE cheap update
  if (!c || !c.scales.x) return;
  const p = c.options.plugins || {}, ds = c.data.datasets[0];
  if ("baseValue" in p && ds) {
    const nb = firstVisible(ds.data, c.scales.x.min, c.scales.x.max);
    if (nb != null && nb !== p.baseValue) {
      p.baseValue = nb;
      if (ds.fill && typeof ds.fill === "object") ds.fill = { target: { value: nb }, above: TV.badFill, below: TV.goodFill };
    }
  }
  if (ds && c.options.scales.y && !c.options.scales.y.beginAtZero) {
    const yb = yBounds(ds.data, c.scales.x.min, c.scales.x.max, ("baseValue" in p) ? p.baseValue : null);
    if (yb) { c.options.scales.y.min = yb.min; c.options.scales.y.max = yb.max; }
  }
  c.update("none");
}
const MODK = typeof navigator !== "undefined" && /Mac/.test(navigator.platform || "") ? "meta" : "ctrl";
const MODLBL = MODK === "meta" ? "\u2318" : "Ctrl";
function tvZoom(n) { return {
  limits: { x: { min: 0, max: Math.max(0, n - 1), minRange: 1 } },   // pan/zoom stays within the data
  pan: { enabled: true, mode: "x", onPanComplete: ({ chart }) => tvRebase(chart) },
  zoom: { wheel: { enabled: true, modifierKey: MODK }, pinch: { enabled: true }, mode: "x", onZoomComplete: ({ chart }) => tvRebase(chart) },
}; }
const XGROUP = ["backlogChart", "speedChart", "goliveChart", "stageBig"];
const XSYNC = { date: null, src: null };
function tvRedrawOthers(srcId) { XGROUP.forEach(id => { if (id !== srcId && charts[id]) charts[id].draw(); }); }
function tvAttach(id, withToolbar) {                      // crosshair sync + double-click reset (+ toolbar where supported)
  const c = charts[id]; if (!c) return; const el = c.canvas;
  el.ondblclick = () => { const cc = charts[id]; if (cc) { cc.resetZoom("none"); tvRebase(cc); } };
  el.onmouseleave = () => { if (XSYNC.src === id) { XSYNC.date = null; XSYNC.src = null; tvRedrawOthers(id); } };
  const wrap = el.closest(".canvas-wrap");
  if (withToolbar === false) { if (wrap) { const old = wrap.querySelector(".tvbar"); if (old) old.remove(); } return; }
  tvToolbar(id);
}
function tvToolbar(id) {                                  // TV-style chart toolbar; injected once per canvas wrap
  const el = document.getElementById(id); if (!el) return;
  const wrap = el.closest(".canvas-wrap"); if (!wrap || wrap.querySelector(".tvbar")) return;
  const bar = document.createElement("div"); bar.className = "tvbar"; bar.setAttribute("data-html2canvas-ignore", "");
  // TradingView floating bar: [− +] [‹ ›] [⟲] — hover names appear after a short delay (CSS tooltip)
  bar.innerHTML = [["out", "Zoom out", "&minus;"], ["in", "Zoom in", "+"], ["back", "Scroll to the left", "&#8249;"], ["fwd", "Scroll to the right", "&#8250;"], ["reset", "Reset chart view", "&#8634;"]]
    .map(([a, t, s]) => `<button type="button" data-act="${a}" data-tip="${t}">${s}</button>`).join("");
  bar.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    const c = charts[id]; if (!c) return; const n = (c.data.labels || []).length;
    if (b.dataset.act === "back" || b.dataset.act === "fwd") {          // step half a screen through time, clamped to the data
      const x = c.scales.x, span = Math.max(2, x.max - x.min);
      let shift = Math.max(1, Math.round(span / 2)) * (b.dataset.act === "back" ? -1 : 1);
      shift = Math.max(-x.min, Math.min(shift, Math.max(0, n - 1 - x.max)));
      if (shift) c.zoomScale("x", { min: x.min + shift, max: x.max + shift }, "none");
    }
    else if (b.dataset.act === "in") c.zoom({ x: 1.25 });
    else if (b.dataset.act === "out") c.zoom({ x: 0.8 });
    else if (b.dataset.act === "reset") c.resetZoom("none");
    tvRebase(c);
  });
  wrap.appendChild(bar);
}

const CHART_NAMES = { backlogChart: "Open pipeline trend", speedChart: "PO to Go-Live", stageBig: "Time in stage detail", goliveChart: "Go-lives per period" };
function chartAria(id, pts) {
  const el = document.getElementById(id); if (!el) return;
  let last = null; for (let i = pts.length - 1; i >= 0; i--) if (pts[i].v != null) { last = pts[i]; break; }
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", (CHART_NAMES[id] || id) + (last ? ` chart · latest value ${last.v} on ${last.m}` : " chart · no data"));
}
function areaChart(id, pts, height, labelFmt, vp, opts) { // the ONE baseline-chart implementation (shared by all three)
  labelFmt = labelFmt || fmtMonth; opts = opts || {};
  destroy(id); const el = document.getElementById(id); if (!el) return; const tc = themeColors();
  const labels = pts.map(p => p.m), vals = pts.map(p => p.v);
  const [i0, i1] = chartVp(labels, vp);
  const { base, datasets } = tvBaselineDatasets(vals, i0, i1, { pointHoverRadius: 4, pointHoverBorderColor: "#fff", pointHoverBorderWidth: 2 });
  const yb = yBounds(vals, i0, i1, base) || { min: 0, max: 1 };
  charts[id] = new Chart(el, { type: "line",
    data: { labels, datasets },
    options: { animation: false, responsive: true, maintainAspectRatio: false, devicePixelRatio: Math.max(window.devicePixelRatio || 1, 2), interaction: { mode: "index", intersect: false },
      onHover: opts.onHover,
      plugins: { baseValue: base, legend: { display: false },
        tooltip: { animation: false, filter: t => t.datasetIndex === 0, callbacks: { title: c => labelFmt(c[0].label), label: opts.tooltipLabel || (c => ` ${c.parsed.y}`) } },
        zoom: tvZoom(labels.length) },
      scales: { x: { min: i0, max: i1, grid: { display: false }, ticks: { color: tc.tick, maxRotation: 0, autoSkip: true, maxTicksLimit: 7, callback: function (v) { return labelFmt(this.getLabelForValue(v)); } } },
        y: { position: "right", min: yb.min, max: yb.max, grid: { color: tc.grid, drawBorder: false }, ticks: { color: tc.tick, maxTicksLimit: 5 } } } },
    plugins: [crosshair, baseLine, lastValue, tvClip] });
  tvAttach(id, true);
  chartAria(id, pts);
}
function barChart(id, pts, fmt, bucket, vp) {
  fmt = fmt || fmtMonth; bucket = bucket || "month";
  destroy(id); const el = document.getElementById(id); if (!el) return; const tc = themeColors();
  const labels = pts.map(p => p.m), [i0, i1] = vpIdx(labels, vp);
  charts[id] = new Chart(el, { type: "bar",
    data: { labels, datasets: [{ data: pts.map(p => p.v), backgroundColor: tc.line, borderRadius: 5, borderSkipped: false, barPercentage: .7, categoryPercentage: .8 }] },
    options: { animation: false, responsive: true, maintainAspectRatio: false, devicePixelRatio: Math.max(window.devicePixelRatio || 1, 2), interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: { animation: false, callbacks: { title: c => (bucket === "week" ? "Week of " : "") + fmt(c[0].label), label: c => ` ${c.parsed.y} go-live${c.parsed.y === 1 ? "" : "s"}` } } },
      scales: { x: { min: i0, max: i1, grid: { display: false }, ticks: { color: tc.tick, maxRotation: 0, autoSkip: true, maxTicksLimit: 7, callback: function (v) { const l = this.getLabelForValue(v);
          if (bucket === "month") { const [y, m] = String(l).split("-").map(Number); return MONTHS[m - 1] + " " + String(y).slice(2); }   // "Oct 25", matching the other charts
          return fmt(l).replace(/, \d+$/, ""); } } },
        y: { grid: { color: tc.grid, drawBorder: false }, ticks: { color: tc.tick, maxTicksLimit: 5, precision: 0 }, beginAtZero: true } } },
    plugins: [crosshair] });
  tvAttach(id, false);                                    // GO-LIVES: crosshair sync only — a report line, not an explorer
  chartAria(id, pts);
}

// Crosshair: on the hovered chart it tracks the tooltip; on the other charts in the group it
// mirrors the same date (nearest visible label), TradingView-style synchronized scrubbing.
const crosshair = { id: "xhair", afterDraw(c) {
  const { top, bottom, left, right } = c.chartArea, ctx = c.ctx;
  let x = null;
  if (c.tooltip && c.tooltip._active && c.tooltip._active.length) {
    x = c.tooltip._active[0].element.x;
    // This chart is the scrub source: publish the hovered date, mirror on the others next frame.
    const label = c.data.labels[c.tooltip._active[0].index];
    if (XGROUP.includes(c.canvas.id) && (XSYNC.date !== label || XSYNC.src !== c.canvas.id)) {
      XSYNC.date = label; XSYNC.src = c.canvas.id;
      window.requestAnimationFrame(() => tvRedrawOthers(c.canvas.id));
    }
  }
  else if (XSYNC.date != null && XSYNC.src !== c.canvas.id && XGROUP.includes(c.canvas.id) && c.scales.x) {
    const times = lblTimes(c); if (!times.length) return;
    const t = new Date(lblDate(XSYNC.date) + "T00:00:00Z").getTime();
    let best = -1, bd = Infinity;
    const lo = Math.max(0, Math.ceil(c.scales.x.min)), hi = Math.min(times.length - 1, Math.floor(c.scales.x.max));
    for (let i = lo; i <= hi; i++) { const d = Math.abs(times[i] - t); if (d < bd) { bd = d; best = i; } }
    if (best < 0 || bd > 45 * MS_PER_DAY) return;
    x = c.scales.x.getPixelForValue(best);
  }
  if (x == null || x < left || x > right) return;
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

function windowTrend(vals) {                             // direction of the visible line: end vs start, ±5% deadband
  const v = vals.filter(x => x != null);
  if (v.length < 2) return null;
  const a = v[0], b = v[v.length - 1], base = Math.max(Math.abs(a), 1);
  if (Math.abs(b - a) / base < 0.05) return { kind: "flat" };
  return { kind: b > a ? "up" : "down" };
}

/* Stage Insights Panel (spec: docs/specs/2026-07-03-stage-insights-panel-design.md).
   Pure + deterministic: ranked candidates per detector, greedy assembly with per-stage dedup. */
function stageInsights(sd, sdStart, sdEnd, trends) {
  const stages = CONFIG.pipelineStages.filter(s => s !== LIVE_STAGE && (sd.series || {})[s]);
  const arr = s => sd.series[s] || [];
  const cur = s => { const a = arr(s); return sdEnd >= 0 && a[sdEnd] != null ? a[sdEnd] : null; };
  const t = s => trends[s] || { kind: "empty" };
  const rising = stages.filter(s => t(s).kind === "up");

  const bottleneck = rising.filter(s => cur(s) != null)
    .map(s => { const c = cur(s), o = (sd.open || {})[s] || 0; return { s, cur: c, open: o, score: o ? c * o : c }; })
    .sort((a, b) => b.score - a.score || b.open - a.open || b.cur - a.cur);

  const spikes = stages.map(s => {
    const c = cur(s); if (c == null) return null;
    const a = arr(s), base = [];
    for (let i = sdEnd - 1; i >= sdStart && base.length < 14; i--) if (a[i] != null) base.push(a[i]);
    if (base.length < 5) return null;
    const mu = base.reduce((x, y) => x + y, 0) / base.length;
    const sg = Math.sqrt(base.reduce((x, y) => x + (y - mu) * (y - mu), 0) / base.length);
    if (c - mu < Math.max(2.5 * sg, 5)) return null;
    return { s, cur: c, mu: Math.round(mu), z: (c - mu) / Math.max(sg, 1) };
  }).filter(Boolean).sort((a, b) => b.z - a.z);

  const worsening = rising.map(s => ({ s, d: t(s).d, pct: t(s).pct, cur: cur(s) ?? -1 }))
    .sort((a, b) => b.d - a.d || b.cur - a.cur);

  const improving = stages.map(s => {
    const tr = t(s);
    if (tr.kind === "down") return { s, d: tr.d, pct: tr.pct, mag: -tr.d, cleared: false };
    if (tr.kind === "cleared") { const a = arr(s); let last = 0; for (let i = sdEnd; i >= sdStart; i--) if (a[i] != null) { last = a[i]; break; } return { s, d: null, mag: last, cleared: true }; }
    return null;
  }).filter(Boolean).sort((a, b) => b.mag - a.mag);

  const used = new Set(), out = [];
  const take = (list, mk) => { for (const c of list) { if (used.has(c.s)) continue; used.add(c.s); out.push(mk(c)); return; } };
  take(bottleneck, c => ({ kind: "bottleneck", stage: c.s, severity: "red", values: { cur: c.cur, open: c.open } }));
  take(spikes, c => ({ kind: "spike", stage: c.s, severity: "red", values: { cur: c.cur, mu: c.mu } }));
  take(worsening, c => ({ kind: "worsening", stage: c.s, severity: "amber", values: { delta: c.d, pct: c.pct == null ? null : Math.round(c.pct), cur: c.cur } }));
  take(improving, c => ({ kind: "improving", stage: c.s, severity: "green", values: { delta: c.d, pct: c.pct == null ? null : Math.round(c.pct), cleared: c.cleared } }));
  const rank = { red: 0, amber: 1, green: 2 };
  const res = out.slice(0, 4).sort((a, b) => rank[a.severity] - rank[b.severity]);
  return res.length ? res : [{ kind: "none", stage: null, severity: "flat", values: {} }];
}
function insightText(f) {                                 // spec card templates, verbatim
  const v = f.values;
  if (f.kind === "bottleneck") return `${v.cur}d and rising · ${v.open} implementation${v.open === 1 ? "" : "s"} sitting here · the biggest drag on the pipeline`;
  if (f.kind === "worsening") return `up ${v.delta}d${v.pct != null ? ` (${Math.abs(v.pct)}%)` : ""} vs ~30 days earlier · aging faster than any other stage`;
  if (f.kind === "spike") return `jumped to ${v.cur}d, well above its recent ${v.mu}d average · worth a look today`;
  if (f.kind === "improving") return v.cleared ? `cleared out completely this period` : `down ${Math.abs(v.delta)}d${v.pct != null ? ` (${Math.abs(v.pct)}%)` : ""} vs ~30 days earlier · clearing faster`;
  return "No stages need attention this period · everything is holding steady";
}
let pendOpen = false;                                     // session-only; resets on refresh like the collapse state
function renderPendPanel(store) {
  const el = document.getElementById("pendPanel"); if (!el) return;
  el.classList.toggle("hidden", !pendOpen);
  if (!pendOpen) return;
  const pc = (store.pendingClose || []).filter(p => cohort === "all" || (p.types || []).includes(cohort));
  el.innerHTML = `<div class="row-h" style="margin-bottom:4px"><div><h3 style="font-size:13px">WENT LIVE, NOT CLOSED OUT</h3><p class="ch-sub">waiting for the stage move in HubSpot · longest wait first</p></div><button class="btn" id="pendClose">Close</button></div>`
    + (pc.length ? pc.map(p => `<div class="pend-row"><span class="pn" title="${p.name}">${p.name}</span><span class="pm">${p.stage}</span><span class="pm">went live ${fmtDay(p.live)}</span><span class="pm">${p.days}d waiting</span></div>`).join("")
                 : `<div style="color:var(--hint);padding:14px 0">No one is waiting on close-out.</div>`);
  const x = document.getElementById("pendClose"); if (x) x.addEventListener("click", () => { pendOpen = false; renderPendPanel(loadStore()); });
}
function renderInsights(findings) {
  const box = document.getElementById("stageInsights"); if (!box) return;
  const hasRows = findings.some(f => f.kind !== "none");
  box.innerHTML = (hasRows ? `<div class="ins-hdr"><span></span><span>Stage</span><span>What&#39;s happening</span></div>` : "")
    + findings.map(f => f.kind === "none"
    ? `<div class="ins-card flat"><span class="ins-dot flat"></span><span>${insightText(f)}</span></div>`
    : `<button type="button" class="ins-card" data-stage="${f.stage}"><span class="ins-dot ${f.severity}"></span><b title="${f.stage}">${f.stage}</b><span class="ins-txt">${insightText(f)}</span><span class="ins-go">chart it &#8594;</span></button>`).join("");
  box.querySelectorAll("button.ins-card").forEach(b =>
    b.addEventListener("click", () => { selectedStage = b.dataset.stage; render(loadStore()); }));
}

/* ---------- render ---------- */
function render(store) {
  const dash = document.getElementById("dashboard"), empty = document.getElementById("empty");
  if (currentView !== "dash") { dash.classList.add("hidden"); empty.classList.add("hidden"); if (!store.lastImport) return; }
  else if (!store.lastImport) { dash.classList.add("hidden"); empty.classList.remove("hidden"); return; }
  else { empty.classList.add("hidden"); dash.classList.remove("hidden"); }

  const bounds = dataDayBounds(store);
  if (bounds && (!viewRange.from || !viewRange.to)) {
    const lm = lastMonthRange(bounds);
    viewRange.from = viewRange.from || lm.from; viewRange.to = viewRange.to || lm.to;
    document.querySelectorAll("#tfPresets button").forEach(x => x.classList.toggle("on", x.dataset.tf === "lastm"));
  }
  syncRangeInputs();
  const [pFrom, pTo] = priorWindow();                     // equal-length window immediately before the selection
  const priorHasData = bounds && pTo >= bounds[0];         // suppress comparisons when the prior window predates the data

  const labels = Object.keys(CONFIG.typeLabels);
  const m3 = store.m3 || [];                             // daily rows {date,total,CAREpoint,e-Bridge}
  const bl = r => cohort === "all" ? r.total : (r[cohort] || 0);   // backlog value under the cohort filter
  const win = m3.filter(r => inDayRange(r.date));         // filtered window governs the chart
  const hasWin = win.length > 0;                          // a window with no data shows zeros — never the latest state
  const cur = hasWin ? win[win.length - 1] : { total: 0, "CAREpoint": 0, "e-Bridge": 0 };
  let prevRow = null; if (hasWin && priorHasData) for (const r of m3) { if (r.date <= pTo) prevRow = r; else break; }   // state at end of prior window
  const backlogDelta = prevRow ? bl(cur) - bl(prevRow) : null;

  // Comparisons adapt to the window: 7 days reads week-over-week, ~30 month-over-month, ~365 year-over-year.
  const winLen = Math.round((new Date(viewRange.to + "T00:00:00Z") - new Date(viewRange.from + "T00:00:00Z")) / MS_PER_DAY) + 1;
  const priorName = winLen === 7 ? "prior week" : (winLen >= 28 && winLen <= 31) ? "prior month"
    : (winLen >= 90 && winLen <= 92) ? "prior quarter" : (winLen >= 365 && winLen <= 366) ? "prior year" : "prior period";

  // go-lives: cohort-filtered daily counts -> bars bucketed to the window (day/week/month); compare = window total vs prior-window total
  const glBucket = winLen <= 45 ? "day" : winLen <= 200 ? "week" : "month";
  const glKey = d => glBucket === "day" ? d : glBucket === "month" ? d.slice(0, 7)
    : (() => { const dt = new Date(d + "T00:00:00Z"); return dstr(new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * MS_PER_DAY)); })();   // Monday of that week
  const glFmt = k => glBucket === "month" ? fmtMonth(k) : fmtDay(k);
  const m4c = m4Sel(store);
  const glBuckets = {}; let glWinTotal = 0, glPrevTotal = 0;
  Object.entries(m4c).forEach(([d, c]) => {
    if (inDayRange(d)) { const k = glKey(d); glBuckets[k] = (glBuckets[k] || 0) + c; glWinTotal += c; }
    else if (d >= pFrom && d <= pTo) glPrevTotal += c;
  });
  const goliveDelta = priorHasData ? glWinTotal - glPrevTotal : null;
  // Chart gets the FULL go-live history (bucketed + zero-filled) so panning can reach it; window math above is untouched.
  const glAll = {}; Object.entries(m4c).forEach(([d, c]) => { const k = glKey(d); glAll[k] = (glAll[k] || 0) + c; });
  const m4days = Object.keys(m4c).sort();
  if (m4days.length) {
    for (let d = new Date(m4days[0] + "T00:00:00Z"), glEnd = new Date(m4days[m4days.length - 1] + "T00:00:00Z"); d <= glEnd; d = addDay(d)) {
      const k = glKey(dstr(d)); if (!(k in glAll)) glAll[k] = 0;
    }
  }
  const glKeys = Object.keys(glAll).sort();

  const m2c = m2Sel(store);                              // monthly averages (chart line + legacy fallback)
  const m2cropKeys = Object.keys(m2c).filter(inRange).sort();
  const m2dc = m2dSel(store);                            // day-level {sum,n} -> exact record-weighted window averages
  let speedTo = null, speedPrevV = null;
  if (Object.keys(m2dc).length) {
    let s = 0, n = 0, ps = 0, pn = 0;
    Object.entries(m2dc).forEach(([d, v]) => {
      if (inDayRange(d)) { s += v.s; n += v.n; }
      else if (d >= pFrom && d <= pTo) { ps += v.s; pn += v.n; }
    });
    speedTo = n ? Math.round(s / n) : null;
    speedPrevV = pn ? Math.round(ps / pn) : null;
  } else {                                               // legacy store without day-level durations: month-bucket approximation
    speedTo = m2cropKeys.length ? Math.round(mean(m2cropKeys.map(k => m2c[k]))) : null;
    const m2prevKeys = Object.keys(m2c).filter(m => { const [y, mo] = m.split("-").map(Number); const last = new Date(Date.UTC(y, mo, 0)).getUTCDate(); return (m + "-01") <= pTo && (m + "-" + String(last).padStart(2, "0")) >= pFrom; }).sort();
    speedPrevV = m2prevKeys.length ? Math.round(mean(m2prevKeys.map(k => m2c[k]))) : null;
  }
  const speedDelta = (priorHasData && speedTo != null && speedPrevV != null) ? speedTo - speedPrevV : null;

  // KPIs — levels measured at the END of the selected period; deltas vs the end of the prior equal-length window
  const totalDelta = prevRow ? cur.total - prevRow.total : null;
  const stockFoot = hasWin ? `open at end of period · vs ${priorName}` : "no data in selected range";
  const kpis = [
    { label: "Open implementations (backlog)", icon: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>', val: cur.total, pill: pill(totalDelta, true), foot: stockFoot },
    { label: "CAREpoint open", icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/>', val: cur["CAREpoint"] || 0, pill: pill(prevRow ? (cur["CAREpoint"] || 0) - (prevRow["CAREpoint"] || 0) : null, true), foot: stockFoot },
    { label: "e-Bridge open", icon: '<path d="M4 7h16M4 12h16M4 17h10"/>', val: cur["e-Bridge"] || 0, pill: pill(prevRow ? (cur["e-Bridge"] || 0) - (prevRow["e-Bridge"] || 0) : null, true), foot: stockFoot },
    (() => {                                             // pending-close level at the window end (falls back to as-of-import for legacy stores)
      const pd = store.pendingDaily || null, pc = store.pendingClose || [];
      let curP = null, prevP = null, atLatest = true;
      if (pd && pd.length) {
        for (const p of pd) { if (p.date <= viewRange.to) curP = p; else break; }
        if (priorHasData) for (const p of pd) { if (p.date <= pTo) prevP = p; else break; }
        atLatest = !curP || curP.date === pd[pd.length - 1].date;
      }
      const val = curP ? curP.v : (pd && pd.length ? 0 : pc.length);   // window ends before the first live date -> truly 0; pc fallback is legacy-store only
      const delta = (curP && prevP) ? curP.v - prevP.v : null;
      const stale = pc.filter(p => p.days > 30).length, worst = pc.length ? pc[0].days : 0;
      return { label: "Went live, not closed out", icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>', val,
        pill: pill(delta, true),
        foot: atLatest ? (val ? (stale ? `${stale} waiting 30+ days · longest ${worst}d since go-live` : "none waiting long") : "no one waiting on close-out")
                       : `at end of period · vs ${priorName}` }; })(),
  ];
  document.getElementById("kpis").innerHTML = kpis.map((k, i) => `<div class="card kpi${i === 3 ? " kpi-click" : ""}" data-share="kpi-${i}"${i === 3 ? ' data-pend="1" role="button" tabindex="0" title="Click to see which implementations"' : ""}>
    <div class="kl">${k.label}<span class="ki"><svg class="ic" viewBox="0 0 24 24" style="width:17px;height:17px">${k.icon}</svg></span></div>
    <div class="kv">${typeof k.val === "number" ? k.val.toLocaleString() : k.val} ${k.pill}</div><div class="kfoot">${k.foot}</div></div>`).join("")
    + `<div class="kpi-note">Products overlap · an implementation can be both, counted once in the total</div>`;

  // backlog — daily line within window, under the cohort filter
  document.getElementById("backlogNow").textContent = bl(cur).toLocaleString() + (cohort === "all" ? "" : "");
  document.querySelector("#sec-backlog h3").textContent = "OPEN PIPELINE TREND" + cohortLabel();
  document.getElementById("backlogPill").innerHTML = backlogDelta != null ? pill(backlogDelta, true) + ` <span style="font-size:12px;color:var(--hint)">vs ${priorName} (ended ${fmtDay(prevRow.date)})</span>` : "";
  const wt = windowTrend(win.map(bl));
  const wtRange = `(${fmtDay(viewRange.from)} to ${fmtDay(viewRange.to)})`;   // explicit scope: the pill covers the SELECTED range, not the zoomed view
  document.getElementById("backlogTrend").innerHTML = !wt ? "" :
    wt.kind === "up" ? `<span class="pill bad" style="font-size:13px;padding:3px 10px">&#9650; Rising ${wtRange}</span>` :
    wt.kind === "down" ? `<span class="pill good" style="font-size:13px;padding:3px 10px">&#9660; Falling ${wtRange}</span>` :
    `<span class="pill flat" style="font-size:13px;padding:3px 10px">&#9644; Flat ${wtRange}</span>`;
  areaChart("backlogChart", m3.map(r => ({ m: r.date, v: bl(r) })), 220, fmtDay, viewRange);   // full history; selected range = initial viewport

  // go-lives — bars bucketed to the window + prior-period comparison
  document.querySelector("#sec-golive h3").textContent = "GO-LIVES" + cohortLabel();
  let estLine = "";
  if (Array.isArray(store.estUpcoming) && bounds) {
    const hEnd = dstr(new Date(new Date(bounds[1] + "T00:00:00Z").getTime() + 30 * MS_PER_DAY));
    const nEst = store.estUpcoming.filter(e => e.d > bounds[1] && e.d <= hEnd && (cohort === "all" || (e.types || []).includes(cohort))).length;
    if (nEst) estLine = ` · ${nEst} estimated to go live in the next 30 days`;
  }
  document.getElementById("goliveSub").textContent = `How many implementations went live · each bar is one ${glBucket}` + estLine;
  document.getElementById("goliveNow").textContent = glWinTotal.toLocaleString();
  document.getElementById("golivePill").innerHTML = goliveDelta != null ? pill(goliveDelta, false) + ` <span style="font-size:12px;color:var(--hint)">vs ${priorName}</span>` : "";
  barChart("goliveChart", glKeys.map(k => ({ m: k, v: glAll[k] })), glFmt, glBucket, viewRange);
  document.getElementById("goliveCap").textContent = glWinTotal
    ? `${glWinTotal} implementation${glWinTotal === 1 ? "" : "s"} went live in the selected period` + (goliveDelta != null ? ` · ${goliveDelta >= 0 ? goliveDelta + " more" : Math.abs(goliveDelta) + " fewer"} than the ${winLen} days before.` : ".")
    : "No go-lives in the selected period.";
  document.getElementById("breakdown").style.display = cohort === "all" ? "" : "none";
  const bdTot = cur.total || 1;
  document.getElementById("breakdown").innerHTML = [
    { l: "Total open", v: cur.total, c: "var(--ink)" }, { l: "CAREpoint", v: cur["CAREpoint"] || 0, c: CP }, { l: "e-Bridge", v: cur["e-Bridge"] || 0, c: EB },
  ].map(b => `<div class="bd"><div class="bd-n">${b.v.toLocaleString()}</div><div class="bd-l">${b.l}</div><div class="bar" style="background:${b.c};width:${Math.max(8, Math.round(b.v / bdTot * 100))}%"></div></div>`).join("");
  const flowEl = document.getElementById("flowCap");
  if (flowEl) {
    const stMap = (store.startedDaily || {})[cohort], clMap = (store.closedDaily || {})[cohort];
    if (stMap && clMap && hasWin) {
      const d0 = win[0].date, sumAfter = m => { let n = 0; for (const [d, c] of Object.entries(m)) if (d > d0 && inDayRange(d)) n += c; return n; };
      const started = sumAfter(stMap), closed = sumAfter(clMap);
      const net = bl(cur) - bl(win[0]);
      flowEl.textContent = `${started} started · ${closed} closed out · net ${net >= 0 ? "+" + net : net} since ${fmtDay(d0)}`;
    } else flowEl.textContent = "";
  }

  // speed to go-live (PO -> live/complete, by go-live month) — also native in HubSpot; here so the monthly story is one page
  if (speedTo != null) {
    document.querySelector("#sec-speed h3").textContent = "PO TO GO-LIVE" + cohortLabel();
    document.getElementById("speedNow").textContent = speedTo;
    document.getElementById("speedPill").innerHTML = speedDelta != null ? pill(speedDelta, true) + ` <span style="font-size:12px;color:var(--hint)">vs ${priorName}</span>` : "";
    let spN = 0;
    if (Object.keys(m2dc).length) {                      // full history; weekly buckets at minimum so single-go-live days don't read as trend
      const spBucket = glBucket === "day" ? "week" : glBucket;
      const spKey = d => spBucket === "month" ? d.slice(0, 7)
        : (() => { const dt = new Date(d + "T00:00:00Z"); return dstr(new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * MS_PER_DAY)); })();
      const spFmt = spBucket === "month" ? fmtMonth : fmtDay;
      const spB = {};
      Object.entries(m2dc).forEach(([d, v]) => { const k = spKey(d); (spB[k] ||= { s: 0, n: 0 }); spB[k].s += v.s; spB[k].n += v.n; if (inDayRange(d)) spN += v.n; });
      const spPts = Object.keys(spB).sort().map(k => ({ m: k, v: Math.round(spB[k].s / spB[k].n), n: spB[k].n }));
      areaChart("speedChart", spPts, 110, spFmt, viewRange, {
        tooltipLabel: c => ` ${c.parsed.y} days · avg of ${spPts[c.dataIndex] ? spPts[c.dataIndex].n : "?"} go-live${spPts[c.dataIndex] && spPts[c.dataIndex].n === 1 ? "" : "s"}`,
      });
      const spC = charts["speedChart"]; if (spC) { spC.options.plugins.lastValPrefix = "latest "; spC.update("none"); }
    } else areaChart("speedChart", Object.keys(m2c).sort().map(k => ({ m: k, v: m2c[k] })), 110, fmtMonth, viewRange);   // legacy store: monthly line
    document.getElementById("speedCap").textContent = `Go-lives in the selected period averaged ${speedTo} days from Purchase Order to Go-Live` + (spN ? ` across ${spN} go-lives` : "") +
      (speedDelta != null ? (speedDelta < 0 ? ` · ${Math.abs(speedDelta)} days faster than the ${priorName}.` : speedDelta > 0 ? ` · ${speedDelta} days slower than the ${priorName}.` : ` · unchanged from the ${priorName}.`) : ".");
  } else {
    destroy("speedChart");
    document.getElementById("speedNow").textContent = "—";
    document.getElementById("speedPill").innerHTML = "";
    document.getElementById("speedCap").textContent = "No completed implementations in the selected period.";
  }

  // stage feature — TradingView watchlist + DAILY price chart, reconstructed from stage entered/exited dates
  const sd = sdSel(store);                              // respects the cohort filter (All / CAREpoint / e-Bridge)
  document.querySelector("#sec-stage h3").textContent = "TIME IN STAGE" + cohortLabel();
  const sdDays = sd.days || [];
  // List values and badges read at the END of the selected window (not the newest data), so the list agrees with the chart.
  let sdEnd = -1; sdDays.forEach((d, i) => { if (!viewRange.to || d <= viewRange.to) sdEnd = i; });
  let sdStart = 0; if (viewRange.from) { sdStart = sdDays.findIndex(d => d >= viewRange.from); if (sdStart < 0) sdStart = sdDays.length; }
  function stageArr(s) { return (sd.series && sd.series[s]) || []; }
  function stageCur(s) { const a = stageArr(s); return sdEnd >= 0 && a[sdEnd] != null ? a[sdEnd] : null; }
  function stageTrend(s) {                            // end of window vs ~30 days earlier (clamped to the window); down = clearing (good)
    const a = stageArr(s); if (!a.length || sdEnd < 0 || sdStart > sdEnd) return { kind: "empty" };
    const cur = a[sdEnd];
    if (cur == null) return a.slice(sdStart, sdEnd + 1).some(v => v != null) ? { kind: "cleared" } : { kind: "empty" };
    const target = Math.max(sdStart, sdEnd - 30); let prev = null;
    for (let i = target; i >= sdStart; i--) if (a[i] != null) { prev = a[i]; break; }
    if (prev == null) for (let i = target + 1; i < sdEnd; i++) if (a[i] != null) { prev = a[i]; break; }
    if (prev == null) return { kind: "new" };
    const d = cur - prev, pct = prev ? d / prev * 100 : null;
    if (Math.abs(pct == null ? 0 : pct) < 10 && pct != null) return { kind: "flat", d, pct };
    if (pct == null && d === 0) return { kind: "flat", d, pct };
    return { kind: d > 0 ? "up" : "down", d, pct };
  }
  function trendBadge(t) {
    const pctTxt = t.pct == null ? null : Math.round(Math.abs(t.pct)) + "%";
    if (t.kind === "up") return `<span class="pill bad worse" title="up ${t.d}d vs ~30 days earlier">&#9650; ${pctTxt != null ? pctTxt : t.d + "d"}</span>`;
    if (t.kind === "down") return `<span class="pill good" title="down ${Math.abs(t.d)}d vs ~30 days earlier">&#9660; ${pctTxt != null ? pctTxt : Math.abs(t.d) + "d"}</span>`;
    if (t.kind === "cleared") return `<span class="pill good">&#9660; cleared</span>`;
    if (t.kind === "flat") return `<span class="pill flat">&#9644; flat</span>`;
    if (t.kind === "new") return `<span class="pill flat">new</span>`;
    return `<span class="pill flat">—</span>`;
  }
  const rows = CONFIG.pipelineStages.map(st => ({ st, cur: stageCur(st), open: sd.open[st] ?? 0, t: stageTrend(st) }))
    .sort((a, b) => (b.cur ?? -1) - (a.cur ?? -1) || b.open - a.open);

  if (!selectedStage || !CONFIG.pipelineStages.includes(selectedStage)) selectedStage = rows[0] ? rows[0].st : null;

  syncWlToggle();                                        // re-apply the collapse state on every render
  document.getElementById("stageList").innerHTML = rows.map(s =>
    `<div class="wl-row${s.st === selectedStage ? " sel" : ""}" data-stage="${s.st}" role="button" tabindex="0" aria-pressed="${s.st === selectedStage}">
      <span class="wnm" title="${s.st}">${s.st}</span>
      <span class="wcnt" title="open implementations sitting in this stage">${s.open || 0}</span>
      <span class="wlast">${s.cur != null ? s.cur + "d" : "—"}</span>${trendBadge(s.t)}</div>`).join("");
  document.querySelectorAll("#stageList .wl-row").forEach(el => {
    const pick = () => { selectedStage = el.dataset.stage; render(loadStore()); };
    el.addEventListener("click", pick);
    el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
  });

  const sel = rows.find(r => r.st === selectedStage) || rows[0];
  document.getElementById("cpName").textContent = sel ? sel.st : "—";
  document.getElementById("cpPrice").textContent = sel && sel.cur != null ? sel.cur + "d" : "—";
  document.getElementById("cpBadge").innerHTML = sel ? trendBadge(sel.t) : "";
  destroy("stageBig");
  if (sel && sdDays.length) {
    // Same baseline-chart implementation as OPEN PIPELINE TREND / PO TO GO-LIVE (areaChart), full daily history.
    const fullArr = stageArr(sel.st);
    document.getElementById("cpSub").textContent = `Daily detail · hover to read · ${MODLBL} + scroll to zoom · drag to pan · double-click to reset`;
    areaChart("stageBig", sdDays.map((d, i) => ({ m: d, v: fullArr[i] })), 300, fmtDay, viewRange, {
      tooltipLabel: c => c.parsed.y == null ? " no open work" : ` ${c.parsed.y} days`,
      onHover: (e, els) => { const c = charts["stageBig"]; if (!c) return; const pr = document.getElementById("cpPrice"), ro = document.getElementById("cpReadout");
        if (els && els.length) { const i = els[0].index, v = c.data.datasets[0].data[i], d = c.data.labels[i];
          pr.textContent = v == null ? "—" : v + "d"; ro.textContent = " · " + fmtDay(d) + (v == null ? " · no open work" : " · " + v + " days"); } },
    });
    const el = document.getElementById("stageBig");
    const syncLeave = el.onmouseleave;                    // compose: crosshair-sync clear + readout reset
    el.onmouseleave = e => { if (syncLeave) syncLeave(e);
      document.getElementById("cpPrice").textContent = sel.cur != null ? sel.cur + "d" : "—"; document.getElementById("cpReadout").textContent = ""; };
    renderInsights(stageInsights(sd, sdStart, sdEnd, Object.fromEntries(rows.map(r => [r.st, r.t]))));
  } else { const box = document.getElementById("stageInsights"); if (box) box.innerHTML = ""; }

  const up = rows.filter(s => s.t.kind === "up").length;
  const down = rows.filter(s => s.t.kind === "down" || s.t.kind === "cleared").length;
  const flat = rows.filter(s => s.t.kind === "flat").length;
  document.getElementById("stageSummary").innerHTML = sdDays.length
    ? `<span><b style="color:var(--bad)">${up}</b> rising</span><span><b style="color:var(--good)">${down}</b> falling</span><span><b>${flat}</b> flat</span>`
    : `<span>This needs the stage date columns · included when you export with "All properties"</span>`;

  const dataThrough = bounds ? bounds[1] : null;
  const importedOn = store.lastImport.when ? store.lastImport.when.slice(0, 10) : null;
  document.getElementById("subtitle").textContent = `${store.lastImport.records.toLocaleString()} implementations · ${fmtDay(viewRange.from)} to ${fmtDay(viewRange.to)}`
    + (dataThrough ? ` · data through ${fmtDay(dataThrough)}` : "") + (importedOn ? ` · imported ${fmtDay(importedOn)}` : "")
    + (store.demo ? " · SAMPLE DATA" : "");
  const dB = document.getElementById("demoBanner"); if (dB) dB.classList.toggle("hidden", !store.demo);
  renderPendPanel(store);
  const sW = document.getElementById("stageWarn");
  if (sW) { const u = store.unknownStages || [];
    sW.classList.toggle("hidden", !u.length);
    if (u.length) sW.textContent = u.map(x => `Unrecognized stage "${x.name}" · ${x.count} implementation${x.count === 1 ? "" : "s"} not shown in Time in Stage`).join(" · ") + " · report this so the stage can be added"; }
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
  vpUserSet = true;
  if (tf === "lastm") { const lm = lastMonthRange(b); viewRange.from = lm.from; viewRange.to = lm.to; }
  else {
    viewRange.to = b[1];
    if (tf === "all") viewRange.from = b[0];
    else {
      const n = parseInt(tf, 10), t = new Date(b[1] + "T00:00:00Z");
      const f = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - n, t.getUTCDate() + 1));
      viewRange.from = dstr(f) < b[0] ? b[0] : dstr(f);
    }
  }
  try { localStorage.setItem(TF_KEY, tf); } catch (e) { }
  document.querySelectorAll("#tfPresets button").forEach(x => x.classList.toggle("on", x.dataset.tf === tf));
  render(store);
}

/* ---------- theme ---------- */
function applyTheme(t) { document.documentElement.setAttribute("data-theme", t); localStorage.setItem(THEME_KEY, t);
  document.getElementById("themeIc").innerHTML = t === "dark"
    ? '<path d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z"/>'
    : '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>'; }

/* ---------- share ---------- */
const SHARE_CARDS = [
  { id: "kpi-0", label: "Open implementations (backlog) · number" },
  { id: "kpi-1", label: "CAREpoint open · number" },
  { id: "kpi-2", label: "e-Bridge open · number" },
  { id: "kpi-3", label: "Went live, not closed out · number" },
  { id: "sec-backlog", label: "Open pipeline trend (backlog)" },
  { id: "sec-stage", label: "Time in stage" },
  { id: "sec-speed", label: "PO to go-live" },
  { id: "sec-golive", label: "Go-lives" },
];
function shareEl(id) { return id.startsWith("kpi-") ? document.querySelector(`[data-share="${id}"]`) : document.getElementById(id); }
function shareSelection() { return [...document.querySelectorAll("#sharePick input:checked")].map(c => c.value); }

function sharePNG() {
  const sel = shareSelection();
  if (!sel.length) { toast("Pick at least one card to share.", true); return; }
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const bg = dark ? "#0e1320" : "#eef1f5";
  if (sel.length === SHARE_CARDS.length) {
    html2canvas(document.getElementById("dashboard"), { backgroundColor: bg, scale: 2, useCORS: true }).then(cv => {
      const a = document.createElement("a"); a.href = stampCanvas(cv, bg).toDataURL("image/png"); a.download = "implementation-trends.png"; a.click();
    }).catch(() => toast("PNG export failed.", true));
    return;
  }
  // Selected cards only: capture each, then stack them onto one canvas.
  const els = sel.map(shareEl).filter(Boolean);
  Promise.all(els.map(el => html2canvas(el, { backgroundColor: bg, scale: 2, useCORS: true }))).then(cvs => {
    const PAD = 32, GAP = 24;
    const w = Math.max(...cvs.map(c => c.width)) + PAD * 2;
    const h = cvs.reduce((s, c) => s + c.height, 0) + GAP * (cvs.length - 1) + PAD * 2;
    const out = document.createElement("canvas"); out.width = w; out.height = h;
    const ctx = out.getContext("2d"); ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    let y = PAD; for (const c of cvs) { ctx.drawImage(c, PAD, y); y += c.height + GAP; }
    const name = sel.length === 1
      ? SHARE_CARDS.find(c => c.id === sel[0]).label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      : "implementation-trends-selected";
    const a = document.createElement("a"); a.href = stampCanvas(out, bg).toDataURL("image/png"); a.download = name + ".png"; a.click();
  }).catch(() => toast("PNG export failed.", true));
}
function stampCanvas(cv, bg) {                            // exports carry their own context: period, filter, freshness, demo flag
  const dark = bg === "#0e1320";
  const line = document.getElementById("subtitle").textContent + (cohort === "all" ? "" : " · " + cohort + " only");
  const out = document.createElement("canvas"); out.width = cv.width; out.height = cv.height + 56;
  const ctx = out.getContext("2d");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(cv, 0, 0);
  ctx.font = "22px -apple-system, Segoe UI, sans-serif";
  ctx.fillStyle = dark ? "#8b97a8" : "#77808f";
  ctx.fillText(line, 24, cv.height + 36);
  return out;
}

function sharePDF() {
  const sel = shareSelection();
  if (!sel.length) { toast("Pick at least one card to share.", true); return; }
  if (sel.length === SHARE_CARDS.length) { window.print(); return; }
  // Selected cards only: hide the rest while the print dialog is open.
  document.body.classList.add("share-partial");
  SHARE_CARDS.forEach(c => { const el = shareEl(c.id); if (el && !sel.includes(c.id)) el.classList.add("share-hide"); });
  const cleanup = () => {
    document.body.classList.remove("share-partial");
    document.querySelectorAll(".share-hide").forEach(e => e.classList.remove("share-hide"));
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.print();
  setTimeout(cleanup, 500);   // fallback for browsers that skip afterprint
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
  const hist = document.getElementById("history"), howto = document.getElementById("howto");
  hist.classList.toggle("hidden", v !== "history");
  howto.classList.toggle("hidden", v !== "howto");
  document.querySelectorAll(".nav a").forEach(x =>
    x.classList.toggle("on", v === "dash" ? x.dataset.goto === "kpis" : x.dataset.view === v));
  if (v === "history") renderHistory();
  if (v !== "history") document.getElementById("histPreview").classList.add("hidden");
  render(loadStore());
}
function renderHistory() {
  const arr = loadImports();
  document.getElementById("histList").innerHTML = arr.length ? arr.map((e, i) => `
    <div class="hist-row">
      <div class="hf" title="${e.fileName}">${e.fileName}${i === 0 ? ' <span class="pill flat" style="margin-left:6px">latest</span>' : ""}${e.older ? ' <span class="pill flat" style="margin-left:6px">older file · kept the newer data</span>' : ""}${/\(demo\)/.test(e.fileName) ? ' <span class="pill flat" style="margin-left:6px">sample data · not an import</span>' : ""}${i > 0 && arr.slice(0, i).some(x => x.snapMonth === e.snapMonth) ? ' <span class="pill flat" style="margin-left:6px">replaced</span>' : ""}</div>
      <div class="hm hdate">${fmtDateTime(e.importedAt)}</div>
      <div class="hm">counts as ${fmtMonth(e.snapMonth)} · ${e.records.toLocaleString()} implementations</div>
      <div class="ha">
        <button class="btn" data-hview="${i}" ${e.csv ? "" : "disabled title='File removed to free space · details kept'"}>View</button>
        <button class="btn" data-hexp="${i}" ${e.csv ? "" : "disabled"}>Export</button>
        <button class="btn" data-hreimp="${i}" ${e.csv ? "" : "disabled"} title="Rebuild the dashboard from this file">Re-import</button>
      </div>
    </div>`).join("")
    : `<div style="color:var(--hint);padding:26px 0;text-align:center">No imports yet. Import a HubSpot export from the Dashboard and it will be logged here.</div>`;
  document.querySelectorAll("[data-hview]").forEach(b => b.addEventListener("click", () => previewImport(+b.dataset.hview)));
  document.querySelectorAll("[data-hexp]").forEach(b => b.addEventListener("click", () => exportImport(+b.dataset.hexp)));
  document.querySelectorAll("[data-hreimp]").forEach(b => b.addEventListener("click", () => {
    const e = loadImports()[+b.dataset.hreimp]; if (!e || !e.csv) return;
    if (!confirm(`Re-import ${e.fileName}? The dashboard rebuilds from that file.`)) return;
    handleFile(new File([e.csv], e.fileName.replace(" (demo)", ""), { type: "text/csv" }));
  }));
}
function previewImport(i) {
  const e = loadImports()[i]; if (!e || !e.csv) return;
  const rows = parseCSV(e.csv), cols = rows.length ? Object.keys(rows[0]) : [];
  const shown = rows.slice(0, 50);
  document.getElementById("hpTitle").textContent = e.fileName;
  document.getElementById("hpSub").textContent = `Imported ${fmtDateTime(e.importedAt)} · counts as ${fmtMonth(e.snapMonth)} · showing ${shown.length} of ${rows.length.toLocaleString()} rows`;
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
function noteShow(msg, kind) { const n = document.getElementById("importNote"); if (!n) return;
  n.className = "inote" + (kind === "err" ? " err" : ""); document.getElementById("importNoteMsg").innerHTML = msg; }
function noteHide() { const n = document.getElementById("importNote"); if (n) n.className = "inote hidden"; }
function handleFile(file) { const r = new FileReader(); r.onload = e => {
  try { const records = normalize(parseCSV(e.target.result)); if (!records.length) throw new Error("No records found.");
    const prev = loadStore().lastImport;
    if (prev && prev.records && Math.abs(records.length - prev.records) / prev.records > 0.2) {
      if (!confirm(`This file has ${records.length} implementations; the last import had ${prev.records}. A HubSpot filter may have been left on. Import anyway?`)) return;
    }
    const nameM = (file.name || "").match(CONFIG.filenameDateRegex);
    const snap = nameM ? `${nameM[1]}-${nameM[2]}` : monthKey(new Date());
    const store = applyImport(loadStore(), records, snap); saveStore(store);
    logImport({ fileName: file.name, importedAt: new Date().toISOString(), snapMonth: snap, records: records.length, older: !!store.lastImport.older, csv: e.target.result });
    try { localStorage.setItem(TF_KEY, "lastm"); } catch (e2) { }
    showView("dash");
    const diff = prev && prev.records ? records.length - prev.records : null;
    toast(store.lastImport.older
      ? `Saved the ${fmtMonth(snap)} stage snapshot. Kept the newer trends (${fmtMonth(store.asOfMonth)}).`
      : `Imported ${records.length} implementations for ${fmtMonth(snap)}` + (diff != null ? ` · ${diff >= 0 ? "+" + diff : diff} vs last import` : ""));
    noteHide();
    const nags = [];
    if (!nameM) nags.push(`No date in the file name, so this counts as ${fmtMonth(snap)} · rename to implementations_YYYY-MM-DD.csv to control the month`);
    const lb = localStorage.getItem("impl_trends_backup_at");
    if (prev && (!lb || lb < (prev.when || ""))) nags.push(`Last backup: ${lb ? fmtDay(lb.slice(0, 10)) : "never"} · this browser holds the only copy of your history <button class="btn" id="noteBackup" style="margin-left:8px">Back up now</button>`);
    if (nags.length) noteShow(nags.join("<br>"));
  } catch (err) {
    const missing = /Missing column/.test(err.message || "");
    noteShow((missing
      ? "That file is missing the Implementation columns, so it may be the wrong HubSpot export. "
      : "The import failed: " + (err.message || err) + ". ")
      + "Your existing data is untouched · How to Use has the export steps", "err");
  } };
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
  document.addEventListener("click", e => {
    const mv = e.target && e.target.closest ? e.target.closest(".mini-nav [data-view]") : null;
    if (mv) showView(mv.dataset.view);
    if (e.target && e.target.id === "importNoteX") noteHide();
    if (e.target && e.target.id === "noteBackup") document.getElementById("backup").click();
    const pk = e.target && e.target.closest ? e.target.closest('[data-pend="1"]') : null;
    if (pk) { pendOpen = !pendOpen; renderPendPanel(loadStore()); if (pendOpen) document.getElementById("pendPanel").scrollIntoView({ behavior: "smooth", block: "nearest" }); }
  });
  document.addEventListener("keydown", e => {
    if ((e.key === "Enter" || e.key === " ") && e.target && e.target.matches && e.target.matches('[data-pend="1"]')) { e.preventDefault(); pendOpen = !pendOpen; renderPendPanel(loadStore()); }
  });

  // Day-level date range inputs, populated before the first import.
  syncRangeInputs();
  const file = document.getElementById("file"), pick = () => file.click();
  document.getElementById("importBtn").addEventListener("click", pick);
  document.getElementById("importBtn2").addEventListener("click", pick);
  file.addEventListener("change", e => { if (e.target.files[0]) handleFile(e.target.files[0]); file.value = ""; });
  const main = document.querySelector(".main");
  ["dragover", "dragenter"].forEach(ev => main.addEventListener(ev, e => e.preventDefault()));
  main.addEventListener("drop", e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (!f) return;
    const n = (f.name || "").toLowerCase();
    if (n.endsWith(".json")) { noteShow("That looks like a backup file · use the Data menu (⋯) → Restore backup for .json files", "err"); return; }
    if (!n.endsWith(".csv")) { noteShow("That file is not a CSV · in HubSpot pick the CSV export format, not Excel", "err"); return; }
    handleFile(f); });

  document.getElementById("themeBtn").addEventListener("click", () => { applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"); render(loadStore()); });
  document.getElementById("pngBtn").addEventListener("click", () => { closeMenus(); sharePNG(); });
  document.getElementById("pdfBtn").addEventListener("click", () => { closeMenus(); sharePDF(); });

  // Share picker: choose which cards to include; "Full dashboard" mirrors all-checked.
  document.getElementById("sharePick").innerHTML = SHARE_CARDS.map(c =>
    `<label class="share-row"><input type="checkbox" value="${c.id}" checked> ${c.label}</label>`).join("");
  const shareAll = document.getElementById("shareAll");
  const shareBoxes = [...document.querySelectorAll("#sharePick input")];
  shareAll.addEventListener("change", () => shareBoxes.forEach(b => b.checked = shareAll.checked));
  shareBoxes.forEach(b => b.addEventListener("change", () => shareAll.checked = shareBoxes.every(x => x.checked)));

  document.getElementById("reset").addEventListener("click", () => { closeMenus(); if (confirm("Reset all data? This clears the stored history and import log in this browser and can't be undone. Back up first if unsure.")) { localStorage.removeItem(STORE_KEY); localStorage.removeItem(IMPORTS_KEY); localStorage.setItem("impl_trends_demo_off", "1"); location.reload(); } });
  document.getElementById("backup").addEventListener("click", () => { closeMenus();
    const payload = { v: 2, savedAt: new Date().toISOString(), store: loadStore(), imports: loadImports() };
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "implementation-trends-history.json"; a.click();
    try { localStorage.setItem("impl_trends_backup_at", payload.savedAt); } catch (e) { }
    noteHide(); });
  const hf = document.getElementById("histFile");
  document.getElementById("restore").addEventListener("click", () => { closeMenus(); hf.click(); });
  hf.addEventListener("change", e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader();
    r.onload = ev => { try {
      const j = JSON.parse(ev.target.result);
      const s = (j && j.v === 2 && j.store) ? j.store : j;                     // v2 wrapper or legacy raw store
      if (!s || typeof s !== "object" || Array.isArray(s) || !("m1" in s) || !("lastImport" in s)) { toast("Not a valid history file.", true); return; }
      try { const cur = localStorage.getItem(STORE_KEY); if (cur) localStorage.setItem("impl_trends_prev_store", cur); } catch (e2) { }
      saveStore(s);
      if (j && j.v === 2 && Array.isArray(j.imports)) saveImports(j.imports);
      viewRange = { from: null, to: null }; render(s); toast("History restored.");
    } catch (err) { toast(err && err.name === "QuotaExceededError" ? "That backup is too large for this browser's storage." : "Not a valid history file.", true); } }; r.readAsText(f); hf.value = ""; });

  ["fromDate", "toDate"].forEach(id =>
    document.getElementById(id).addEventListener("change", () => { const r = rangeFromInputs(); if (!r) return; vpUserSet = true; viewRange.from = r.from; viewRange.to = r.to; try { localStorage.setItem(TF_KEY, "custom:" + r.from + ":" + r.to); } catch (e) { } document.querySelectorAll("#tfPresets button").forEach(x => x.classList.remove("on")); render(loadStore()); }));
  document.querySelectorAll("#tfPresets button").forEach(b => b.addEventListener("click", () => setTF(b.dataset.tf)));
  document.getElementById("todayBtn").addEventListener("click", () => {
    const n = new Date(); let today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
    const bT = dataDayBounds(loadStore()); if (bT && today > bT[1]) today = bT[1];   // never label a range past the data
    vpUserSet = true;
    viewRange.to = today; if (viewRange.from && viewRange.from > today) viewRange.from = today;
    document.querySelectorAll("#tfPresets button").forEach(x => x.classList.remove("on"));
    render(loadStore());
  });
  document.querySelectorAll("#cohortSel button").forEach(b => b.addEventListener("click", () => {
    cohort = b.dataset.c;
    document.querySelectorAll("#cohortSel button").forEach(x => x.classList.toggle("on", x === b));
    render(loadStore());
  }));

  document.querySelectorAll(".nav a").forEach(a => {
    const go = () => {
      document.querySelectorAll(".nav a").forEach(x => x.classList.remove("on")); a.classList.add("on");
      if (a.dataset.view) { showView(a.dataset.view); return; }
      if (currentView !== "dash") showView("dash");
      const el = document.getElementById(a.dataset.goto); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    a.addEventListener("click", go);
    a.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });   // href-less anchors don't activate natively
  });
  document.getElementById("histBack").addEventListener("click", () => showView("dash"));
  document.getElementById("howtoBack").addEventListener("click", () => showView("dash"));

  // Collapsible stage selector (TradingView watchlist behavior) — chart reflows to full card width.
  // Chart.js's ResizeObserver tracks the animated column; one final resize lands after the transition.
  document.getElementById("wlToggle").addEventListener("click", () => {
    wlCollapsed = !wlCollapsed;
    syncWlToggle();
    setTimeout(() => { const c = charts["stageBig"]; if (c) { c.resize(); tvRebase(c); } }, 320);
  });
  document.getElementById("hpClose").addEventListener("click", () => document.getElementById("histPreview").classList.add("hidden"));
  document.getElementById("hpExport").addEventListener("click", () => { const i = +document.getElementById("histPreview").dataset.idx; exportImport(i); });

  const demoBtn = document.getElementById("demoBtn");
  if (demoBtn) demoBtn.addEventListener("click", () => { localStorage.removeItem("impl_trends_demo_off"); loadDemo(); });

  let s0 = loadStore();
  // Self-heal stores written by older app versions: replay the retained Import-history files in snapshot order.
  // Guarded by a fingerprint (store's own lastImport must match a history entry) so a restored backup is never
  // clobbered by unrelated files sitting in this browser's history; unmatched stores just use the legacy fallbacks.
  if (s0.lastImport && (!s0.pendingDaily || !s0.m2d)) {
    const imps = loadImports().filter(e => e.csv);
    const matches = imps.some(e => e.snapMonth === s0.lastImport.month && e.records === s0.lastImport.records);
    if (imps.length && matches) { try {
      const wasDemo = !!s0.demo;
      let rebuilt = blankStore();
      [...imps].sort((a, b) => (a.snapMonth || "").localeCompare(b.snapMonth || ""))
        .forEach(e => { rebuilt = applyImport(rebuilt, normalize(parseCSV(e.csv)), e.snapMonth); });
      rebuilt.demo = wasDemo;
      s0 = rebuilt; saveStore(s0);
    } catch (e) { } }
  }
  if (!s0.lastImport) render(s0);                         // no data: show the guided empty state (Load sample is a button there)
  else {
    const saved = localStorage.getItem(TF_KEY), b = dataDayBounds(s0);
    if (saved && b && saved.startsWith("custom:")) {
      const [, f, t] = saved.split(":");
      if (f >= b[0] && t <= b[1]) { vpUserSet = true; viewRange.from = f; viewRange.to = t; }
      render(s0);
    } else if (saved && b) setTF(saved);
    else render(s0);
  }
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
