// Stage Health engine host: boots DuckDB-WASM (vendored, single-threaded) and runs
// engine.sql — the validated recipe. This file is PLUMBING: it moves data in and
// results out. It performs no analytical math; changing a business rule means
// changing engine.sql + audit/verification/duckdb/engine.sql together and
// re-running the 16-dataset gate (spec §15).
import * as duckdb from "./vendor/duckdb/duckdb-browser.mjs";

let boot = null;                                          // { conn, sql } once ready
export function initEngine() {
  if (boot) return boot;
  boot = (async () => {
    const worker = new Worker(new URL("./vendor/duckdb/duckdb-browser-eh.worker.js", import.meta.url));
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
    await db.instantiate(new URL("./vendor/duckdb/duckdb-eh.wasm", import.meta.url).href);
    const conn = await db.connect();
    const text = await (await fetch("engine.sql?v=45")).text();   // keep ?v in step with app.js?v= in index.html (GitHub Pages caches ~10min)
    // strip -- comments, split on ';' (no semicolons inside the recipe's string literals)
    const stmts = text.split("\n").map(l => l.split("--")[0]).join("\n")
      .split(";").map(s => s.trim()).filter(Boolean);
    return { db, conn, stmts };
  })();
  boot.catch(() => { boot = null; });                     // allow retry after a failed boot
  return boot;
}

// Arrow value normalizer. BIGINT arrives as JS BigInt; DuckDB promotes integer
// sums to HUGEINT/DECIMAL(38,0), which Arrow-JS returns as a typed-array-backed
// BigNum — Number(v) triggers its exact multi-word conversion (bn.mjs), which is
// UNSCALED: it is only correct for scale-0 values. Every aggregate engine.sql
// produces today is scale-0 (sums/counts of integer day-counts), and Arrow
// throws (never corrupts) past Number.MAX_SAFE_INTEGER. If engine.sql ever
// aggregates a scaled DECIMAL, this must thread the scale through instead.
const num = v => (typeof v === "bigint" || ArrayBuffer.isView(v)) ? Number(v) : v;
const rows = async (conn, sql) => (await conn.query(sql)).toArray()
  .map(r => { const o = r.toJSON(); for (const k of Object.keys(o)) o[k] = num(o[k]); return o; });
