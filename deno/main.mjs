import { blankState, normaliseState } from "../cloudflare/state.mjs";
import { statePayload, updateState } from "../cloudflare/worker.mjs";

const kv = await Deno.openKv();
const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: jsonHeaders });

const META_KEY = ["autorace", "state-meta"];
const CHUNK_BYTES = 60_000;

async function gzipText(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipText(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

async function load() {
  const meta = (await kv.get(META_KEY)).value;
  if (meta?.version && Number(meta.count) > 0) {
    const chunks = [];
    let size = 0;
    for (let i = 0; i < Number(meta.count); i++) {
      const chunk = (await kv.get(["autorace", "state-chunk", meta.version, i])).value;
      if (!(chunk instanceof Uint8Array)) throw new Error(`学習データの分割 ${i + 1}/${meta.count} が見つかりません`);
      chunks.push(chunk);
      size += chunk.length;
    }
    const packed = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { packed.set(chunk, offset); offset += chunk.length; }
    return normaliseState(JSON.parse(await gunzipText(packed)));
  }
  const legacy = (await kv.get(["autorace", "state"])).value;
  return legacy ? normaliseState(legacy) : blankState();
}

async function save(state) {
  const packed = await gzipText(JSON.stringify(normaliseState(state)));
  const version = crypto.randomUUID();
  const count = Math.ceil(packed.length / CHUNK_BYTES);
  for (let i = 0; i < count; i++) {
    await kv.set(["autorace", "state-chunk", version, i], packed.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
  }
  const previous = (await kv.get(META_KEY)).value;
  await kv.set(META_KEY, { version, count, bytes: packed.length, savedAt: new Date().toISOString() });
  if (previous?.version && previous.version !== version) {
    for (let i = 0; i < Number(previous.count || 0); i++) await kv.delete(["autorace", "state-chunk", previous.version, i]);
  }
}

async function collect(mode = "scheduled") {
  const out = await updateState(await load(), mode);
  await save(out.state);
  return out.response;
}

Deno.cron("autorace-15min-update-pdca", "*/15 * * * *", {
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
