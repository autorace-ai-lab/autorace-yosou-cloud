import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const statePath = resolve(root, "data/state.json");

const blankState = () => ({
  ok: true, version: 4,
  model: {
    params: { k: 0.40, betaScale: 1, placeHandi: 1 },
    baseline: { k: 0.40, betaScale: 1, placeHandi: 1 },
    candidates: {}, trained: 0, trainCount: 0, validationCount: 0,
    top1Hit: 0, trifectaHit: 0, logLoss: 0, validationGain: 0, updatedAt: null,
    pdca: { cycles: 0, accepted: 0, rejected: 0, lastCycleAt: null, recent: [],
      rolling: { n: 0, top1Rate: 0, top10Rate: 0, top30Rate: 0, meanRank: 0, logLoss: 0 },
      byVenue: {}, byCondition: {}, lastDecision: "初期データ収集中", changeHistory: [] }
  },
  races: {}, journal: [],
  collector: { mode: "github-actions", lastRun: null, lastSuccess: null, status: "waiting",
    message: "初回収集待ち", currentFetched: 0, pendingResults: 0, backfillVenueCursor: 0, backfillQueue: [] }
});

function normaliseState(value) {
  const base = blankState();
  const state = { ...base, ...(value || {}), ok: true };
  state.model = { ...base.model, ...(state.model || {}) };
  state.model.params = { ...base.model.params, ...(state.model.params || {}) };
  state.model.baseline = { ...base.model.baseline, ...(state.model.baseline || {}) };
  state.model.candidates ||= {};
  state.model.pdca = { ...base.model.pdca, ...(state.model.pdca || {}) };
  state.model.pdca.rolling = { ...base.model.pdca.rolling, ...(state.model.pdca.rolling || {}) };
  state.model.pdca.recent = Array.isArray(state.model.pdca.recent) ? state.model.pdca.recent.slice(-200) : [];
  state.model.pdca.changeHistory = Array.isArray(state.model.pdca.changeHistory) ? state.model.pdca.changeHistory.slice(-30) : [];
  state.model.pdca.byVenue ||= {}; state.model.pdca.byCondition ||= {};
  const races = state.races || {};
  state.races = Array.isArray(races) ? Object.fromEntries(races.filter(x => x?.key).map(x => [x.key, x])) : races;
  state.journal = Array.isArray(state.journal) ? state.journal.slice(-500) : [];
  state.collector = { ...base.collector, ...(state.collector || {}), mode: "github-actions" };
  state.collector.backfillQueue = Array.isArray(state.collector.backfillQueue) ? state.collector.backfillQueue.slice(0, 1500) : [];
  return state;
}

async function loadState() {
  try { return normaliseState(JSON.parse(await readFile(statePath, "utf8"))); } catch { return blankState(); }
}
async function saveState(state) {
  const safe = normaliseState(state);
  const output = { ...safe, races: Object.values(safe.races).sort((a,b)=>String(a.closeAt||"").localeCompare(String(b.closeAt||""))) };
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(output) + "\n", "utf8");
}

import { learnFromResult, predictRace } from "../netlify/functions/lib/model.mjs";
import {
  WT, VENUE_SLUGS, fetchText, mapLimit, parseCard, parseIndex, parseResult,
  raceKey, raceUrl, resultUrl
} from "../netlify/functions/lib/source.mjs";

const fiveYearsAgo = () => {
  const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - 5);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
};

function publicPrediction(card, params) {
  const p = predictRace(card, params);
  return {
    params: { ...params }, p1: p.p1, probabilitySum: p.probabilitySum,
    top: p.tri.slice(0, 30), createdAt: new Date().toISOString()
  };
}

function isBeforeDeadline(card, at = Date.now()) {
  const deadline = Date.parse(card?.closeAt || "");
  return !Number.isFinite(deadline) || (Number.isFinite(at) && at < deadline);
}

function hasPreDeadlineSnapshot(card) {
  if (!card) return false;
  if (card.preDeadline === true) return true;
  if (card.preDeadline === false) return false;
  const at = Date.parse(card.prediction?.createdAt || card.fetchedAt || "");
  return isBeforeDeadline(card, at);
}

function trainOnce(state, card, result, mode) {
  if (!card || !result || card.trained || card.cars?.length < 6) return false;
  if (mode === "live-snapshot" && card.preDeadline === false) {
    card.result = result;
    card.trainingExcluded = "post-deadline-snapshot";
    return false;
  }
  const score = learnFromResult(state.model, card, result);
  if (!score) return false;
  card.result = result; card.trained = true; card.trainedAt = new Date().toISOString();
  state.journal.push({
    key: card.key, venue: card.venue, race: card.r, combination: result.combination,
    payout: result.payout, predictedRank: score.rank, predictedProbability: score.probability,
    holdout: score.isValidation, mode, trainedAt: card.trainedAt
  });
  state.journal = state.journal.slice(-500);
  return true;
}

