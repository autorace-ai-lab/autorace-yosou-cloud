const VENUES = {
  kawaguchi: { id: "kawaguchi", len: 500, mae: 1.00 },
  isesaki: { id: "isesaki", len: 400, mae: 1.12 },
  hamamatsu: { id: "hamamatsu", len: 500, mae: 0.98 },
  iizuka: { id: "iizuka", len: 500, mae: 1.16 },
  sanyou: { id: "sanyou", len: 500, mae: 1.03 }
};

const BASE = {
  stBase: 0.16, stW: 0.20, formW: 0.030, formBase: 0.45,
  wetMix: 0.6, shinsaW: 0.0002, shinsaBase: 60,
  gradeAdj: { S: -0.004, A: 0, B: 0.003 }, recentBase: 4,
  recentW: 0.002, topLead: 0.008, fW: 0.003,
  defHensa: 0.09, defDist: 3100, defT: 3.45, beta: 32,
  betaCond: { good: 1, mudd: 0.89, wet: 0.74 },
  handiCond: { good: 1, mudd: 1.04, wet: 1.10 }, wetNoise: 0.05
};

const mean = a => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function formRate(c, cond) {
  if (cond === "wet" && c.rate3wet != null && c.rate3good != null)
    return BASE.wetMix * c.rate3wet + (1 - BASE.wetMix) * c.rate3good;
  if (cond === "wet" && c.rate3wet != null) return c.rate3wet;
  return c.rate3good ?? c.rate90_3 ?? null;
}

function riderTime(c, p) {
  if (c.avgRace != null && c.avgShiso != null && c.shiso != null)
    return c.avgRace + p.k * (c.shiso - c.avgShiso);
  if (c.shiso != null && c.hensa != null) return c.shiso + c.hensa;
  if (c.avgRace != null) return c.avgRace;
  return (Number.isFinite(c.shiso) ? c.shiso : BASE.defT) + BASE.defHensa;
}

function effectiveTime(c, cond, p) {
  let t = riderTime(c, p);
  if (Number.isFinite(c.st)) t += (c.st - BASE.stBase) * BASE.stW;
  const r3 = formRate(c, cond);
  if (r3 != null) t -= (r3 - BASE.formBase) * BASE.formW;
  if (c.shinsa != null) t -= (c.shinsa - BASE.shinsaBase) * BASE.shinsaW;
  else if (Number.isFinite(c.win)) t -= (c.win - 5.5) * 0.004;
  t += BASE.gradeAdj[c.grade] ?? 0;
  if (Number.isFinite(c.recentMean)) t += (c.recentMean - BASE.recentBase) * BASE.recentW;
  t += (c.f || 0) * BASE.fW;
  return t;
}

export function coreScores(cars, venueId, cond = "good", dist, params = {}) {
  const p = { k: 0.65, betaScale: 1, placeHandi: 1, ...params };
  const venue = VENUES[venueId] || VENUES.kawaguchi;
  const n = cars.length;
  const base = cars.map(c => effectiveTime(c, cond, p));
  const distance = dist > 500 ? dist : BASE.defDist;
  const baseT = mean(cars.map(c => riderTime(c, p)));
  const perM = baseT / distance;
  const hp = cars.map(c => Number(c.handi || 0) * perM * venue.mae * BASE.handiCond[cond]);
  const eff = base.map((x, i) => x + hp[i]);
  const minH = Math.min(...cars.map(c => Number(c.handi || 0)));
  const fronts = [];
  cars.forEach((c, i) => { if (Number(c.handi || 0) === minH) fronts.push(i); });
  const lead = BASE.topLead * (cond === "wet" ? 0.4 : 1) / Math.max(1, fronts.length);
  fronts.forEach(i => { eff[i] += lead; });
  const beta = BASE.beta * p.betaScale * BASE.betaCond[cond];
  const scoreFor = weight => {
    const adjusted = eff.map((x, i) => x + hp[i] * (weight - 1));
    const m = mean(adjusted);
    let scores = adjusted.map(x => Math.exp(-beta * (x - m)));
    if (cond === "wet") {
      const mx = Math.max(...scores);
      scores = scores.map(v => v + BASE.wetNoise * mx);
    }
    const total = scores.reduce((a, b) => a + b, 0);
    return scores.map(v => v / total * n);
  };
  const s1 = scoreFor(1), sP = scoreFor(p.placeHandi);
  const S1 = s1.reduce((a, b) => a + b, 0), SP = sP.reduce((a, b) => a + b, 0);
  const idx = Object.fromEntries(cars.map((c, i) => [c.num, i]));
  return { cars, idx, s1, sP, S1, SP, p1: s1.map(v => v / S1), eff, hp, beta, distance };
}

