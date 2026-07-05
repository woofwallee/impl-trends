// Implementation Health — CONFIGURATION layer
// Everything that is company/tuning specific. Changing any of this must NOT
// require touching engine-core.mjs. Hannah's wording lives in presentation;
// Andrew's thresholds and stage mappings live here.

// Locked v1 thresholds (Ethan-owned; adjust here only). EVERY tunable business rule
// lives in this object — engine-core.mjs contains no embedded magic numbers.
export const THRESHOLDS = {
  focusCap: 5,           // focus list shows at most this many drags
  concentrationTopN: 3,  // exec headline concentrates overdue-wait into this many top stages
  minHistory: 8,         // completed durations needed for a stable baseline
  agingExcess: 20,       // overdue customer-days to count as a material aging fire
  agingOldestMult: 1.25, // OR oldest item >= 1.25 * p95
  stuckMinCount: 1,      // items past p95 needed to consider a stage "individually stuck"
  clusterShare: 0.30,    // fraction of WIP past p85 to count as a material aging cluster
  clusterMinWip: 4,      // min WIP before a cluster verdict can fire
  buildAbs: 3,           // net backlog to call "building" (also the clearing floor)
  buildPct: 0.25,        // or >= 25% of WIP
  keepAbs: 3, keepPct: 0.10,   // in-vs-out tolerance band
  speedAbs: 5, speedPct: 0.15, // lead-time tolerance band
  countSwing: 0.20,      // >20% record-count swing = data-quality confirm
  stageCollapse: 0.50,   // stage WIP dropping >50% = suspicious
  collapseWipFloor: 6,   // only warn about a stage collapse if it had at least this much WIP before
  ageImplausibleAbs: 730, ageImplausibleMult: 2,  // age > max(730, 2*p95) = implausible
  collapseN: 5,          // >= this many stages moving the same direction => flag as systemic
  productMinN: 15,
  windowDays: 30,        // flow window (arrivals/departures) in days       // per-product baseline only when the product has >= this history
  stagnationDays: 45,    // a stage with WIP but no arrivals AND no departures for this window = stalled
};

// General Devices configuration.
export const GD_CONFIG = {
  stages: [
    'Not Started', 'Pending Kickoff Call', 'Pending Technical Readiness', 'Pending Server Tour',
    'Pending Server/Remote Access', 'Pending Software Installation', 'Software Installation Completed',
    'Network Testing', 'Network Testing Completed', 'In Progress', 'In Training', 'Waiting on Customer',
    'On-hold', 'Go-Live Scheduled',
  ],
  terminal: 'Implementation Live/Complete',
  customerBlocked: new Set([
    'Pending Kickoff Call', 'Pending Technical Readiness', 'Pending Server Tour',
    'Pending Server/Remote Access', 'Waiting on Customer', 'On-hold',
  ]),
  products: ['CAREpoint', 'e-Bridge'],
  thresholds: THRESHOLDS,
};

// Factory for an arbitrary company config (used by the generalization test).
export function makeConfig({ stages, customerBlocked = [], terminal = 'Complete', thresholds = THRESHOLDS }) {
  return { stages, terminal, customerBlocked: new Set(customerBlocked), products: [], thresholds };
}
