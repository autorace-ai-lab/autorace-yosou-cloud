export const blankState = () => ({
  version: 2,
  model: {
    params: { k: 0.65, betaScale: 1, placeHandi: 1 },
    baseline: { k: 0.65, betaScale: 1, placeHandi: 1 },
    candidates: {}, trained: 0, trainCount: 0, validationCount: 0,
    top1Hit: 0, trifectaHit: 0, logLoss: 0, validationGain: 0,
    pdca: {
      cycles: 0, accepted: 0, rejected: 0, lastCycleAt: null,
      recent: [], rolling: { n: 0, top1Rate: 0, top10Rate: 0, top30Rate: 0, meanRank: 0, logLoss: 0 },
      byVenue: {}, byCondition: {}, lastDecision: "初期データ収集中", changeHistory: []
    },
    updatedAt: null
  },
  races: {}, journal: [],
  collector: {
    lastRun: null, lastSuccess: null, status: "waiting", message: "初回収集待ち",
    currentFetched: 0, pendingResults: 0, backfillVenueCursor: 0, backfillQueue: []
  }
});

export function normaliseState(value) {
  const base = blankState();
  const state = { ...base, ...(value || {}) };
  state.model = { ...base.model, ...(state.model || {}) };
  state.model.params = { ...base.model.params, ...(state.model.params || {}) };
  state.model.baseline = { ...base.model.baseline, ...(state.model.baseline || {}) };
  state.model.candidates ||= {};
  state.model.pdca = { ...base.model.pdca, ...(state.model.pdca || {}) };
  state.model.pdca.rolling = { ...base.model.pdca.rolling, ...(state.model.pdca.rolling || {}) };
  state.model.pdca.recent = Array.isArray(state.model.pdca.recent) ? state.model.pdca.recent.slice(-200) : [];
  state.model.pdca.changeHistory = Array.isArray(state.model.pdca.changeHistory) ? state.model.pdca.changeHistory.slice(-30) : [];
  state.model.pdca.byVenue ||= {};
  state.model.pdca.byCondition ||= {};
  state.races ||= {};
  state.journal = Array.isArray(state.journal) ? state.journal.slice(-500) : [];
  state.collector = { ...base.collector, ...(state.collector || {}) };
  state.collector.backfillQueue = Array.isArray(state.collector.backfillQueue) ? state.collector.backfillQueue.slice(0, 1500) : [];
  return state;
}

export async function loadState(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)").run();
  const row = await db.prepare("SELECT value FROM app_state WHERE key = ?").bind("state").first();
  if (!row?.value) return blankState();
  try { return normaliseState(JSON.parse(row.value)); }
  catch { return blankState(); }
}

export async function saveState(db, state) {
  const value = JSON.stringify(normaliseState(state));
  await db.prepare("INSERT INTO app_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .bind("state", value, new Date().toISOString()).run();
}
