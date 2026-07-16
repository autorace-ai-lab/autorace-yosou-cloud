import { blankState, normaliseState } from "../cloudflare/state.mjs";
import { statePayload, updateState } from "../cloudflare/worker.mjs";

const kv = await Deno.openKv();
const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: jsonHeaders });

async function load() {
  const value = (await kv.get(["autorace", "state"])).value;
  return value ? normaliseState(value) : blankState();
}

async function save(state) {
  await kv.set(["autorace", "state"], normaliseState(state));
}

async function collect(mode = "scheduled") {
  const out = await updateState(await load(), mode);
  await save(out.state);
  return out.response;
}

Deno.cron("オートレース15分自動更新・PDCA", "*/15 * * * *", {
  backoffSchedule: [30_000, 120_000, 300_000]
}, async () => { await collect("scheduled"); });

Deno.serve(async request => {
  const url = new URL(request.url);
  if (url.pathname === "/.netlify/functions/state" || url.pathname === "/api/state") {
    try { return json(statePayload(await load())); }
    catch (error) { return json({ ok:false, error:String(error?.message || error) }, 500); }
  }
  if (url.pathname === "/.netlify/functions/collect-and-train" || url.pathname === "/api/collect-and-train") {
    try { return json(await collect(url.searchParams.get("mode") || "current")); }
    catch (error) { return json({ ok:false, error:String(error?.message || error) }, 500); }
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(html, { headers: { "content-type":"text/html; charset=utf-8", "cache-control":"no-cache" } });
  }
  return new Response("Not Found", { status:404 });
});
