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
let TAB = 'snapshot';       // 'snapshot' (leadership) | 'dashboard' (analysis)
let PERIOD = 30;            // reporting window (days) for the Snapshot flow numbers
const loadPrev = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; } };
const savePrev = snap => localStorage.setItem(STORE_KEY, JSON.stringify(snap));

// ---------- presentation maps (wording/colors live here, not the engine) ----------
const LABEL = { aging: 'Aging', building: 'Backlog building', watch: 'Watch', stalled: 'Stalled', clearing: 'Clearing', steady: 'Steady', 'no-history': 'Not enough history' };
const PILL = { aging: 'aging', building: 'building', watch: 'building', stalled: 'building', clearing: 'clearing', steady: 'stable', 'no-history': 'stable' };
const INTAKE = { 'keeping-pace': 'keeping pace', behind: 'falling behind', 'catching-up': 'catching up' };
const SPEED = { faster: 'faster', slower: 'slower', 'about-the-same': 'about the same', 'n/a': 'no prior data' };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = d => d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—';
const PERIODS = [['This month', 'month'], ['Last 30 days', 30], ['Last 90 days', 90], ['Year to date', 'ytd']];
function periodStartFor(now, p) {
  if (p === 'month') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (p === 'ytd') return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  return new Date(now.getTime() - p * DAY);
}
const periodLabel = p => (PERIODS.find(x => x[1] === p) || ['Last 30 days'])[0];

// ---------- compute a dashboard for a given flow window ----------
function compute(periodValue) {
  const recs = RAW.filter(r => productMatch(r, FILTER));
  const now = SNAP, periodStart = periodStartFor(now, periodValue);
  const prev = FILTER === 'all' ? PREV : null;
  return buildDashboard(recs, GD_CONFIG, now, periodStart, prev);
}

// ---------- render ----------
function render() {
  const app = document.getElementById('app');
  if (!RAW.length) { app.innerHTML = emptyState(); wireImport(); return; }
  app.innerHTML = `${topBar()}${TAB === 'snapshot' ? snapshotView() : dashboardView()}`;
  wireImport(); wireFilter(); wireTabs();
  if (TAB === 'snapshot') wireSnapshot(); else wireDrill(compute(30));
}

// ================= SNAPSHOT (leadership · editorial) =================
function snapshotView() {
  const db = compute(PERIOD); const e = db.view.execBand;
  e.snapshotDate = fmtDate(SNAP);
  const drags = e.topDrags;
  const q1 = drags.length
    ? `<span class="n">${e.concentrationPct}%</span> of the delay <em>· in ${drags.length} stage${drags.length > 1 ? 's' : ''}</em>`
    : `<span class="n">None</span> <em>· nothing overdue</em>`;
  const openDelta = e.openDelta == null ? '' : ` <span class="${e.openDelta > 0 ? 'up' : 'dn'}">${e.openDelta > 0 ? '▲ +' : '▼ '}${e.openDelta}</span> <em>vs last import</em>`;
  const speed = e.medLead == null ? `<span class="n">—</span>` :
    `median <span class="n">${e.medLead}d</span> to live ${e.speedState === 'about-the-same' ? '<em>· about the same</em>' : e.speedState === 'n/a' ? '' : `<span class="${e.speedState === 'faster' ? 'dn' : 'up'}">${e.speedState === 'faster' ? '▼' : '▲'} ${SPEED[e.speedState]}</span>`}`;
  const dragList = drags.length ? `
    <div class="snap-drags">
      <div class="sd-h">Where the delay sits</div>
      ${drags.map((d, i) => {
        const ev = db.view.focusRows.find(f => f.stage === d.stage) || {};
        return `<div class="sd-row"><span class="sd-rank">${i + 1}</span>
          <span class="sd-name">${esc(d.stage)} <span class="pill ${ev.owner === 'customer' ? 'building' : 'stable'}">${ev.owner === 'customer' ? 'customer' : 'our team'}</span></span>
          <span class="sd-x">${d.excess} <small>overdue-days</small></span></div>`;
      }).join('')}
    </div>` : `<div class="snap-drags"><div class="sd-h">No stage is carrying overdue work right now.</div></div>`;

  return `
  <div class="snapwrap">
    <div class="snaphead">
      <p class="kicker">Leadership snapshot · ${esc(periodLabel(PERIOD))}</p>
      <h1>Implementation Health</h1>
      <p class="sub">Snapshot through ${esc(e.snapshotDate)}. Flow measured over ${esc(periodLabel(PERIOD).toLowerCase())}. Everything below is what leadership asks — nothing else.</p>
      <div class="seg periods" id="periods">
        ${PERIODS.map(([lbl, val]) => `<button class="${PERIOD === val ? 'on' : ''}" data-p="${val}">${lbl}</button>`).join('')}
      </div>
    </div>

    <div id="snapcard" class="snapcard">
      <div class="sc-brand"><b>Implementation Health</b><span>Snapshot through ${esc(e.snapshotDate)} · ${esc(periodLabel(PERIOD))}</span></div>
      <p class="lead">At a glance:</p>
      <div class="stmts">
        <div class="stmt"><span class="q">Where is the delay concentrated?</span><span class="a">${q1}</span></div>
        <div class="stmt"><span class="q">Is the backlog growing?</span><span class="a"><span class="n">${e.open}</span> open${openDelta}</span></div>
        <div class="stmt"><span class="q">Are we keeping up with incoming work?</span><span class="a"><span class="n">${e.arrivals}</span> in / <span class="n">${e.departs}</span> done <em>· ${INTAKE[e.intakeState]}</em></span></div>
        <div class="stmt"><span class="q">How fast are we delivering?</span><span class="a">${speed} <em>· ${e.goLives} live</em></span></div>
      </div>
      ${dragList}
    </div>

    <div class="snap-actions">
      <button class="btn" id="copySnap">Copy summary</button>
      <button class="btn ghost" id="dlSnap">Download PNG</button>
      <span class="muted" id="snapMsg"></span>
    </div>
  </div>`;
}

