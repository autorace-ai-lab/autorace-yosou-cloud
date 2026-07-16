import * as cheerio from "cheerio";

export const WT = "https://www.winticket.jp";
export const VENUE_SLUGS = ["kawaguchi", "isesaki", "hamamatsu", "iizuka", "sanyo"];
const SLUG_ID = { kawaguchi: "kawaguchi", isesaki: "isesaki", hamamatsu: "hamamatsu", iizuka: "iizuka", sanyo: "sanyou" };

export async function fetchText(url, timeoutMs = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; AutoracePredictionResearch/1.0)",
        "accept-language": "ja,en;q=0.8",
        accept: "text/html,application/xhtml+xml"
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}

export const raceKey = r => `${r.slug}|${r.cup}|${Number(r.day)}|${Number(r.r)}`;
export const raceUrl = r => `${WT}/autorace/${r.slug}/racecard/${r.cup}/${r.day}/${r.r}`;
export const resultUrl = r => `${WT}/autorace/${r.slug}/raceresult/${r.cup}/${r.day}/${r.r}`;

export function parseIndex(html) {
  const out = [], seen = new Set();
  const rx = /\/autorace\/([a-z]+)\/racecard\/(\d{8,12})\/(\d+)\/(\d+)/g;
  for (const m of html.matchAll(rx)) {
    if (!SLUG_ID[m[1]]) continue;
    const race = { slug: m[1], venue: SLUG_ID[m[1]], cup: m[2], day: +m[3], r: +m[4] };
    race.key = raceKey(race);
    if (!seen.has(race.key)) { seen.add(race.key); out.push(race); }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug) || a.r - b.r);
}

const cellsOf = ($, tr) => $(tr).find("td,th").map((_, c) => $(c).text().replace(/\s+/g, " ").trim()).get();

function parseRow(cells) {
  const num = parseInt(cells[0], 10);
  if (!(num >= 1 && num <= 8)) return null;
  let handi = null, st = null, shiso = null, hensa = null, grade = null;
  let rank = null, shinsa = null, shisoIdx = -1, name = null;
  cells.forEach((cell, idx) => {
    if (handi == null) {
      const m = cell.match(/^(\d{1,3})\s*m\s*(-?\d\.\d{1,3})?$/);
      if (m) { handi = +m[1]; if (m[2]) st = +m[2]; return; }
    }
    if (shiso == null) {
      const m = cell.match(/^(\d\.\d{2})\s*(-?\d\.\d{2,3})?$/);
      if (m && +m[1] >= 2.8 && +m[1] <= 4.6) {
        shiso = +m[1]; shisoIdx = idx; if (m[2]) hensa = +m[2]; return;
      }
    }
    if (grade == null) {
      const m = cell.match(/(\d{1,3}\.\d{1,3})?\s*([SAB])\s*-\s*(\d+)/);
      if (m) { if (m[1]) shinsa = +m[1]; grade = m[2]; rank = +m[3]; }
    }
  });
  if (shiso == null) return null;
  const rest = cells.slice(shisoIdx + 1);
  const times = rest.filter(x => /^\d\.\d{2,3}$/.test(x)).map(Number).filter(x => x >= 2.8 && x <= 4.6);
  const pcts = rest.filter(x => /^\d{1,3}(\.\d)?%$/.test(x)).map(x => parseFloat(x) / 100);
  const nc = cells.find(x => /^[\u4E00-\u9FFF\u3040-\u30FF・ー]{2,}/.test(x));
  if (nc) name = nc.match(/^([\u4E00-\u9FFF\u3040-\u30FF・ー]{2,12})/)?.[1] || null;
  return {
    num, name: name || `${num}号車`, grade: grade || "A", handi: handi ?? 0,
    shiso, hensa, st, shinsa, rank, win: shinsa == null ? null : 5.5 + (shinsa - 60) * 0.05,
    avgShiso: times.length >= 2 ? times[0] : null,
    avgRace: times.length >= 2 ? times[1] : null,
    bestRace: times.length >= 3 ? times[2] : null,
    rate90_3: pcts.length >= 2 ? pcts[1] : null,
    rate3good: pcts.length >= 4 ? pcts[3] : null,
    rate3wet: pcts.length >= 6 ? pcts[5] : null,
    recentMean: null, f: 0
  };
}