export function trifectaProbability(core, a, b, c) {
  const ia = core.idx[a], ib = core.idx[b], ic = core.idx[c];
  if (ia == null || ib == null || ic == null || ia === ib || ia === ic || ib === ic) return 0;
  const d1 = core.SP - core.sP[ia], d2 = d1 - core.sP[ib];
  if (d1 <= 0 || d2 <= 0) return 0;
  return (core.s1[ia] / core.S1) * (core.sP[ib] / d1) * (core.sP[ic] / d2);
}

export function predictRace(card, params) {
  const core = coreScores(card.cars, card.venue, card.cond, card.dist, params);
  const tri = [];
  for (const a of card.cars) for (const b of card.cars) for (const c of card.cars) {
    if (a.num === b.num || a.num === c.num || b.num === c.num) continue;
    tri.push({ a: a.num, b: b.num, c: c.num, p: trifectaProbability(core, a.num, b.num, c.num) });
  }
  const sum = tri.reduce((s, x) => s + x.p, 0);
  tri.forEach(x => { x.p /= sum || 1; });
  tri.sort((a, b) => b.p - a.p);
  return { p1: core.p1, tri, probabilitySum: tri.reduce((s, x) => s + x.p, 0) };
}

export function candidateGrid() {
  const out = [];
  for (const k of [0.45, 0.55, 0.65, 0.75, 0.85])
    for (const betaScale of [0.78, 0.90, 1, 1.10, 1.22])
      for (const placeHandi of [0.88, 1, 1.12, 1.24])
        out.push({ k, betaScale, placeHandi });
  return out;
}

const paramId = p => `${p.k.toFixed(2)}|${p.betaScale.toFixed(2)}|${p.placeHandi.toFixed(2)}`;
const splitIsValidation = key => {
  let h = 2166136261;
  for (const ch of String(key)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % 5 === 0;
};

export function learnFromResult(model, card, result) {
  const actual = result.trifecta.map(Number);
  if (actual.length !== 3 || new Set(actual).size !== 3) return false;
  const isValidation = splitIsValidation(card.key);
  for (const params of candidateGrid()) {
    const id = paramId(params);
    const stat = model.candidates[id] ||= { params, trainN: 0, trainLL: 0, valN: 0, valLL: 0 };
    const core = coreScores(card.cars, card.venue, card.cond, card.dist, params);
    const prob = clamp(trifectaProbability(core, actual[0], actual[1], actual[2]), 1e-9, 1);
    if (isValidation) { stat.valN++; stat.valLL += -Math.log(prob); }
    else { stat.trainN++; stat.trainLL += -Math.log(prob); }
  }
  const activePrediction = predictRace(card, model.params);
  const actualKey = actual.join("-");
  const rank = activePrediction.tri.findIndex(x => `${x.a}-${x.b}-${x.c}` === actualKey) + 1;
  const actualProb = activePrediction.tri.find(x => `${x.a}-${x.b}-${x.c}` === actualKey)?.p || 1e-9;
  model.trained++;
  model.trainCount += isValidation ? 0 : 1;
  model.validationCount += isValidation ? 1 : 0;
  model.top1Hit += activePrediction.p1.indexOf(Math.max(...activePrediction.p1)) + 1 === actual[0] ? 1 : 0;
  model.trifectaHit += rank === 1 ? 1 : 0;
  model.logLoss += -Math.log(Math.max(actualProb, 1e-9));
  model.updatedAt = new Date().toISOString();
  chooseValidatedParams(model);
  return { rank, probability: actualProb, top: activePrediction.tri[0], isValidation };
}

function chooseValidatedParams(model) {
  const stats = Object.values(model.candidates).filter(s => s.trainN >= 40 && s.valN >= 12);
  if (!stats.length) return;
  const best = stats.slice().sort((a, b) => a.trainLL / a.trainN - b.trainLL / b.trainN)[0];
  const base = model.candidates[paramId(model.baseline)] || stats[0];
  const bestVal = best.valLL / best.valN, baseVal = base.valLL / base.valN;
  const gain = baseVal > 0 ? (baseVal - bestVal) / baseVal : 0;
  model.validationGain = gain;
  if (Number.isFinite(gain) && gain >= 0.01) model.params = { ...best.params };
}
