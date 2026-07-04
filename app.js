// Implementation Health — V1 application (presentation + adapter).
// Renders whatever the engine returns. It performs NO analytical calculation:
// all metrics/verdicts/ranking come from engine.js; all tunables from config.js.
import { GD_CONFIG } from './config.js';
import { buildDashboard, DAY } from './engine.js';

const STORE_KEY = 'impl_health_v1';        // last import's engine snapshot (for trend memory)
const THEME_KEY = 'impl_health_theme';
const STAGE_COLS = [...GD_CONFIG.stages, GD_CONFIG.terminal];

// ---------- CSV parsing (handles quoted "" like the reference adapter) ----------
function parseCSV(txt) {
  txt = txt.replace(/^﻿/, '');
  const lines = []; let cur = '', row = [], q = false;
  for (let i = 0; i < txt.length; i++) {
    const ch = txt[i];
    if (q) { if (ch === '"') { if (txt[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); lines.push(row); row = []; cur = ''; }
    else if (ch === '\r') { } else cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); lines.push(row); }
  if (!lines.length) return [];
  const head = lines[0];
  return lines.slice(1).filter(r => r.length === head.length).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const pd = s => { if (!s || !String(s).trim()) return null; const d = new Date(String(s).trim()); return isNaN(d) ? null : d; };

// ---------- adapter: HubSpot CSV rows -> normalized engine records ----------
function toRecords(rows) {
  return rows.map(r => {
    const events = {};
    for (const s of STAGE_COLS) {
      const en = pd(r[`Date entered "${s} (Implementation Pipeline)"`]);
      const ex = pd(r[`Date exited "${s} (Implementation Pipeline)"`]);
      if (en || ex) events[s] = { enter: en, exit: ex };
    }
    const cs = r['Implementation pipeline stage'] || '';
    if (cs && !events[cs]) events[cs] = { enter: pd(r['Date entered current stage']), exit: null };
    const t = r['Implementation Type'] || '';
    return {
      id: r['Record ID'], name: r['Implementation Name'] || r['Record ID'],
      product: t.includes(';') ? 'Both' : t, currentStage: cs, events,
      poDate: pd(r['PO Date']), liveDate: pd(r['Implementation Live/Complete']),
    };
  });
}
// snapshot "as of" date: filename date -> latest date in data -> today
function snapshotDate(records, filename) {
  const m = (filename || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  let max = 0;
  for (const r of records) for (const s in r.events) { const e = r.events[s]; for (const k of ['enter', 'exit']) if (e[k] && e[k].getTime() > max) max = e[k].getTime(); }
  return max ? new Date(max) : new Date();
}
const productMatch = (rec, filt) => filt === 'all' || rec.product === filt || rec.product === 'Both';

// ---------- state ----------
let RAW = [];               // normalized records of the current import
let SNAP = null;            // snapshot Date
let FILTER = 'all';
let PREV = null;            // the PREVIOUS import's snapshot (stable this session; trend baseline)
const loadPrev = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; } };
const savePrev = snap => localStorage.setItem(STORE_KEY, JSON.stringify(snap));

// ---------- presentation maps (wording/colors live here, not the engine) ----------
const LABEL = { aging: 'Aging', building: 'Backlog building', watch: 'Watch', stalled: 'Stalled', clearing: 'Clearing', steady: 'Steady', 'no-history': 'Not enough history' };
const SEV = { aging: 'sev-bad', building: 'sev-warn', watch: 'sev-warn', stalled: 'sev-warn', clearing: 'sev-good', steady: 'sev-ok', 'no-history': 'sev-mute' };
const INTAKE = { 'keeping-pace': 'keeping pace', behind: 'falling behind', 'catching-up': 'catching up' };
const SPEED = { faster: 'faster', slower: 'slower', 'about-the-same': 'about the same', 'n/a': 'no prior data' };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = d => d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—';

// ---------- render ----------
function render() {
  const app = document.getElementById('app');
  if (!RAW.length) { app.innerHTML = emptyState(); wireImport(); return; }
  const recs = RAW.filter(r => productMatch(r, FILTER));
  const now = SNAP, periodStart = new Date(now.getTime() - GD_CONFIG.thresholds.windowDays * DAY);
  const prev = FILTER === 'all' ? PREV : null;   // trend memory (prior import) only on the all-products view
  const db = buildDashboard(recs, GD_CONFIG, now, periodStart, prev);
  const v = db.view; v.execBand.snapshotDate = fmtDate(now);
  app.innerHTML = `
    ${topBar()}
    ${execBand(v.execBand)}
    ${notices(v.notices)}
    ${focusList(v)}
    ${allStages(v.tableRows)}
    ${drillHost()}`;
  wireImport(); wireFilter(); wireDrill(db);
}

function execBand(e) {
  const drags = e.topDrags.map(t => esc(t.stage)).join(', ') || 'none';
  const delta = e.openDelta == null ? '' : ` <span class="delta">(${e.openDelta >= 0 ? '+' : ''}${e.openDelta})</span>`;
  const wait = e.totalExcess === 0 ? 'No overdue wait right now.'
    : `Most of the overdue wait (<b>${e.concentrationPct}%</b> of ${e.totalExcess} overdue-days${e.prevExcess != null ? `, was ${e.prevExcess}` : ''}) sits in: <b>${drags}</b>.`;
  const speed = e.medLead == null ? '' : ` · ${e.goLives} live, median ${e.medLead}d (${SPEED[e.speedState]})`;
  return `<section class="exec">
    <div class="exec-date">Snapshot through ${esc(e.snapshotDate)}</div>
    <div class="exec-line">Backlog <b>${e.open} open</b>${delta}</div>
    <div class="exec-line">${wait}</div>
    <div class="exec-line muted">Intake ${INTAKE[e.intakeState]} (${e.arrivals} in / ${e.departs} out, ${GD_CONFIG.thresholds.windowDays}d)${speed}${e.systemic ? ` · <b>systemic: ${esc(e.systemic)}</b>` : ''}</div>
  </section>`;
}
function notices(n) {
  if (!n.length) return '';
  return `<section class="notices">${n.map(f => `<div class="notice">⚠︎ ${esc(f.stage ? f.stage + ': ' : '')}${esc(f.msg)}</div>`).join('')}</section>`;
}
function focusList(v) {
  if (!v.focusRows.length) return `<section class="focus"><h2>Focus</h2><p class="muted">Nothing is overdue. No stage needs attention right now.</p></section>`;
  const rows = v.focusRows.map(r => `
    <button class="frow" data-stage="${esc(r.stage)}">
      <span class="fx">${r.excess}<small>overdue-days</small></span>
      <span class="fstage">${esc(r.stage)} <span class="tag ${r.owner}">${r.owner === 'customer' ? 'customer-blocked' : 'team-owned'}</span></span>
      <span class="fdet">${r.countPastNormal} past the usual ~${r.normal ?? '–'}d · oldest ${r.oldest}d</span>
      <span class="fgo">view ${r.countPastNormal} ›</span>
    </button>`).join('');
  const act = v.actFirst.length ? `<div class="actfirst"><b>Act first (your team owns these):</b> ${v.actFirst.map(esc).join(', ')}</div>`
    : `<div class="actfirst muted">Top drags are customer-blocked — nudge the customer.</div>`;
  const fill = v.buildingRows.length ? `<div class="filling muted"><b>Also filling</b> (capacity, not stuck): ${v.buildingRows.map(b => esc(b.stage) + ' +' + b.net).join(', ')}</div>` : '';
  return `<section class="focus"><h2>Focus · worst first</h2>${rows}${act}${fill}</section>`;
}
function allStages(rows) {
  const body = rows.map(r => `<tr>
    <td class="num">${r.order}</td><td>${esc(r.stage)}</td>
    <td class="num">${r.wip}</td><td class="num">${r.normal ?? '–'}</td>
    <td class="num">${r.oldest}</td><td class="num">${r.excess}</td><td class="num">${r.net > 0 ? '+' + r.net : r.net}</td>
    <td><span class="badge ${SEV[r.key]}">${LABEL[r.key]}</span></td></tr>`).join('');
  return `<section class="table"><h2>All stages · pipeline order</h2>
    <div class="tscroll"><table><thead><tr>
    <th class="num">#</th><th>Stage</th><th class="num">Open</th><th class="num">Normal</th>
    <th class="num">Oldest</th><th class="num">Overdue-days</th><th class="num">Net</th><th>Verdict</th>
    </tr></thead><tbody>${body}</tbody></table></div></section>`;
}
const drillHost = () => `<div id="drill" class="drill" hidden></div>`;

function wireDrill(db) {
  const host = document.getElementById('drill');
  document.querySelectorAll('.frow').forEach(btn => btn.onclick = () => {
    const st = btn.dataset.stage;
    const ev = db.evals.find(e => e.stage === st);
    const items = (ev && ev.items) || [];
    host.hidden = false;
    host.innerHTML = `<div class="drill-head"><b>${esc(st)}</b> · ${items.length} waiting, oldest first
      <button id="drillclose">close ✕</button></div>
      <table class="drilltbl"><thead><tr><th>Implementation</th><th>Product</th><th class="num">Days in stage</th></tr></thead>
      <tbody>${items.map(i => `<tr><td>${esc(i.name)}</td><td>${esc(i.product)}</td><td class="num">${i.age}</td></tr>`).join('')}</tbody></table>`;
    document.getElementById('drillclose').onclick = () => { host.hidden = true; };
    host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

// ---------- chrome ----------
function topBar() {
  return `<header class="top">
    <div class="brand"><b>Implementation Health</b><span class="tagline">Identify bottlenecks · prioritize attention · report performance</span></div>
    <div class="controls">
      <div class="seg" id="filter">
        ${['all', 'CAREpoint', 'e-Bridge'].map(f => `<button class="${FILTER === f ? 'on' : ''}" data-f="${f}">${f === 'all' ? 'All' : f}</button>`).join('')}
      </div>
      <label class="btn">Import CSV<input id="file" type="file" accept=".csv" hidden></label>
      <button class="btn ghost" id="theme">◐</button>
    </div>
  </header>`;
}
function emptyState() {
  return `${topBar()}
    <section class="empty">
      <h1>Import a HubSpot export to begin</h1>
      <p class="muted">Drop your monthly "All Implementations" CSV here, or use Import CSV. Everything stays in your browser.</p>
      <button class="btn" id="demo">Load sample data</button>
    </section>`;
}

// ---------- import wiring ----------
function ingest(text, filename) {
  const rows = parseCSV(text);
  const recs = toRecords(rows);
  if (!recs.length || !recs.some(r => r.currentStage)) { alert('That file has no implementation records. Your existing view is unchanged.'); return; }
  // data-quality confirm: big swing vs the last import
  const prev = loadPrev();
  if (prev && prev.recordCount && Math.abs(recs.length - prev.recordCount) / prev.recordCount > GD_CONFIG.thresholds.countSwing) {
    if (!confirm(`This import has ${recs.length} records vs ${prev.recordCount} last time (>${Math.round(GD_CONFIG.thresholds.countSwing * 100)}% change). A HubSpot filter may have been left on. Import anyway?`)) return;
  }
  RAW = recs; SNAP = snapshotDate(recs, filename); FILTER = 'all';
  PREV = prev;                 // this session's trend baseline = the PRIOR import (before we overwrite storage)
  // persist this import's engine snapshot as the baseline for the NEXT import
  const now = SNAP, periodStart = new Date(now.getTime() - GD_CONFIG.thresholds.windowDays * DAY);
  const db = buildDashboard(recs, GD_CONFIG, now, periodStart, prev);
  savePrev(db.snapshot);
  render();
}
function wireImport() {
  const file = document.getElementById('file');
  if (file) file.onchange = e => { const f = e.target.files[0]; if (f) f.text().then(t => ingest(t, f.name)); };
  const demo = document.getElementById('demo');
  if (demo) demo.onclick = () => fetch('sample-data.csv').then(r => r.text()).then(t => ingest(t, 'sample-data_2026-07-01.csv'));
  const theme = document.getElementById('theme');
  if (theme) theme.onclick = toggleTheme;
  const app = document.getElementById('app');
  app.ondragover = e => { e.preventDefault(); app.classList.add('drag'); };
  app.ondragleave = () => app.classList.remove('drag');
  app.ondrop = e => { e.preventDefault(); app.classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) f.text().then(t => ingest(t, f.name)); };
}
function wireFilter() {
  const seg = document.getElementById('filter');
  if (seg) seg.querySelectorAll('button').forEach(b => b.onclick = () => { FILTER = b.dataset.f; render(); });
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', cur); localStorage.setItem(THEME_KEY, cur);
}

// ---------- boot ----------
const savedTheme = localStorage.getItem(THEME_KEY);
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
render();