function attachRecord(cells, car) {
  const rec = cells.find(x => /^\d{1,2}-\d{1,2}-\d{1,2}-\d{1,3}$/.test(x));
  if (!rec || !car) return;
  const [a, b, c, d] = rec.split("-").map(Number), n = a + b + c + d;
  if (n) car.recentMean = (a + 2 * b + 3 * c + 6 * d) / n;
}

export function parseCard(html, race) {
  const $ = cheerio.load(html), cars = [];
  let last = null;
  $("tr").each((_, tr) => {
    const cells = cellsOf($, tr), car = parseRow(cells);
    if (car && !cars.some(x => x.num === car.num)) { cars.push(car); last = car; }
    else attachRecord(cells, last);
  });
  const text = $.root().text().replace(/\s+/g, " ");
  const close = text.match(/締切\s*(\d{1,2}:\d{2})/)?.[1] || null;
  const road = text.match(/(良走路|湿走路|斑走路)/)?.[1];
  const cond = road === "湿走路" ? "wet" : road === "斑走路" ? "mudd" : "good";
  const dm = text.match(/([\d,]{3,6})\s*m\s*\(\s*(\d+)\s*周/);
  const date = text.match(/(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  let closeAt = null;
  if (close) {
    const ymd = date ? `${date[1]}-${String(date[2]).padStart(2, "0")}-${String(date[3]).padStart(2, "0")}`
      : `${race.cup.slice(0, 4)}-${race.cup.slice(4, 6)}-${race.cup.slice(6, 8)}`;
    closeAt = new Date(`${ymd}T${close}:00+09:00`).toISOString();
  }
  return {
    ...race, key: raceKey(race), cars: cars.sort((a, b) => a.num - b.num), cond,
    close, closeAt, dist: dm ? +dm[1].replace(/,/g, "") : 3100,
    laps: dm ? +dm[2] : null, sourceUrl: raceUrl(race), fetchedAt: new Date().toISOString()
  };
}

export function parseResult(html, race) {
  const $ = cheerio.load(html);
  const text = $.root().text().replace(/\s+/g, " ");
  const embedded = html.match(/"trifectaWinningOddsIds":\["([^"]*:2:([1-8])\.([1-8])\.([1-8]))"/);
  if (embedded) {
    const escaped = embedded[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const payoff = html.match(new RegExp(`"id":"${escaped}"[^}]{0,700}"payoffUnitPrice":(\\d+)`));
    const trifecta = [Number(embedded[2]), Number(embedded[3]), Number(embedded[4])];
    return {
      key: raceKey(race), trifecta, combination: trifecta.join("-"),
      payout: Number(payoff?.[1] || 0), sourceUrl: resultUrl(race),
      fetchedAt: new Date().toISOString()
    };
  }
  const patterns = [
    /3\s*連\s*単[^0-9]{0,30}([1-8])\s*[-－→]\s*([1-8])\s*[-－→]\s*([1-8])[^0-9]{0,30}([\d,]{2,10})\s*円/,
    /([1-8])\s*[-－→]\s*([1-8])\s*[-－→]\s*([1-8])[^\d]{0,20}([\d,]{2,10})\s*円[^\n]{0,80}3\s*連\s*単/
  ];
  let m = null;
  for (const p of patterns) { m = text.match(p); if (m) break; }
  if (!m) return null;
  const trifecta = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (new Set(trifecta).size !== 3) return null;
  return {
    key: raceKey(race), trifecta, combination: trifecta.join("-"),
    payout: Number(m[4].replace(/,/g, "")), sourceUrl: resultUrl(race),
    fetchedAt: new Date().toISOString()
  };
}

export async function mapLimit(items, limit, worker) {
  const result = new Array(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try { result[i] = await worker(items[i], i); }
      catch (error) { result[i] = { error: String(error?.message || error) }; }
    }
  }));
  return result;
}