async function collectCurrent(state, maxRaces = 32) {
  const indexHtml = await fetchText(`${WT}/autorace/racecard/`);
  const races = parseIndex(indexHtml).slice(0, maxRaces);
  const cards = await mapLimit(races, 6, async race => {
    const card = parseCard(await fetchText(raceUrl(race)), race);
    if (card.cars.length < 6) return null;
    const old = state.races[card.key];
    if (!isBeforeDeadline(card) && hasPreDeadlineSnapshot(old)) return old;
    card.preDeadline = isBeforeDeadline(card);
    card.prediction = publicPrediction(card, state.model.params);
    card.result = old?.result || null;
    card.trained = !!old?.trained;
    card.trainedAt = old?.trainedAt || null;
    state.races[card.key] = card;
    return card;
  });
  state.collector.currentFetched = cards.filter(x => x && !x.error).length;
  return races;
}

async function collectPendingResults(state, maxResults = 14) {
  const now = Date.now();
  const pending = Object.values(state.races).filter(r => !r.result && r.cars?.length >= 6 &&
    (!r.closeAt || Date.parse(r.closeAt) < now - 4 * 60_000))
    .sort((a, b) => Date.parse(b.closeAt || 0) - Date.parse(a.closeAt || 0)).slice(0, maxResults);
  await mapLimit(pending, 4, async card => {
    const result = parseResult(await fetchText(resultUrl(card)), card);
    if (result) trainOnce(state, card, result, "live-snapshot");
  });
  state.collector.pendingResults = Object.values(state.races).filter(r => !r.result && r.cars?.length >= 6).length;
}

function refreshOpenPredictions(state) {
  for (const card of Object.values(state.races)) {
    if (!card.result && card.cars?.length >= 6 && isBeforeDeadline(card)) card.prediction = publicPrediction(card, state.model.params);
  }
}

async function discoverBackfill(state) {
  const cursor = state.collector.backfillVenueCursor % VENUE_SLUGS.length;
  const slug = VENUE_SLUGS[cursor];
  state.collector.backfillVenueCursor = (cursor + 1) % VENUE_SLUGS.length;
  const html = await fetchText(`${WT}/autorace/${slug}/racecard/`, 8000);
  const cutoff = fiveYearsAgo();
  const found = parseIndex(html).filter(r => r.cup.slice(0, 8) >= cutoff).sort((a, b) => b.cup.localeCompare(a.cup));
  const known = new Set([
    ...Object.keys(state.races),
    ...state.collector.backfillQueue.map(raceKey),
    ...state.journal.map(x => x.key)
  ]);
  for (const race of found) if (!known.has(race.key)) {
    state.collector.backfillQueue.push(race); known.add(race.key);
  }
  state.collector.backfillQueue = state.collector.backfillQueue.slice(0, 1500);
}

async function runBackfill(state) {
  const batch = state.collector.backfillQueue.splice(0, 2);
  await mapLimit(batch, 2, async race => {
    const [cardHtml, resultHtml] = await Promise.all([
      fetchText(raceUrl(race), 8000), fetchText(resultUrl(race), 8000)
    ]);
    const card = parseCard(cardHtml, race), result = parseResult(resultHtml, race);
    if (card.cars.length < 6 || !result) return;
    card.preDeadline = "historical-backfill";
    card.prediction = publicPrediction(card, state.model.params);
    state.races[card.key] = card;
    trainOnce(state, card, result, "historical-backfill");
  });
}

function prune(state) {
  const keep = new Set(state.journal.slice(-300).map(x => x.key));
  const cutoff = Date.now() - 14 * 86400_000;
  for (const [key, race] of Object.entries(state.races)) {
    if (!keep.has(key) && Date.parse(race.fetchedAt || 0) < cutoff) delete state.races[key];
  }
}

const started = Date.now(), state = await loadState();
const mode = "scheduled", manual = false;
  const beforeResults = Object.values(state.races).filter(r => r.result).length;
  state.collector.lastRun = new Date().toISOString();
  state.collector.status = "running";
  try {
    await collectCurrent(state, 64);
    await collectPendingResults(state, 64);
    if (!manual) {
      await discoverBackfill(state);
      await runBackfill(state);
    }
    refreshOpenPredictions(state);
    prune(state);
    state.collector.status = "ok";
    state.collector.lastSuccess = new Date().toISOString();
    const roll = state.model.pdca?.rolling || {};
    state.collector.message = `取得 ${state.collector.currentFetched}R / 学習 ${state.model.trained}R / PDCA ${roll.n || 0}R / 過去キュー ${state.collector.backfillQueue.length}R`;
  } catch (error) {
    state.collector.status = "partial";
    state.collector.message = `一部取得失敗: ${String(error?.message || error).slice(0, 180)}`;
  }
  state.collector.durationMs = Date.now() - started;
await saveState(state);
console.log(state.collector.message);
