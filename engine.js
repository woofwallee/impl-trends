// Implementation Health — CORE ENGINE (pure business logic)
// No CSV parsing, no company-specific stage names, no wording, no colors.
// Input: normalized records + a config object. Output: pure data (no formatting).
// This is the layer the implementation must reproduce faithfully.
//
// Normalized record shape:
//   { id, product, currentStage, events: { [stageName]: { enter: Date|null, exit: Date|null } } }
// Config shape: see engine-config.mjs (thresholds, stages, customerBlocked, productMinN).

export const DAY = 86400000;
export const days = (a, b) => Math.round((b - a) / DAY);
export const pctl = (arr, p) => { if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
export const median = a => pctl(a, 50);

// --- completed durations for a stage (baseline), optionally filtered by product ---
function durations(records, stage, product) {
  const out = [];
  for (const r of records) {
    if (product && r.product !== product) continue;
    const ev = r.events[stage]; if (!ev) continue;
    if (ev.enter && ev.exit && ev.exit >= ev.enter) out.push(days(ev.enter, ev.exit));
  }
  return out;
}

// --- per-stage computation (pure) ---
export function computeStage(records, stage, cfg, now, periodStart) {
  const T = cfg.thresholds;
  // baseline: per-product where the product has enough history, else blended
  let p85, p95, baselineNote = 'blended';
  const blended = durations(records, stage);
  p85 = pctl(blended, 85); p95 = pctl(blended, 95);
  // WIP census
  const wip = records.filter(r => r.currentStage === stage);
  const wipAged = wip.map(r => {
    const ev = r.events[stage];
    const enter = (ev && ev.enter) ? ev.enter : null;
    return { r, age: enter ? Math.max(0, days(enter, now)) : null };   // missing enter -> null (excluded)
  });
  const missingAge = wipAged.filter(x => x.age == null).length;
  // plausibility clamp: grossly implausible ages (data errors) are EXCLUDED from ranking, not
  // just flagged — a corrupted 9000-day record must never set the #1 priority. Bound is high
  // enough to keep genuinely-aging items (max(absolute floor, 2x p95)).
  const bound = Math.max(T.ageImplausibleAbs, T.ageImplausibleMult * (p95 || 0));
  const clean = wipAged.filter(x => x.age != null && x.age <= bound);
  const implausibleCount = wipAged.filter(x => x.age != null && x.age > bound).length;
  const cleanAges = clean.map(x => x.age);
  const oldest = cleanAges.length ? Math.max(...cleanAges) : 0;
  const excess = (p85 == null) ? 0 : cleanAges.reduce((s, a) => s + Math.max(0, a - p85), 0);
  const c85 = p85 == null ? 0 : cleanAges.filter(a => a > p85).length;
  const c95 = p95 == null ? 0 : cleanAges.filter(a => a > p95).length;
  // named WIP for drill-down (clamp-aware, oldest first) — engine-computed so the UI does no math
  const items = clean.map(x => ({ name: x.r.name || x.r.id, product: x.r.product, age: x.age }))
    .sort((a, b) => b.age - a.age);
  // flow from the event log (single snapshot, no diffing)
  let arrivals = 0, departs = 0;
  for (const r of records) {
    const ev = r.events[stage]; if (!ev) continue;
    if (ev.enter && ev.enter >= periodStart && ev.enter <= now) arrivals++;
    if (ev.exit && ev.exit >= periodStart && ev.exit <= now) departs++;
  }
  const net = arrivals - departs;
  return { stage, n: blended.length, p85, p95, baselineNote, wip: wip.length,
    oldest, excess, c85, c95, arrivals, departs, net, missingAge, implausibleCount, items,
    customerBlocked: cfg.customerBlocked.has(stage) };
}

// --- verdict (pure, config-driven, deterministic ladder) ---
export function verdictFor(s, cfg) {
  const T = cfg.thresholds;
  if (s.n < T.minHistory) return { tier: 9, key: 'no-history', verdict: 'Not enough history' };
  const material = s.c95 >= T.stuckMinCount && (s.excess >= T.agingExcess || (s.p95 != null && s.oldest >= T.agingOldestMult * s.p95));
  const clusterMaterial = s.wip >= T.clusterMinWip && s.c85 > T.clusterShare * s.wip && s.excess >= T.agingExcess;
  const building = s.net >= Math.max(T.buildAbs, Math.ceil(T.buildPct * Math.max(s.wip, 1)));
  const stalled = s.wip > 0 && s.arrivals === 0 && s.departs === 0 && s.oldest >= T.stagnationDays;
  if (material || clusterMaterial) return { tier: 1, key: 'aging', verdict: 'Aging' };
  if (building) return { tier: 2, key: 'building', verdict: 'Backlog building' };
  if (s.c95 >= T.stuckMinCount) return { tier: 3, key: 'watch', verdict: 'Watch' };
  if (stalled) return { tier: 3, key: 'stalled', verdict: 'Stalled' };
  if (s.net <= -T.buildAbs) return { tier: 4, key: 'clearing', verdict: 'Clearing' };
  return { tier: 5, key: 'steady', verdict: 'Steady' };
}

// --- data-quality guard (pure, symmetric) ---
export function dataQuality(records, evals, prevEvals, cfg) {
  const T = cfg.thresholds; const flags = [];
  if (prevEvals) {
    const cur = records.length, prevN = prevEvals.recordCount;
    if (prevN && Math.abs(cur - prevN) / prevN > T.countSwing)
      flags.push({ type: 'count-swing', msg: `record count swung ${(100 * (cur - prevN) / prevN).toFixed(0)}%` });
    for (const e of evals) {
      const pe = prevEvals.byStage[e.stage];
      if (pe && pe.wip >= T.collapseWipFloor && e.wip <= pe.wip * (1 - T.stageCollapse))
        flags.push({ type: 'stage-collapse', stage: e.stage, msg: `WIP fell ${pe.wip}->${e.wip}` });
    }
  }
  for (const e of evals) {
    if (e.implausibleCount > 0)
      flags.push({ type: 'implausible-age', stage: e.stage, msg: `${e.implausibleCount} record(s) with implausible age excluded from ranking` });
    if (e.missingAge > 0)
      flags.push({ type: 'missing-timestamps', stage: e.stage, msg: `${e.missingAge} WIP records missing an entry date` });
  }
  return flags;
}

// --- whole-dashboard assembly (pure data, no wording/formatting) ---
export function buildDashboard(records, cfg, now, periodStart, prevEvals) {
  const T = cfg.thresholds;
  const evals = cfg.stages.map(st => { const s = computeStage(records, st, cfg, now, periodStart); return { ...s, ...verdictFor(s, cfg) }; });
  const openTotal = records.filter(r => r.currentStage !== cfg.terminal).length;
  // focus: rank ALL stages by overdue-days, cap; building shown separately
  const aging = evals.filter(e => e.excess > 0).sort((a, b) => b.excess - a.excess);
  const focus = aging.slice(0, T.focusCap);
  const building = evals.filter(e => e.tier === 2).sort((a, b) => b.net - a.net);
  const totalExcess = evals.reduce((s, e) => s + e.excess, 0);
  const topConc = focus.slice(0, T.concentrationTopN);
  const top3Share = totalExcess ? Math.round(100 * topConc.reduce((s, e) => s + e.excess, 0) / totalExcess) : 0;
  const arrivals = evals.reduce((s, e) => s + e.arrivals, 0);
  const departs = evals.reduce((s, e) => s + e.departs, 0);
  const inOut = arrivals - departs;
  const keepState = Math.abs(inOut) <= Math.max(T.keepAbs, T.keepPct * arrivals) ? 'keeping-pace' : (inOut > 0 ? 'behind' : 'catching-up');
  const historySufficient = evals.filter(e => e.n >= T.minHistory).length;
  const dq = dataQuality(records, evals, prevEvals, cfg);
  // speed line (lagging): median PO->live for records that went live in the window
  const leads = [];
  for (const r of records) {
    if (r.liveDate && r.liveDate >= periodStart && r.liveDate <= now && r.poDate)
      leads.push(days(r.poDate, r.liveDate));
  }
  const goLives = records.filter(r => r.liveDate && r.liveDate >= periodStart && r.liveDate <= now).length;
  const medLead = median(leads);
  const prevLead = prevEvals ? prevEvals.medLead : null;
  const speedState = (medLead == null || prevLead == null) ? 'n/a'
    : (Math.abs(medLead - prevLead) <= Math.max(T.speedAbs, T.speedPct * (prevLead || 1)) ? 'about-the-same'
      : (medLead < prevLead ? 'faster' : 'slower'));
  // systemic flag: a surge hitting many stages at once is one story, not N separate fires.
  // (Aging is deliberately NOT called "systemic" — the concentration % already says whether
  //  the overdue wait is concentrated or spread, and "systemic aging" would contradict a high
  //  concentration. Systemic is reserved for inflow surges across many stages.)
  const buildingCount = evals.filter(e => e.key === 'building').length;
  const systemic = (buildingCount >= T.collapseN) ? 'intake-surge' : null;
  const prevExcess = prevEvals ? prevEvals.totalExcess : null;
  const prevOpen = prevEvals ? prevEvals.openTotal : null;

  // RENDER-READY VIEW MODEL — the presentation layer maps these fields to words/colors/DOM and does NO math.
  const view = {
    execBand: {
      snapshotDate: null,                 // caller stamps the export date
      open: openTotal, openDelta: prevOpen != null ? openTotal - prevOpen : null,
      concentrationPct: top3Share, totalExcess, prevExcess,
      topDrags: topConc.map(e => ({ stage: e.stage, excess: e.excess })),
      intakeState: keepState, arrivals, departs, systemic,
      goLives, medLead, speedState,
    },
    focusRows: focus.map(e => ({
      stage: e.stage, excess: e.excess, countPastNormal: e.c85, normal: e.p85,
      oldest: e.oldest, owner: e.customerBlocked ? 'customer' : 'team', key: e.key,
    })),
    actFirst: focus.filter(e => !e.customerBlocked && (e.key === 'aging')).map(e => e.stage),
    buildingRows: building.map(e => ({ stage: e.stage, net: e.net, arrivals: e.arrivals, departs: e.departs })),
    tableRows: evals.map((e, i) => ({
      order: i + 1, stage: e.stage, key: e.key, verdict: e.verdict, wip: e.wip,
      n: e.n, normal: e.p85, p95: e.p95, oldest: e.oldest, excess: e.excess, net: e.net,
      owner: e.customerBlocked ? 'customer' : 'team',
    })),
    notices: dq,
  };
  return {
    now, openTotal, evals, focus, building, totalExcess, top3Share,
    arrivals, departs, keepState, historySufficient, stageCount: evals.length, dq, systemic, view,
    snapshot: { recordCount: records.length, openTotal, totalExcess, medLead, byStage: Object.fromEntries(evals.map(e => [e.stage, e])) },
  };
}
