import { getStore } from "@netlify/blobs";

export const STORE_NAME = "autorace-yosou-learning-v1";

export const blankState = () => ({
  version: 1,
  model: {
    params: { k: 0.65, betaScale: 1, placeHandi: 1 },
    baseline: { k: 0.65, betaScale: 1, placeHandi: 1 },
    candidates: {},
    trained: 0,
    trainCount: 0,
    validationCount: 0,
    top1Hit: 0,
    trifectaHit: 0,
    logLoss: 0,
    validationGain: 0,
    updatedAt: null
  },
  races: {},
  journal: [],
  collector: {
    lastRun: null,
    lastSuccess: null,
    status: "waiting",
    message: "初回収集待ち",
    currentFetched: 0,
    pendingResults: 0,
    backfillVenueCursor: 0,
    backfillQueue: []
  }
});

export function normaliseState(value) {
  const base = blankState();
  const state = { ...base, ...(value || {}) };
  state.model = { ...base.model, ...(state.model || {}) };
  state.model.params = { ...base.model.params, ...(state.model.params || {}) };
  state.model.baseline = { ...base.model.baseline, ...(state.model.baseline || {}) };
  state.model.candidates ||= {};
  state.races ||= {};
  state.journal = Array.isArray(state.journal) ? state.journal.slice(-500) : [];
  state.collector = { ...base.collector, ...(state.collector || {}) };
  state.collector.backfillQueue = Array.isArray(state.collector.backfillQueue)
    ? state.collector.backfillQueue.slice(0, 1500) : [];
  return state;
}

export async function openStore() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

export async function loadState(dataStore) {
  const raw = await dataStore.get("state");
  if (!raw) return blankState();
  try { return normaliseState(JSON.parse(raw)); }
  catch { return blankState(); }
}

export async function saveState(dataStore, state) {
  await dataStore.setJSON("state", normaliseState(state));
}