function snapshotText() {
  const db = compute(PERIOD); const e = db.view.execBand;
  const drags = e.topDrags.map(d => `${d.stage} (${d.excess} overdue-days)`).join(', ');
  return [
    `Implementation Health — snapshot through ${fmtDate(SNAP)} (${periodLabel(PERIOD)})`,
    `Backlog: ${e.open} open${e.openDelta != null ? ` (${e.openDelta > 0 ? '+' : ''}${e.openDelta} vs last import)` : ''}.`,
    e.topDrags.length ? `${e.concentrationPct}% of the overdue wait sits in: ${drags}.` : `Nothing is overdue.`,
    `Intake ${INTAKE[e.intakeState]} (${e.arrivals} in / ${e.departs} done over ${periodLabel(PERIOD).toLowerCase()}).`,
    e.medLead != null ? `${e.goLives} went live, median ${e.medLead} days to live (${SPEED[e.speedState]}).` : '',
  ].filter(Boolean).join('\n');
}

function wireSnapshot() {
  const seg = document.getElementById('periods');
  if (seg) seg.querySelectorAll('button').forEach(b => b.onclick = () => {
    const v = b.dataset.p; PERIOD = (v === 'month' || v === 'ytd') ? v : Number(v); render();
  });
  const copy = document.getElementById('copySnap');
  if (copy) copy.onclick = () => { navigator.clipboard.writeText(snapshotText()).then(() => msg('Copied to clipboard')); };
  const dl = document.getElementById('dlSnap');
  if (dl) dl.onclick = () => {
    const card = document.getElementById('snapcard');
    if (!window.html2canvas) { msg('PNG export unavailable'); return; }
    msg('Rendering…');
    window.html2canvas(card, { backgroundColor: getComputedStyle(document.body).backgroundColor, scale: 2 })
      .then(c => { const a = document.createElement('a'); a.download = `implementation-health-${fmtDate(SNAP).replace(/[ ,]/g, '')}.png`; a.href = c.toDataURL('image/png'); a.click(); msg('Downloaded'); });
  };
}
const msg = t => { const m = document.getElementById('snapMsg'); if (m) { m.textContent = t; setTimeout(() => { if (m.textContent === t) m.textContent = ''; }, 2500); } };

