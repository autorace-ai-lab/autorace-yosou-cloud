import { loadState, openStore } from "./lib/store.mjs";

const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*"
};

export default async () => {
  try {
    const state = await loadState(await openStore());
    const races = Object.values(state.races).map(r => ({
      key: r.key, slug: r.slug, venue: r.venue, cup: r.cup, day: r.day, r: r.r,
      close: r.close, closeAt: r.closeAt, cond: r.cond, dist: r.dist, cars: r.cars,
      prediction: r.prediction, result: r.result, trained: !!r.trained,
      trainingExcluded: r.trainingExcluded || null, preDeadline: r.preDeadline, fetchedAt: r.fetchedAt
    })).sort((a, b) => String(a.closeAt || "").localeCompare(String(b.closeAt || "")));
    return new Response(JSON.stringify({ ok: true, model: state.model, collector: state.collector, races, journal: state.journal.slice(-100) }), { headers });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: String(error?.message || error) }), { status: 500, headers });
  }
};