const ms = d => (d ? d.getTime() : null);
const esc = s => String(s).replace(/'/g, "''");

// cfg column order — MUST stay in sync with the CREATE TABLE below and config.js keys
const THRESH = [["focusCap","focus_cap"],["concentrationTopN","concentration_top_n"],["minHistory","min_history"],
  ["agingExcess","aging_excess"],["agingOldestMult","aging_oldest_mult"],["stuckMinCount","stuck_min_count"],
  ["clusterShare","cluster_share"],["clusterMinWip","cluster_min_wip"],["buildAbs","build_abs"],["buildPct","build_pct"],
  ["keepAbs","keep_abs"],["keepPct","keep_pct"],["speedAbs","speed_abs"],["speedPct","speed_pct"],
  ["countSwing","count_swing"],["stageCollapse","stage_collapse"],["collapseWipFloor","collapse_wip_floor"],
  ["ageImplausibleAbs","age_implausible_abs"],["ageImplausibleMult","age_implausible_mult"],
  ["collapseN","collapse_n"],["stagnationDays","stagnation_days"],["productMinN","product_min_n"],["windowDays","window_days"]];

async function runDashboard(records, cfg, now, periodStart, prev) {
  const { db, conn, stmts } = await initEngine();
  // ---- feed typed tables (JSON in, columns declared — SQL never parses dates) ----
  const recRows = records.map((r, i) => ({ rid: i, id: r.id ?? "", name: r.name ?? "", product: r.product ?? "",
    current_stage: r.currentStage ?? "", po_ms: ms(r.poDate), live_ms: ms(r.liveDate) }));
  const evRows = [];
  records.forEach((r, i) => { for (const [st, e] of Object.entries(r.events || {}))
    evRows.push({ rid: i, stage: st, enter_ms: ms(e.enter), exit_ms: ms(e.exit) }); });
  await db.registerFileText("records.json", JSON.stringify(recRows));
  await db.registerFileText("events.json", JSON.stringify(evRows));
  await conn.query(`CREATE OR REPLACE TABLE records AS SELECT * FROM read_json('records.json',
    columns={rid:'BIGINT', id:'VARCHAR', name:'VARCHAR', product:'VARCHAR', current_stage:'VARCHAR', po_ms:'DOUBLE', live_ms:'DOUBLE'})`);
  await conn.query(`CREATE OR REPLACE TABLE events AS SELECT * FROM read_json('events.json',
    columns={rid:'BIGINT', stage:'VARCHAR', enter_ms:'DOUBLE', exit_ms:'DOUBLE'})`);
  await conn.query(`CREATE OR REPLACE TABLE stages(ord BIGINT, stage VARCHAR, customer_blocked BOOLEAN)`);
  if (cfg.stages.length) await conn.query(`INSERT INTO stages VALUES ` +
    cfg.stages.map((s, i) => `(${i}, '${esc(s)}', ${cfg.customerBlocked.has(s)})`).join(","));
  const cfgCols = ["terminal VARCHAR", "now_ms DOUBLE", "period_start_ms DOUBLE", ...THRESH.map(([, c]) => c + " DOUBLE")].join(", ");
  await conn.query(`CREATE OR REPLACE TABLE cfg(${cfgCols})`);
  await conn.query(`INSERT INTO cfg VALUES ('${esc(cfg.terminal)}', ${now.getTime()}, ${periodStart.getTime()}, ` +
    THRESH.map(([k]) => cfg.thresholds[k]).join(", ") + `)`);
  await conn.query(`CREATE OR REPLACE TABLE prev_scalars(record_count DOUBLE, open_total DOUBLE, total_excess DOUBLE, med_lead DOUBLE)`);
  await conn.query(`CREATE OR REPLACE TABLE prev_stage(stage VARCHAR, wip DOUBLE)`);
  if (prev) {
    await conn.query(`INSERT INTO prev_scalars VALUES (${prev.recordCount ?? "NULL"}, ${prev.openTotal ?? "NULL"}, ${prev.totalExcess ?? "NULL"}, ${prev.medLead ?? "NULL"})`);
    const ps = Object.entries(prev.byStage || {});
    if (ps.length) await conn.query(`INSERT INTO prev_stage VALUES ` +
      ps.map(([s, e]) => `('${esc(s)}', ${e.wip})`).join(","));
  }
  // ---- run the frozen recipe ----
  for (const st of stmts) await conn.query(st);
  // ---- read the views (consumers re-state ORDER BY — spec §13.6) ----
  const eb = (await rows(conn, "SELECT * FROM exec_band"))[0];
  const focus = await rows(conn, "SELECT * FROM focus ORDER BY excess DESC, ord ASC");
  const building = await rows(conn, "SELECT * FROM building_rows ORDER BY net DESC, ord ASC");
  const table = await rows(conn, "SELECT * FROM verdict_words ORDER BY ord");
  const notices = await rows(conn, "SELECT * FROM notices ORDER BY pri, ord, sub");
  const itemRows = await rows(conn, "SELECT * FROM items ORDER BY stage, pos");
  const topN = cfg.thresholds.concentrationTopN;
  const owner = r => r.customer_blocked ? "customer" : "team";
  const items = {};
  for (const s of cfg.stages) items[s] = [];
  for (const r of itemRows) (items[r.stage] ||= []).push({ name: r.name, product: r.product, age: r.age });
  const view = {
    execBand: { snapshotDate: null, open: eb.open_total, openDelta: eb.open_delta,
      concentrationPct: eb.concentration_pct, totalExcess: eb.total_excess, prevExcess: eb.prev_excess,
      topDrags: focus.slice(0, topN).map(r => ({ stage: r.stage, excess: r.excess })),
      intakeState: eb.intake_state, arrivals: eb.arrivals, departs: eb.departs, systemic: eb.systemic,
      goLives: eb.go_lives, medLead: eb.med_lead, speedState: eb.speed_state },
    focusRows: focus.map(r => ({ stage: r.stage, excess: r.excess, countPastNormal: r.c85,
      normal: r.p85, oldest: r.oldest, owner: owner(r), key: r.key })),
    actFirst: focus.filter(r => !r.customer_blocked && r.key === "aging").map(r => r.stage),
    buildingRows: building.map(r => ({ stage: r.stage, net: r.net, arrivals: r.arrivals, departs: r.departs })),
    tableRows: table.map((r, i) => ({ order: i + 1, stage: r.stage, key: r.key, verdict: r.verdict,
      wip: r.wip, n: r.n, normal: r.p85, p95: r.p95, oldest: r.oldest, excess: r.excess, net: r.net, owner: owner(r) })),
    notices: notices.map(r => noticeMsg(r, table, records.length, prev)),
  };
  const snapshot = { recordCount: records.length, openTotal: eb.open_total, totalExcess: eb.total_excess,
    medLead: eb.med_lead, byStage: Object.fromEntries(table.map(r => [r.stage, { wip: r.wip }])) };
  return { view, items, snapshot };
}

// One run at a time: the shim shares a single DuckDB connection, and a run is
// many awaited statements (table loads + recipe + reads). Interleaved runs
// would compute view models from cross-contaminated tables — so calls queue.
let chain = Promise.resolve();
export function buildDashboardDb(records, cfg, now, periodStart, prev) {
  const run = chain.catch(() => {}).then(() => runDashboard(records, cfg, now, periodStart, prev));
  chain = run;
  return run;
}

// Notice sentences live HERE (presentation, spec §10/§14.5) — but they reproduce
// engine-core's dataQuality() wording VERBATIM (lines 86-105), including the prior
// WIP in stage-collapse ("WIP fell 7->2"): every number the engine used is available
// from `prev`, `table`, and the record count, so nothing is lost in the port.
function noticeMsg(r, table, recordCount, prev) {
  const t = table.find(x => x.stage === r.stage) || {};
  let msg;
  if (r.type === "count-swing") {
    const prevN = prev && prev.recordCount;
    msg = `record count swung ${(100 * (recordCount - prevN) / prevN).toFixed(0)}%`;
  } else if (r.type === "stage-collapse") {
    const pw = prev && prev.byStage && prev.byStage[r.stage] ? prev.byStage[r.stage].wip : "?";
    msg = `Open items fell from ${pw} to ${t.wip}`;
  } else if (r.type === "implausible-age") {
    msg = `${t.implausible_count} record(s) with implausible age excluded from ranking`;
  } else {
    msg = `${t.missing_age} open items missing an entry date`;
  }
  return { type: r.type, stage: r.stage ?? null, msg };
}