// ================= DASHBOARD (analysis) =================
function dashboardView() {
  const db = compute(30); const v = db.view; v.execBand.snapshotDate = fmtDate(SNAP);
  const e = v.execBand;
  return `
    <div class="dashhead">
      <span class="exec-date">Snapshot through ${esc(e.snapshotDate)}</span>
      <span>Backlog <b>${e.open} open</b>${e.openDelta == null ? '' : ` <span class="delta">(${e.openDelta >= 0 ? '+' : ''}${e.openDelta})</span>`} · intake ${INTAKE[e.intakeState]} (${e.arrivals} in / ${e.departs} out, 30d)</span>
    </div>
    ${notices(v.notices)}
    ${focusList(v)}
    ${allStages(v.tableRows)}
    ${drillHost()}`;
}
function notices(n) {
  if (!n.length) return '';
  return `<section class="notices">${n.map(f => `<div class="notice">⚠︎ ${esc(f.stage ? f.stage + ': ' : '')}${esc(f.msg)}</div>`).join('')}</section>`;
}
function focusList(v) {
  if (!v.focusRows.length) return `<section class="focus"><h2>Focus</h2><p class="muted">Nothing is overdue. No stage needs attention right now.</p></section>`;
  const rows = v.focusRows.map((r, i) => `
    <button class="card ${r.owner === 'customer' ? 'crit' : 'crit'} frow" data-stage="${esc(r.stage)}">
      <span class="rankn">${i + 1}</span>
      <span class="cmain">
        <span class="crow"><span class="cname">${esc(r.stage)}</span><span class="pill ${r.owner === 'customer' ? 'building' : 'stable'}">${r.owner === 'customer' ? 'customer-blocked' : 'team-owned'}</span></span>
        <span class="creason"><b>${r.excess} overdue-days</b> · ${r.countPastNormal} past the usual ~${r.normal ?? '–'}d, oldest ${r.oldest}d</span>
      </span>
      <span class="clink">view ${r.countPastNormal} →</span>
    </button>`).join('');
  const act = v.actFirst.length ? `<div class="restful"><b>Act first (your team owns these):</b> ${v.actFirst.map(esc).join(', ')}</div>`
    : `<div class="restful">Top drags are customer-blocked — nudge the customer.</div>`;
  const fill = v.buildingRows.length ? `<div class="restful"><b>Also filling</b> (capacity, not stuck): ${v.buildingRows.map(b => esc(b.stage) + ' +' + b.net).join(', ')}</div>` : '';
  return `<section class="focus"><h2>Focus · worst first</h2>${rows}${act}${fill}</section>`;
}
function allStages(rows) {
  const body = rows.map(r => `<tr>
    <td class="num">${r.order}</td><td class="stg">${esc(r.stage)}</td>
    <td><span class="pill ${PILL[r.key]}">${LABEL[r.key]}</span></td>
    <td class="num">${r.wip}</td><td class="num">${r.normal ?? '–'}</td>
    <td class="num">${r.oldest}</td><td class="num">${r.excess}</td><td class="num">${r.net > 0 ? '+' + r.net : r.net}</td></tr>`).join('');
  return `<section class="table"><h2>All stages · pipeline order</h2>
    <div class="tablewrap"><table><thead><tr>
    <th class="num">#</th><th>Stage</th><th>Verdict</th><th class="num">Open</th><th class="num">Normal</th>
    <th class="num">Oldest</th><th class="num">Overdue-days</th><th class="num">Net</th>
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
    host.innerHTML = `<div class="drillhead"><span class="t">${esc(st)}</span><span class="c">${items.length} waiting · oldest first</span>
      <button id="drillclose">close ✕</button></div>
      ${items.map(i => `<div class="rec"><span class="who">${esc(i.name)}</span><span class="prod">${esc(i.product)}</span><span class="age">${i.age}d</span></div>`).join('')}`;
    document.getElementById('drillclose').onclick = () => { host.hidden = true; };
    host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

// ---------- chrome ----------
function topBar() {
  return `<header class="top">
    <div class="brand"><b>Implementation Health</b><span class="tagline">Identify bottlenecks · prioritize attention · report performance</span></div>
    <div class="controls">
      <div class="seg" id="tabs">
        <button class="${TAB === 'snapshot' ? 'on' : ''}" data-tab="snapshot">Snapshot</button>
        <button class="${TAB === 'dashboard' ? 'on' : ''}" data-tab="dashboard">Dashboard</button>
      </div>
      <div class="seg" id="filter">
        ${['all', 'CAREpoint', 'e-Bridge'].map(f => `<button class="${FILTER === f ? 'on' : ''}" data-f="${f}">${f === 'all' ? 'All' : f}</button>`).join('')}
      </div>
      <label class="btn">Import<input id="file" type="file" accept=".csv" hidden></label>
      <button class="btn ghost" id="theme">◐</button>
    </div>
  </header>`;
}
function emptyState() {
  return `${topBar()}
    <section class="empty">
      <h1>Import a HubSpot export to begin</h1>
      <p class="muted">Drop your "All Implementations" CSV here, or use Import. Everything stays in your browser.</p>
      <button class="btn" id="demo">Load sample data</button>
    </section>`;
}

// ---------- import wiring ----------
function ingest(text, filename) {
  const rows = parseCSV(text);
  const recs = toRecords(rows);
  if (!recs.length || !recs.some(r => r.currentStage)) { alert('That file has no implementation records. Your existing view is unchanged.'); return; }
  const prev = loadPrev();
  if (prev && prev.recordCount && Math.abs(recs.length - prev.recordCount) / prev.recordCount > GD_CONFIG.thresholds.countSwing) {
    if (!confirm(`This import has ${recs.length} records vs ${prev.recordCount} last time (>${Math.round(GD_CONFIG.thresholds.countSwing * 100)}% change). A HubSpot filter may have been left on. Import anyway?`)) return;
  }
  RAW = recs; SNAP = snapshotDate(recs, filename); FILTER = 'all'; PREV = prev;
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
function wireTabs() {
  const seg = document.getElementById('tabs');
  if (seg) seg.querySelectorAll('button').forEach(b => b.onclick = () => { TAB = b.dataset.tab; render(); });
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
