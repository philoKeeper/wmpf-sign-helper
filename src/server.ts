import { WebSocketServer, WebSocket } from "ws";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

const req = createRequire(import.meta.url);
const HERE = path.dirname(path.resolve(process.argv[1]));
const codex = req(path.join(HERE, "third-party/RemoteDebugCodex.js"));
const messageProto = req(path.join(HERE, "third-party/WARemoteDebugProtobuf.js"));

const DEBUG_PORT = Number(process.env.WMPF_DEBUG_PORT || 9421);
const CDP_PORT = Number(process.env.WMPF_CDP_PORT || 62000);
const HTTP_PORT = Number(process.env.WMPF_HTTP_PORT || 62010);

const log = (...a: any[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const toCdp: Array<(m: string) => void> = [];
let messageCounter = 0;
let activeMiniapp: WebSocket | null = null;
const pending: string[] = [];
const inflight = new Map<number, (m: any) => void>();
let cdpSeq = 1;

function encodeCdp(text: string) {
  const wrapped = codex.wrapDebugMessageData(
    { jscontext_id: "", op_id: Math.round(100 * Math.random()), payload: text },
    "chromeDevtools", 0);
  return messageProto.mmbizwxadevremote.WARemoteDebug_DebugMessage.encode({
    seq: ++messageCounter, category: "chromeDevtools", data: wrapped.buffer,
    compressAlgo: 0, originalSize: wrapped.originalSize,
  }).finish();
}

function rawSend(text: string): boolean {
  const t = activeMiniapp;
  if (!t || t.readyState !== WebSocket.OPEN) return false;
  t.send(encodeCdp(text), { binary: true });
  return true;
}

function sendToMiniapp(text: string): boolean {
  if (rawSend(text)) return true;
  pending.push(text);
  if (pending.length > 50) pending.shift();
  return false;
}

const debugWss = new WebSocketServer({ port: DEBUG_PORT });
log("[server] debug ws://localhost:" + DEBUG_PORT);

debugWss.on("connection", (ws) => {
  for (const other of debugWss.clients) { if (other !== ws) { try { other.close(); } catch {} } }
  activeMiniapp = ws;
  cachedCtx = 0;
  log("[miniapp] connected" + (pending.length ? " (flush " + pending.length + ")" : ""));
  while (pending.length) {
    const text = pending.shift()!;
    if (!rawSend(text)) { pending.unshift(text); break; }
  }
  ws.on("message", (data: Buffer) => {
    let unwrapped: any = null;
    try {
      const decoded = messageProto.mmbizwxadevremote.WARemoteDebug_DebugMessage.decode(data);
      unwrapped = codex.unwrapDebugMessageData(decoded);
    } catch (e) { log("[miniapp] decode error", String(e).slice(0, 100)); return; }
    if (!unwrapped || unwrapped.category !== "chromeDevtoolsResult") return;
    const payload = String(unwrapped.data.payload);
    let obj: any = null;
    try { obj = JSON.parse(payload); } catch {}
    if (obj && typeof obj.id === "number" && inflight.has(obj.id)) {
      const fn = inflight.get(obj.id)!; inflight.delete(obj.id); fn(obj);
    }
    for (const fn of [...toCdp]) fn(payload);
  });
  ws.on("close", () => {
    if (activeMiniapp === ws) activeMiniapp = null;
    cachedCtx = 0;
    log("[miniapp] disconnected");
  });
});

let cachedCtx = 0;

function cdpEval(expression: string, contextId?: number, timeoutMs = 6000): Promise<any> {
  return new Promise((resolve) => {
    if (!activeMiniapp) { resolve({ ok: false, error: "小程序未连接" }); return; }
    const id = ++cdpSeq;
    const params: any = { expression, returnByValue: true, awaitPromise: true };
    if (contextId) params.contextId = contextId;
    const timer = setTimeout(() => {
      inflight.delete(id);
      resolve({ ok: false, error: "执行超时（小程序可能正在重连，再试一次）" });
    }, timeoutMs);
    inflight.set(id, (msg: any) => {
      clearTimeout(timer);
      if (msg.error) { resolve({ ok: false, error: msg.error.message || "CDP 错误" }); return; }
      const r = msg.result || {};
      if (r.exceptionDetails) {
        const d = r.exceptionDetails.exception || {};
        resolve({ ok: false, error: d.description || "JS 异常" });
        return;
      }
      resolve({ ok: true, value: r.result ? r.result.value : undefined });
    });
    if (!sendToMiniapp(JSON.stringify({ id, method: "Runtime.evaluate", params }))) {
      clearTimeout(timer);
      inflight.delete(id);
      resolve({ ok: false, error: "小程序未连接" });
    }
  });
}

async function detectContext(): Promise<number> {
  const order = [4, 3, 5, 6, 2, 7, 8, 1, 9, 10, 11, 12];
  for (const cid of order) {
    const r = await cdpEval("typeof wx + String.fromCharCode(124) + (typeof getCurrentPages)", cid, 2500);
    if (r.ok && typeof r.value === "string" && r.value.indexOf("object") === 0 && r.value.indexOf("function") > 0) return cid;
  }
  return 0;
}

async function getCtx(): Promise<number> {
  if (cachedCtx) return cachedCtx;
  cachedCtx = await detectContext();
  return cachedCtx;
}

const HOOK_SRC = [
  "(function(){",
  "  if (globalThis.__posHooked) return \"ok\";",
  "  globalThis.__posHooked = 1;",
  "  globalThis.__cdpLog = globalThis.__cdpLog || [];",
  "  var L = globalThis.__cdpLog;",
  "  function fake(kind){",
  "    var f = globalThis.__FAKE_POS;",
  "    if (!f) return null;",
  "    if (kind === \"choose\") return {name: f.name || \"目标位置\", address: f.address || \"目标位置\", latitude: f.latitude, longitude: f.longitude};",
  "    return {latitude: f.latitude, longitude: f.longitude, speed: 0, accuracy: 10, altitude: 0, verticalAccuracy: 10, horizontalAccuracy: 10};",
  "  }",
  "  [\"getLocation\",\"getFuzzyLocation\",\"getCurrentLocation\",\"chooseLocation\"].forEach(function(k){",
  "    var orig = wx[k];",
  "    if (typeof orig !== \"function\") return;",
  "    wx[k] = function(o){",
  "      o = o || {};",
  "      var ps = (typeof getCurrentPages === \"function\") ? getCurrentPages() : [];",
  "      L.push({api: k, route: (ps[ps.length-1]||{}).route, fake: !!globalThis.__FAKE_POS, t: Date.now()});",
  "      var res = fake(k === \"chooseLocation\" ? \"choose\" : \"get\");",
  "      if (res) {",
  "        setTimeout(function(){",
  "          try { if (typeof o.success === \"function\") o.success(res); } catch(e){}",
  "          try { if (typeof o.complete === \"function\") o.complete(res); } catch(e){}",
  "        }, 20);",
  "        return;",
  "      }",
  "      return orig.apply(this, arguments);",
  "    };",
  "  });",
  "  return \"ok\";",
  "})()"
].join("\n");

const STATE_SRC = [
  "(function(){",
  "  var ps = getCurrentPages();",
  "  var p = ps[ps.length - 1] || {};",
  "  var q = (p.data || {}).qddata || {};",
  "  var a = (q.addr && q.addr[0]) || null;",
  "  return JSON.stringify({",
  "    route: p.route || \"\", stack: ps.map(function(x){return x.route}),",
  "    hooked: !!globalThis.__posHooked, fakePos: globalThis.__FAKE_POS || null,",
  "    title: q.title || \"\", status: (q.status === undefined ? null : q.status),",
  "    startDate: q.startDate || \"\", endDate: q.endDate || \"\",",
  "    addr: a ? {name: a.name, latitude: a.latitude, longitude: a.longitude, radius: a.radius} : null,",
  "    items: (q.itemlist || []).map(function(i){return {text: i.text, value: i.value}}),",
  "    log: (globalThis.__cdpLog || []).slice(-5)",
  "  });",
  "})()"
].join("\n");

async function ensureHook(): Promise<number> {
  let cid = await getCtx();
  if (!cid) return 0;
  await cdpEval(HOOK_SRC, cid, 5000);
  return cid;
}

// ---------------- CDP 代理（给命令行工具用） ----------------
const cdpWss = new WebSocketServer({ port: CDP_PORT });
log("[cdp] proxy ws://localhost:" + CDP_PORT);

cdpWss.on("connection", (ws) => {
  log("[cdp] client connected");
  const fn = (msg: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); };
  toCdp.push(fn);
  ws.on("message", (data: Buffer) => { sendToMiniapp(data.toString()); });
  ws.on("close", () => {
    const i = toCdp.indexOf(fn); if (i >= 0) toCdp.splice(i, 1);
    log("[cdp] client disconnected");
  });
});

// ---------------- 本地网页控制台 ----------------
const INDEX_HTML = fs.readFileSync(path.join(HERE, "public", "index.html"), "utf8");

const json = (res: http.ServerResponse, code: number, obj: any) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
};

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = url.pathname;

  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(INDEX_HTML);
    return;
  }

  if (pathname === "/api/state") {
    if (!activeMiniapp) { json(res, 200, { ok: true, miniapp: false }); return; }
    const cid = await ensureHook();
    if (!cid) { json(res, 200, { ok: true, miniapp: true, ctx: 0, error: "找不到小程序逻辑层" }); return; }
    const raw = await cdpEval(STATE_SRC, cid, 6000);
    if (!raw.ok) { json(res, 200, { ok: false, miniapp: true, ctx: cid, error: raw.error }); return; }
    let state: any = {};
    try { state = JSON.parse(raw.value); } catch {}
    json(res, 200, { ok: true, miniapp: true, ctx: cid, state });
    return;
  }

  if (pathname === "/api/here" && req.method === "POST") {
    const cid = await ensureHook();
    if (!cid) { json(res, 200, { ok: false, error: "小程序未连接" }); return; }
    const raw = await cdpEval([
      "(function(){"
      ,"  var ps = getCurrentPages();"
      ,"  var p = ps[ps.length - 1] || {};"
      ,"  var q = (p.data || {}).qddata || {};"
      ,"  var a = (q.addr && q.addr[0]) || null;"
      ,"  if (!a) return JSON.stringify({ok:false, error:\"当前页面没有签到点，请先进入签到页\"});"
      ,"  globalThis.__FAKE_POS = {latitude: a.latitude, longitude: a.longitude, accuracy: 10, name: a.name};"
      ,"  return JSON.stringify({ok:true, pos: globalThis.__FAKE_POS, radius: a.radius});"
      ,"})()"
    ].join("\n"), cid, 6000);
    if (!raw.ok) { json(res, 200, { ok: false, error: raw.error }); return; }
    let out: any = {};
    try { out = JSON.parse(raw.value); } catch { out = { ok: false, error: "解析失败" }; }
    json(res, 200, out);
    return;
  }

  if (pathname === "/api/set" && req.method === "POST") {
    const lat = Number(url.searchParams.get("lat"));
    const lng = Number(url.searchParams.get("lng"));
    if (!isFinite(lat) || !isFinite(lng)) { json(res, 400, { ok: false, error: "坐标不合法" }); return; }
    const cid = await ensureHook();
    if (!cid) { json(res, 200, { ok: false, error: "小程序未连接" }); return; }
    const expr = "globalThis.__FAKE_POS={latitude:" + lat + ",longitude:" + lng + ",accuracy:10}; JSON.stringify({ok:true,pos:globalThis.__FAKE_POS})";
    const raw = await cdpEval(expr, cid, 6000);
    if (!raw.ok) { json(res, 200, { ok: false, error: raw.error }); return; }
    let out: any = {};
    try { out = JSON.parse(raw.value); } catch {}
    json(res, 200, out);
    return;
  }

  if (pathname === "/api/clear" && req.method === "POST") {
    const cid = await ensureHook();
    if (!cid) { json(res, 200, { ok: false, error: "小程序未连接" }); return; }
    await cdpEval("try{delete globalThis.__FAKE_POS}catch(e){}; \"ok\"", cid, 4000);
    json(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/check" && req.method === "POST") {
    const cid = await ensureHook();
    if (!cid) { json(res, 200, { ok: false, error: "小程序未连接" }); return; }
    const expr = [
      "(async function(){"
      ,"  var ps = getCurrentPages();"
      ,"  var p = ps[ps.length - 1] || {};"
      ,"  var q = (p.data || {}).qddata || {};"
      ,"  var a = (q.addr && q.addr[0]) || null;"
      ,"  var loc = await new Promise(function(res){ wx.getLocation({type:\"gcj02\",success:function(r){res(r)},fail:function(e){res({err:e})}}); setTimeout(function(){res({err:\"timeout\"})},5000); });"
      ,"  function dist(la1,lo1,la2,lo2){var R=6371000,rad=Math.PI/180;var dLa=(la2-la1)*rad,dLo=(lo2-lo1)*rad;var s=Math.sin(dLa/2)*Math.sin(dLa/2)+Math.cos(la1*rad)*Math.cos(la2*rad)*Math.sin(dLo/2)*Math.sin(dLo/2);return Math.round(2*R*Math.asin(Math.sqrt(s)));}"
      ,"  var out = {loc: loc};"
      ,"  if (a && loc && typeof loc.latitude === \"number\") out.distance = dist(loc.latitude, loc.longitude, a.latitude, a.longitude);"
      ,"  if (a) out.radius = a.radius;"
      ,"  return JSON.stringify(out);"
      ,"})()"
    ].join("\n");
    const raw = await cdpEval(expr, cid, 12000);
    if (!raw.ok) { json(res, 200, { ok: false, error: raw.error }); return; }
    let out: any = {};
    try { out = JSON.parse(raw.value); } catch { out = { ok: false, error: "解析失败" }; }
    json(res, 200, { ok: true, ...out });
    return;
  }

  json(res, 404, { ok: false, error: "not found" });
});

httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
  log("[ui] 控制台 http://127.0.0.1:" + HTTP_PORT);
});