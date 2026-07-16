import { loadState, openStore, saveState } from "./lib/store.mjs";
import { learnFromResult, predictRace } from "./lib/model.mjs";
import {
  WT, VENUE_SLUGS, fetchText, mapLimit, parseCard, parseIndex, parseResult,
  raceKey, raceUrl, resultUrl
} from "./lib/source.mjs";

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

function trainOnce(state, card, result, mode) {
  if (!card || !result || card.trained || card.cars?.length < 6) return false;
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
  const pending = Object.values(state.races).filter(r => !r.trained && r.cars?.length >= 6 &&
    (!r.closeAt || Date.parse(r.closeAt) < now - 4 * 60_000))
    .sort((a, b) => Date.parse(b.closeAt || 0) - Date.parse(a.closeAt || 0)).slice(0, maxResults);
  await mapLimit(pending, 4, async card => {
    const result = parseResult(await fetchText(resultUrl(card)), card);
    if (result) trainOnce(state, card, result, "live-snapshot");
  });
  state.collector.pendingResults = Object.values(state.races).filter(r => !r.trained && r.cars?.length >= 6).length;
}

function refreshOpenPredictions(state) {
  for (const card of Object.values(state.races)) {
    if (!card.result && card.cars?.length >= 6) card.prediction = publicPrediction(card, state.model.params);
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

export default async request => {
  const started = Date.now(), dataStore = await openStore(), state = await loadState(dataStore);
  const mode = (() => { try { return new URL(request?.url || "https://local/").searchParams.get("mode") || "scheduled"; } catch { return "scheduled"; } })();
  const manual = mode === "current" || mode === "results";
  const beforeResults = Object.values(state.races).filter(r => r.result).length;
  state.collector.lastRun = new Date().toISOString();
  state.collector.status = "running";
  try {
    await collectCurrent(state, manual ? 64 : 32);
    await collectPendingResults(state, mode === "results" ? 64 : 14);
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
  await saveState(dataStore, state);
  const afterResults = Object.values(state.races).filter(r => r.result).length;
  return new Response(JSON.stringify({ ok: state.collector.status === "ok", mode, newResults: afterResults - beforeResults, resultsAvailable: afterResults, collector: state.collector, model: state.model }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
};

export const config = { schedule: "*/15 * * * *" };
import { loadState, openStore, saveState } from "./lib/store.mjs";
import { learnFromResult, predictRace } from "./lib/model.mjs";
import {
  WT, VENUE_SLUGS, fetchText, mapLimit, parseCard, parseIndex, parseResult,
  raceKey, raceUrl, resultUrl
} from "./lib/source.mjs";

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

function trainOnce(state, card, result, mode) {
  if (!card || !result || card.trained || card.cars?.length < 6) return false;
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
  const pending = Object.values(state.races).filter(r => !r.trained && r.cars?.length >= 6 &&
    (!r.closeAt || Date.parse(r.closeAt) < now - 4 * 60_000)).slice(0, maxResults);
  await mapLimit(pending, 4, async card => {
    const result = parseResult(await fetchText(resultUrl(card)), card);
    if (result) trainOnce(state, card, result, "live-snapshot");
  });
  state.collector.pendingResults = Object.values(state.races).filter(r => !r.trained && r.cars?.length >= 6).length;
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

export default async request => {
  const started = Date.now(), dataStore = await openStore(), state = await loadState(dataStore);
  const mode = (() => { try { return new URL(request?.url || "https://local/").searchParams.get("mode") || "scheduled"; } catch { return "scheduled"; } })();
  const manual = mode === "current" || mode === "results";
  const beforeResults = Object.values(state.races).filter(r => r.result).length;
  state.collector.lastRun = new Date().toISOString();
  state.collector.status = "running";
  try {
    await collectCurrent(state, manual ? 64 : 32);
    await collectPendingResults(state, mode === "results" ? 64 : 14);
    if (!manual) {
      await discoverBackfill(state);
      await runBackfill(state);
    }
    prune(state);
    state.collector.status = "ok";
    state.collector.lastSuccess = new Date().toISOString();
    state.collector.message = `取得 ${state.collector.currentFetched}R / 学習累計 ${state.model.trained}R / 過去キュー ${state.collector.backfillQueue.length}R`;
  } catch (error) {
    state.collector.status = "partial";
    state.collector.message = `一部取得失敗: ${String(error?.message || error).slice(0, 180)}`;
  }
  state.collector.durationMs = Date.now() - started;
  await saveState(dataStore, state);
  const afterResults = Object.values(state.races).filter(r => r.result).length;
  return new Response(JSON.stringify({ ok: state.collector.status === "ok", mode, newResults: afterResults - beforeResults, resultsAvailable: afterResults, collector: state.collector, model: state.model }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
};

export const config = { schedule: "*/15 * * * *" };
