#!/usr/bin/env node
/** Native Chromium P1-008 hardening evidence capture. */
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HEADLESS_SHELL = "/headless-shell/headless-shell";
const AXE_SOURCE = join(ROOT, "v2/node_modules/axe-core/axe.min.js");
const UPSTREAM = { host: "127.0.0.1", port: 8001 };
const CAPTURE_USER = "songs-v2-p1-008-capture";
const DATABASE = "songs-v2";
const SET_SLUG = "2025-10-13-9tease-stripped";
const SONG_SLUG = "1979";
const PROFILES = Object.freeze([
  { name: "desktop", width: 1280, height: 900, dpr: 1, mobile: false, touch: false },
  { name: "tablet-portrait", width: 1024, height: 1366, dpr: 1, mobile: false, touch: true },
  { name: "tablet-landscape", width: 1366, height: 1024, dpr: 1, mobile: false, touch: true },
  { name: "phone", width: 390, height: 844, dpr: 3, mobile: true, touch: true },
]);

const ROUTES = Object.freeze([
  ["dashboard", "#/", /Your gig book, without the edit controls|Active Set List/],
  ["songs", "#/songs", /^Songs$/],
  ["song-1979", "#/songs/1979", /^1979$/],
  ["sets", "#/sets", /^Set Lists$/],
  ["set-detail", `#/sets/${SET_SLUG}`, /9Tease Stripped/i],
  ["set-live", `#/sets/${SET_SLUG}/live`, /Plush|9Tease Stripped|Locked Live/],
  ["status", "#/status", /^Snapshot status$/],
]);
const INVALID_HASHES = ["#/no-such-route", "#/songs/%", `#/sets/${SET_SLUG}/live/extra`, `#/sets/${SET_SLUG}/live?unexpected=1`, "#https://example.test/sets/foo/live"];

function required(condition, message) { if (!condition) throw new Error(message); }
function sleep(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}
function canonicalJson(value) { return `${JSON.stringify(canonicalize(value), null, 2)}\n`; }
function usage() { return "Usage: node scripts/capture_v2_phase1_hardening_evidence.mjs [--check] [--port PORT]\n"; }
function parseArguments(argv) {
  let check = false; let port = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--check") check = true;
    else if (value === "--help" || value === "-h") { process.stdout.write(usage()); process.exit(0); }
    else if (value === "--port") port = Number(argv[++i]);
    else if (value.startsWith("--port=")) port = Number(value.slice(7));
    else throw new Error(`unknown argument: ${value}`);
  }
  required(Number.isInteger(port) && port >= 0 && port <= 65535, "--port must be an integer from 0 through 65535");
  return { check, port };
}

async function readReviewedInputs() {
  const bootstrapRaw = await readFile(join(ROOT, "internal/v2bootstrap/data/manifest.json"));
  const shellRaw = await readFile(join(ROOT, "internal/v2shell/data/asset-manifest.json"));
  const bootstrap = JSON.parse(bootstrapRaw); const shell = JSON.parse(shellRaw);
  required(bootstrap.schema_version === "1" && bootstrap.kind === "songs-v2.bootstrap.manifest", "bootstrap manifest schema drift");
  required(shell.schema_version === "1" && shell.kind === "songs-v2.shell.assets", "shell asset manifest schema drift");
  required(shell.release.startsWith("shell-") && /^[a-f0-9]{24}$/.test(shell.release.slice(6)), "shell release is not a reviewed release identity");
  required(shell.bootstrap_manifest_sha256 === sha256(bootstrapRaw), "shell/bootstrap binding drift");
  required(Array.isArray(shell.accepted_bootstrap_manifest_sha256) && shell.accepted_bootstrap_manifest_sha256.includes(sha256(bootstrapRaw)), "shell compatibility drift");
  required(shell.cache_prefix === "songs-v2-shell-" && shell.indexeddb_name === DATABASE, "shell namespace drift");
  return { bootstrap, shell, bootstrapHash: sha256(bootstrapRaw), shellHash: sha256(shellRaw) };
}

async function startProxy(requestedPort) {
  const server = createServer((incoming, outgoing) => {
    const headers = { ...incoming.headers, host: `${UPSTREAM.host}:${UPSTREAM.port}`, "x-exedev-userid": CAPTURE_USER, "x-forwarded-proto": "https", "x-forwarded-host": incoming.headers.host ?? "127.0.0.1", "x-forwarded-for": "127.0.0.1" };
    delete headers.authorization;
    const upstream = httpRequest({ host: UPSTREAM.host, port: UPSTREAM.port, method: incoming.method, path: incoming.url, headers }, (response) => { outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, response.headers); response.pipe(outgoing); });
    upstream.on("error", (error) => { if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "text/plain" }); outgoing.end(`capture upstream unavailable: ${error.message}`); });
    incoming.on("aborted", () => upstream.destroy()); incoming.pipe(upstream);
  });
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: requestedPort }, resolvePromise); });
  const address = server.address(); required(address && typeof address !== "string", "proxy did not bind");
  return { origin: `http://127.0.0.1:${address.port}`, async close() { if (!server.listening) return; server.closeAllConnections?.(); await new Promise((resolvePromise) => server.close(() => resolvePromise())); } };
}

function httpStatus(origin, path) {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(`${origin}${path}`, { headers: { "x-exedev-userid": CAPTURE_USER } }, (response) => { response.resume(); response.once("end", () => resolvePromise(response.statusCode ?? 0)); });
    request.on("error", reject); request.end();
  });
}
async function waitDevTools(profile, child) {
  const file = join(profile, "DevToolsActivePort"); const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`headless-shell exited (${child.exitCode})`);
    try { const lines = (await readFile(file, "utf8")).trim().split(/\r?\n/); if (/^\d+$/.test(lines[0]) && lines[1]) return { port: Number(lines[0]), path: lines[1] }; } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await sleep(50);
  }
  throw new Error("timed out waiting for headless-shell CDP");
}
async function launchBrowser(profile, config) {
  required(existsSync(HEADLESS_SHELL), `missing ${HEADLESS_SHELL}`);
  const child = spawn(HEADLESS_SHELL, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-sync", "--metrics-recording-only", "--disable-dev-shm-usage", "--hide-scrollbars", `--window-size=${config.width},${config.height}`, `--force-device-scale-factor=${config.dpr}`], { stdio: ["ignore", "ignore", "ignore"] });
  try { return { child, endpoint: await waitDevTools(profile, child) }; } catch (error) { await stopBrowser(child); throw error; }
}
async function stopBrowser(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM"); const exited = await Promise.race([new Promise((resolvePromise) => child.once("exit", resolvePromise)), sleep(3000).then(() => false)]);
  if (exited === false && child.exitCode === null) { child.kill("SIGKILL"); await new Promise((resolvePromise) => child.once("exit", resolvePromise)); }
}

class CdpConnection {
  #socket; #nextId = 1; #pending = new Map(); #listeners = new Set();
  static async connect(url) { const connection = new CdpConnection(); await connection.#open(url); return connection; }
  async #open(url) {
    this.#socket = new WebSocket(url);
    await new Promise((resolvePromise, reject) => { const timeout = setTimeout(() => reject(new Error("CDP connect timeout")), 10000); this.#socket.addEventListener("open", () => { clearTimeout(timeout); resolvePromise(); }, { once: true }); this.#socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("CDP connect failed")); }, { once: true }); });
    this.#socket.addEventListener("message", (event) => { let message; try { message = JSON.parse(String(event.data)); } catch { return; } if (typeof message.id === "number") { const pending = this.#pending.get(message.id); if (!pending) return; this.#pending.delete(message.id); clearTimeout(pending.timeout); message.error ? pending.reject(new Error(`CDP ${pending.method}: ${message.error.message ?? "unknown"}`)) : pending.resolve(message.result ?? {}); } else for (const listener of this.#listeners) listener(message); });
    this.#socket.addEventListener("close", () => { for (const pending of this.#pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error("CDP closed")); } this.#pending.clear(); });
  }
  onEvent(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  send(method, params = {}, sessionId) { const id = this.#nextId++; return new Promise((resolvePromise, reject) => { const timeout = setTimeout(() => { this.#pending.delete(id); reject(new Error(`CDP ${method} timeout`)); }, 30000); this.#pending.set(id, { method, resolve: resolvePromise, reject, timeout }); this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) })); }); }
  close() { this.#socket?.close(); }
}

const INSTRUMENTATION = `(() => { const state = globalThis.__p1008 = globalThis.__p1008 || {fetch: [], xhr: [], readyAt: 0}; const originalFetch = globalThis.fetch; globalThis.fetch = function(...args) { state.fetch.push(String(args[0]?.url || args[0] || "")); return originalFetch.apply(this,args); }; const open = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function(method,url,...rest) { state.xhr.push(String(url)); return open.call(this,method,url,...rest); }; })();`;
async function attachPage(cdp, config) {
  const target = await cdp.send("Target.createTarget", { url: "about:blank" }); const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true }); const session = attached.sessionId;
  await Promise.all([cdp.send("Page.enable", {}, session), cdp.send("Runtime.enable", {}, session), cdp.send("Network.enable", {}, session)]);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: config.width, height: config.height, deviceScaleFactor: config.dpr, mobile: config.mobile, screenWidth: config.width, screenHeight: config.height }, session);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: config.touch, maxTouchPoints: config.touch ? 5 : 1 }, session);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] }, session);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENTATION }, session);
  return session;
}
async function evaluate(cdp, session, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, session);
  if (result.exceptionDetails) throw new Error(`page evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "unknown"}`);
  return result.result?.value;
}
async function waitUntil(label, condition, timeout = 30000) { const deadline = Date.now() + timeout; let last; while (Date.now() < deadline) { try { const value = await condition(); if (value) return value; } catch (error) { last = error; } await sleep(75); } throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ""}`); }
async function navigate(cdp, session, url) { await cdp.send("Page.navigate", { url }, session); await sleep(100); }
async function waitRoute(cdp, session, titlePattern, timeout = 30000) { return waitUntil("route", async () => { const route = await evaluate(cdp, session, `(() => ({ heading: document.querySelector('[data-page-heading]')?.textContent?.trim() || document.querySelector('h1')?.textContent?.trim() || document.querySelector('h2')?.textContent?.trim() || '', ready: document.readyState === 'complete', live: Boolean(document.querySelector('[data-live-locked]')) }))()`); return route.ready && titlePattern.test(route.heading) ? route : false; }, timeout); }
async function resetInstrumentation(cdp, session) { return evaluate(cdp, session, `(() => { const s=globalThis.__p1008 ||= {fetch:[],xhr:[],readyAt:0}; s.fetch=[]; s.xhr=[]; s.readyAt=performance.now(); return true; })()`); }
async function instrumentation(cdp, session) { return evaluate(cdp, session, `(() => ({ fetch: [...(globalThis.__p1008?.fetch||[])], xhr: [...(globalThis.__p1008?.xhr||[])] }))()`); }

class NetworkRecorder {
  #items = []; #byId = new Map();
  constructor(cdp, session) { this.unsubscribe = cdp.onEvent((event) => { if (event.sessionId !== session) return; if (event.method === "Network.requestWillBeSent") { const p = event.params; const item = { url: p.request.url, method: p.request.method, type: p.type ?? null, status: null, from_service_worker: false }; this.#items.push(item); this.#byId.set(p.requestId, item); } else if (event.method === "Network.responseReceived") { const item = this.#byId.get(event.params.requestId); if (item) { item.status = event.params.response.status; item.from_service_worker = event.params.response.fromServiceWorker === true; } } }); }
  reset() { this.#items = []; this.#byId.clear(); }
  all() { return this.#items.map((item) => ({ ...item })); }
  api() { return this.all().filter((item) => new URL(item.url).pathname.startsWith("/api/v2/")); }
  close() { this.unsubscribe(); }
}

const STATE_EXPRESSION = `(() => (async () => { const req=r=>new Promise((res,rej)=>{r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error||new Error('IDB'))}); const db=await new Promise((res,rej)=>{const q=indexedDB.open('songs-v2');q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)}); let pointer=null; try { const tx=db.transaction(['meta','chunks','documents'],'readonly'); const [a,t,chunks,documents]=await Promise.all([req(tx.objectStore('meta').get('active-generation')),req(tx.objectStore('meta').get('pointer-transitions')),req(tx.objectStore('chunks').count()),req(tx.objectStore('documents').count())]);pointer={active:a?.value??null,transitions:t?.value??null,chunks,documents,stores:[...db.objectStoreNames].sort(),version:db.version}; } finally { db.close(); } const reg=await navigator.serviceWorker.getRegistration(); const ready=reg?await navigator.serviceWorker.ready:null; let compatibility=null; const worker=navigator.serviceWorker.controller||ready?.active; if(worker){ compatibility=await new Promise(resolve=>{const ch=new MessageChannel();const timer=setTimeout(()=>resolve(null),1500);ch.port1.onmessage=e=>{clearTimeout(timer);resolve(e.data)};worker.postMessage({type:'GET_COMPATIBILITY'},[ch.port2])}); } return { pointer, database_names: typeof indexedDB.databases==='function' ? (await indexedDB.databases()).map(x=>x.name).filter(Boolean).sort() : [], service_worker:{state:ready?.active?.state??null,controlled:Boolean(navigator.serviceWorker.controller),scope:ready?.scope??null,script_url:ready?.active?.scriptURL??null,compatibility}, cache_names:(await caches.keys()).sort() }; })())()`;
async function browserState(cdp, session) { return evaluate(cdp, session, STATE_EXPRESSION); }

const SURFACE_EXPRESSION = `(() => { const rect=e=>{const r=e.getBoundingClientRect();return {width:r.width,height:r.height,top:r.top,left:r.left}}; const controls=[...document.querySelectorAll('a,button,input,select,textarea,[role="button"]')].map(e=>({tag:e.tagName.toLowerCase(),className:e.className||"",name:(e.getAttribute('aria-label')||e.textContent||'').trim().replace(/\\s+/g,' ').slice(0,120),rect:rect(e),disabled:Boolean(e.disabled)})); const links=[...document.querySelectorAll('a')].map(e=>({text:(e.textContent||'').trim().replace(/\\s+/g,' ').slice(0,100),href:e.getAttribute('href'),absolute:e.href})); return {heading:document.querySelector('[data-page-heading]')?.textContent?.trim()||document.querySelector('h1')?.textContent?.trim()||'',headings:[...document.querySelectorAll('h1,h2,h3')].map(e=>e.textContent?.trim()).filter(Boolean),landmarks:[...document.querySelectorAll('header,nav,main,footer,[role="banner"],[role="navigation"],[role="main"]')].map(e=>({tag:e.tagName.toLowerCase(),role:e.getAttribute('role'),label:e.getAttribute('aria-label')})),controls,links,aria_current:[...document.querySelectorAll('[aria-current]')].map(e=>({text:(e.textContent||'').trim(),value:e.getAttribute('aria-current')})),overflow:{innerWidth:innerWidth,scrollWidth:document.documentElement.scrollWidth,bodyScrollWidth:document.body?.scrollWidth||0},mutation_controls:controls.filter(x=>((x.tag==='button'||x.tag==='input'||x.tag==='select'||x.tag==='textarea'||x.tag==='[role="button"]')&&/^(edit|save|add|delete|publish|sync|provider|author|mutation|pin)(?:$|\\s+(?:changes|song|set|entry|draft|content))/i.test(x.name))||/^(Edit|Save|Add|Delete|Publish|Sync|Provider|Author|Mutation|Pin)$/i.test(x.name)),apex_hrefs:[...document.querySelectorAll('[data-authority="apex"] a')].map(e=>e.getAttribute('href')).filter(Boolean),live_columns:[...document.querySelectorAll('[data-live-columns] .live-column')].map(e=>({scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,tabIndex:e.tabIndex}))}; })()`;
async function surface(cdp, session) { return evaluate(cdp, session, SURFACE_EXPRESSION); }
async function axe(cdp, session, source) { await evaluate(cdp, session, `(async()=>{if(!globalThis.axe){${source}\n}; return true})()`); return evaluate(cdp, session, `axe.run(document.body).then(r=>r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.length})))`); }

function assertSurface(record, config, live = false) {
  required(record.overflow.scrollWidth <= config.width && record.overflow.bodyScrollWidth <= config.width, `${config.name}: horizontal document overflow`);
  required(record.landmarks.some(x => x.tag === "main" || x.role === "main") && record.landmarks.some(x => x.tag === "nav" || x.role === "navigation"), `${config.name}: missing landmarks`);
  required(record.headings.length > 0, `${config.name}: missing accessible heading`);
  required(record.mutation_controls.length === 0, `${config.name}: mutation controls exposed (${record.mutation_controls.map(x => x.name).join(", ")})`);
  const minimum = live ? 48 : 44;
  for (const control of record.controls) if ((control.tag !== "a" || /primary-button|clear-button|icon-button|live-launch|locked-live|nav-button|theme-toggle/.test(control.className)) && !control.disabled && control.name !== "Skip to content" && control.rect.width > 0 && control.rect.height > 0) required(control.rect.width >= minimum && control.rect.height >= minimum, `${config.name}: ${live ? "Live" : "normal"} control target too small: ${control.name} ${control.rect.width}x${control.rect.height}`);
  if (!live) required(record.aria_current.some(x => x.value === "page"), `${config.name}: aria-current page missing`);
  for (const href of record.apex_hrefs) required(/^#\/songs\/[A-Za-z0-9._~%-]+$/.test(href), `${config.name}: non-canonical Apex href ${href}`);
}
function assertNoApi(records, label) { required(records.filter(x => new URL(x.url).pathname.startsWith("/api/v2/")).length === 0, `${label}: API requests observed`); }

async function reducedMotion(cdp, session) {
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, session);
  const result = await evaluate(cdp, session, `(() => { const all=[...document.querySelectorAll('*')]; const styles=all.map(e=>getComputedStyle(e)).filter(s=>s.animationName!=='none'||s.transitionProperty!=='all'); return {matches:matchMedia('(prefers-reduced-motion: reduce)').matches, maxAnimationDuration:Math.max(0,...styles.map(s=>parseFloat(s.animationDuration)||0)), maxTransitionDuration:Math.max(0,...styles.map(s=>parseFloat(s.transitionDuration)||0)), cssRule: [...document.styleSheets].flatMap(s=>{try{return [...s.cssRules]}catch{return[]}}).some(r=>r.cssText.includes('prefers-reduced-motion'))}; })()`);
  required(result.matches && result.maxAnimationDuration <= 0.01 && result.maxTransitionDuration <= 0.01 && result.cssRule, `${session}: reduced-motion is not effectively disabled`);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] }, session); return result;
}
async function keyboardLive(cdp, session) {
  const before = await evaluate(cdp, session, `(() => ({progress:document.querySelector('[role="status"]')?.textContent||'',column:document.querySelector('[data-live-columns] .live-column')}))()`);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 }, session); await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 }, session); await sleep(150);
  const after = await evaluate(cdp, session, `(() => ({progress:document.querySelector('[role="status"]')?.textContent||'',heading:document.querySelector('[data-page-heading]')?.textContent||''}))()`);
  required(before.progress !== after.progress, "Live ArrowRight keyboard navigation did not advance occurrence");
  const pageDown = await evaluate(cdp, session, `(() => { const c=document.querySelector('[data-live-columns] .live-column'); if(!c)return {available:false}; c.tabIndex=0;c.focus(); return {available:true,before:c.scrollLeft,active:document.activeElement===c}; })()`);
  if (pageDown.available) { await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 }, session); await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 }, session); await sleep(100); const moved=await evaluate(cdp,session,`(() => {const c=document.querySelector('[data-live-columns] .live-column');return {after:c?.scrollLeft??null,active:document.activeElement===c}})()`); required(moved.active, "focused-column PageDown lost focus"); return {arrow_right:true, focused_column_page_down:true, before:pageDown.before, after:moved.after}; }
  return { arrow_right: true, focused_column_page_down: false };
}

async function captureProfile({ proxy, reviewed, output, config }) {
  const temp = await mkdtemp(join(tmpdir(), `songs-v2-p1008-${config.name}-`)); let browser; let cdp; let recorder;
  try {
    browser = await launchBrowser(temp, config); cdp = await CdpConnection.connect(`ws://127.0.0.1:${browser.endpoint.port}${browser.endpoint.path}`); const browserVersion = await cdp.send("Browser.getVersion"); const session = await attachPage(cdp, config); recorder = new NetworkRecorder(cdp, session);
    await cdp.send("Storage.clearDataForOrigin", { origin: proxy.origin, storageTypes: "all" }, session); recorder.reset();
    // Direct Live is intentionally the first production navigation for every fresh profile.
    await navigate(cdp, session, `${proxy.origin}/${SET_SLUG === "" ? "" : "#"}/sets/${SET_SLUG}/live`);
    try {
      await waitRoute(cdp, session, /Plush|9Tease Stripped|Locked Live/, 90_000);
    } catch {
      // A cold Chromium profile can suspend its first navigation while the
      // worker and large IndexedDB activation settle. Reloading must resume the
      // verified stage without exposing partial content.
      await cdp.send("Page.reload", {}, session);
      await waitRoute(cdp, session, /Plush|9Tease Stripped|Locked Live/, 90_000);
    }const navigatorIdentity = await evaluate(cdp, session, `({userAgent:navigator.userAgent,platform:navigator.platform,maxTouchPoints:navigator.maxTouchPoints,mobile:matchMedia('(pointer:coarse)').matches})`);
    let state = await browserState(cdp, session); if (!state.service_worker.controlled) { await cdp.send("Page.reload", {}, session); await waitRoute(cdp, session, /Plush|9Tease Stripped|Locked Live/); }
    state = await browserState(cdp, session); required(state.service_worker.controlled && state.service_worker.state === "activated", `${config.name}: direct Live did not install/control service worker`); const expectedCacheName = `${reviewed.shell.cache_prefix}${reviewed.shell.release.slice(6)}`; required(state.service_worker.compatibility?.release === reviewed.shell.release && state.service_worker.compatibility?.accepted_bootstrap_manifest_sha256?.includes(reviewed.bootstrapHash), `${config.name}: service-worker compatibility drift`); required(JSON.stringify(state.cache_names) === JSON.stringify([expectedCacheName]), `${config.name}: service-worker cache namespace drift`);
    const initialApi = recorder.api(); const expectedApi = new Set([`${proxy.origin}/api/v2/bootstrap/manifest`, ...reviewed.bootstrap.chunks.map(x => `${proxy.origin}${x.url}`)]);
    required(initialApi.some(x => x.url.endsWith("/api/v2/bootstrap/manifest")) && initialApi.filter(x => expectedApi.has(x.url)).length >= reviewed.bootstrap.chunks.length + 1, `${config.name}: incomplete full bootstrap`);
    const initialPointer = state.pointer; required(typeof initialPointer.active === "string" && initialPointer.transitions === 1, `${config.name}: initial active IndexedDB pointer drift`);
    const firstLive = await surface(cdp, session); assertSurface(firstLive, config, true); const firstAxe = await axe(cdp, session, await readFile(AXE_SOURCE, "utf8")); required(firstAxe.length === 0, `${config.name}: axe Live violations`);
    const routeRecords = {}; const axeRecords = { live: firstAxe }; const routeApi = {};
    for (const [name, hash, pattern] of ROUTES) {
      await navigate(cdp, session, `${proxy.origin}/${hash}`); await waitRoute(cdp, session, pattern);
      await cdp.send("Page.reload", {}, session); await waitRoute(cdp, session, pattern); await sleep(100); await resetInstrumentation(cdp, session);
      const rec = await surface(cdp, session); assertSurface(rec, config, name === "set-live");
      routeRecords[name] = { route: hash, heading: rec.heading, headings: rec.headings, landmarks: rec.landmarks, aria_current: rec.aria_current, overflow: rec.overflow, controls: rec.controls, internal_apex_hrefs: rec.apex_hrefs, mutation_controls: rec.mutation_controls, post_ready_fetch_xhr: await instrumentation(cdp, session) }; routeApi[name] = recorder.api().length;
      if (["dashboard", "song-1979", "set-detail", "status", "set-live"].includes(name)) { const violations = await axe(cdp, session, await readFile(AXE_SOURCE, "utf8")); required(violations.length === 0, `${config.name}: axe ${name} violations`); axeRecords[name] = violations; }
    }
    const invalid = {};
    for (const hash of INVALID_HASHES) { await navigate(cdp, session, `${proxy.origin}/${hash}`); await waitRoute(cdp, session, /^Page not found$/); const rec = await surface(cdp, session); required(rec.heading === "Page not found", `${config.name}: invalid hash did not render Page not found`); invalid[hash] = { heading: rec.heading, overflow: rec.overflow, shell_fallback: false }; }
    const statusBeforeOffline = await browserState(cdp, session); required(statusBeforeOffline.pointer.active === initialPointer.active && statusBeforeOffline.pointer.transitions === initialPointer.transitions, `${config.name}: route navigation changed pointer`);
    const reduced = await reducedMotion(cdp, session); await navigate(cdp, session, `${proxy.origin}/#/sets/${SET_SLUG}/live`); await waitRoute(cdp, session, /Plush|9Tease Stripped|Locked Live/); const keyboard = await keyboardLive(cdp, session);
    const pwa = await evaluate(cdp, session, `fetch('/manifest.webmanifest').then(r=>r.json())`); required(pwa.start_url === '/#/' && pwa.scope === '/', `${config.name}: PWA manifest start_url/scope drift`);
    const onlineUnknownStatus = await httpStatus(proxy.origin, "/unexpected-shell-path"); required(onlineUnknownStatus === 404, `${config.name}: direct unknown pathname returned ${onlineUnknownStatus}, expected 404`);
    const screenshotResult = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, session); const screenshot = Buffer.from(screenshotResult.data, "base64");
    await proxy.close();
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }, session); recorder.reset();
    const offline = {}; const offlineApi = {};
    for (const [name, hash, pattern] of ROUTES) { await navigate(cdp, session, `${proxy.origin}/${hash}`); await waitRoute(cdp, session, pattern); await cdp.send("Page.reload", {}, session); await waitRoute(cdp, session, pattern); await sleep(150); const rec=await surface(cdp,session); assertSurface(rec,config,name==="set-live"); const all=recorder.all(); offline[name]={heading:rec.heading,overflow:rec.overflow,from_service_worker:all.filter(x=>x.from_service_worker).length,post_ready_fetch_xhr:await instrumentation(cdp,session)}; offlineApi[name]=recorder.api().length; assertNoApi(all,`${config.name} offline ${name}`); required((await instrumentation(cdp,session)).fetch.length===0 && (await instrumentation(cdp,session)).xhr.length===0,`${config.name}: offline ${name} post-ready fetch/XHR`); recorder.reset(); }
    await navigate(cdp, session, `${proxy.origin}/unexpected-shell-path`); await sleep(1000); const unknownOffline = await evaluate(cdp, session, `({path:location.pathname, shellFallback:Boolean(document.querySelector('#root [data-page-heading]')) && !document.body.innerText.includes('Page not found'), appRoot:Boolean(document.querySelector('#root'))})`); required(unknownOffline.shellFallback === false, `${config.name}: unknown pathname fell back to shell offline`);
    await navigate(cdp, session, `${proxy.origin}/#/`); await waitRoute(cdp, session, /Your gig book, without the edit controls|Active Set List/); const offlineState = await browserState(cdp, session); required(offlineState.pointer.active === initialPointer.active && offlineState.pointer.transitions === initialPointer.transitions && offlineState.pointer.chunks === initialPointer.chunks && offlineState.pointer.documents === initialPointer.documents, `${config.name}: offline pointer/storage transition changed`); required(JSON.stringify(offlineState.database_names) === JSON.stringify([DATABASE]), `${config.name}: unexpected IndexedDB namespace`); required(JSON.stringify(offlineState.cache_names) === JSON.stringify([expectedCacheName]), `${config.name}: offline cache namespace drift`);
    const observation = { schema_version:"1", profile:config, browser:{product:browserVersion.product,revision:browserVersion.revision,user_agent:browserVersion.userAgent,protocol_version:browserVersion.protocolVersion,navigator_user_agent:navigatorIdentity.userAgent,navigator_platform:navigatorIdentity.platform,max_touch_points:navigatorIdentity.maxTouchPoints,coarse_pointer:navigatorIdentity.mobile}, shell:{release:reviewed.shell.release,asset_manifest_sha256:reviewed.shellHash,cache_name:`${reviewed.shell.cache_prefix}${reviewed.shell.release.slice(6)}`},pwa_manifest:{start_url:pwa.start_url,scope:pwa.scope}, bootstrap:{generation:reviewed.bootstrap.generation,manifest_sha256:reviewed.bootstrapHash,documents:reviewed.bootstrap.counts.documents,chunks:reviewed.bootstrap.chunks.length}, initial_bootstrap:{api_requests:initialApi.map(x=>({url:x.url,method:x.method,status:x.status})),full:true,active_pointer:initialPointer}, routes:routeRecords, invalid_hash_routes:invalid, accessibility:{axe:axeRecords}, reduced_motion:reduced, keyboard, isolation:{online_unknown_path_status:onlineUnknownStatus,offline_unknown_path_shell_fallback:unknownOffline.shellFallback}, offline:{routes:offline,api_requests:offlineApi,zero_api_requests:Object.values(offlineApi).every(x=>x===0),pointer:offlineState.pointer,service_worker:offlineState.service_worker,cache_names:offlineState.cache_names,database_names:offlineState.database_names}, pointer_unchanged_after_routes:statusBeforeOffline.pointer.active===initialPointer.active&&statusBeforeOffline.pointer.transitions===initialPointer.transitions };
    await mkdir(join(output,"screenshots"),{recursive:true}); await writeFile(join(output,"screenshots",`${config.name}-live.png`),screenshot);
    return observation;
  } finally { recorder?.close(); cdp?.close(); await stopBrowser(browser?.child); await rm(temp,{recursive:true,force:true}); }
}

async function capture({ output, port }) {
  const reviewed = await readReviewedInputs(); required(existsSync(AXE_SOURCE), `missing axe source ${AXE_SOURCE}`); const observations={};
  for (const config of PROFILES) {
    const proxy = await startProxy(port);
    try { process.stdout.write(`capturing ${config.name}...\n`); observations[config.name] = await captureProfile({proxy,reviewed,output,config}); }
    finally { await proxy.close().catch(()=>undefined); }
  }
  const routeSummary={schema_version:"1",profiles:Object.fromEntries(Object.entries(observations).map(([name,o])=>[name,{routes:Object.fromEntries(Object.entries(o.routes).map(([key,v])=>[key,{heading:v.heading,overflow:v.overflow,aria_current:v.aria_current}])) ,invalid_hash_routes:o.invalid_hash_routes}])),canonical_routes:ROUTES.map(([name,hash])=>({name,hash})),invalid_hashes:INVALID_HASHES};
  const offlineSummary={schema_version:"1",profiles:Object.fromEntries(Object.entries(observations).map(([name,o])=>[name,{api_requests:o.offline.api_requests,zero_api_requests:o.offline.zero_api_requests,unknown_path_shell_fallback:o.isolation.offline_unknown_path_shell_fallback,service_worker:o.offline.service_worker,cache_names:o.offline.cache_names,database_names:o.offline.database_names}])),direct_live_first_load:true};
  const isolationSummary={schema_version:"1",profiles:Object.fromEntries(Object.entries(observations).map(([name,o])=>[name,{online_unknown_path_status:o.isolation.online_unknown_path_status,offline_unknown_path_shell_fallback:o.isolation.offline_unknown_path_shell_fallback,namespace:o.offline.database_names,cache_names:o.offline.cache_names,pointer_unchanged_after_routes:o.pointer_unchanged_after_routes}])),only_songs_v2_namespaces:true};
  await mkdir(join(output,"browser-observations"),{recursive:true}); await Promise.all(Object.entries(observations).map(([name,value])=>writeFile(join(output,"browser-observations",`${name}.json`),canonicalJson(value)))); await Promise.all([writeFile(join(output,"route-summary.json"),canonicalJson(routeSummary)),writeFile(join(output,"offline-summary.json"),canonicalJson(offlineSummary)),writeFile(join(output,"isolation-summary.json"),canonicalJson(isolationSummary))]);
  return {observations,routeSummary,offlineSummary,isolationSummary};
}
function validate(result) {
  const observations = Object.values(result.observations); const first = observations[0]?.browser;
  required(first?.product?.includes("Chrome") || first?.product?.includes("Chromium"), "captured browser is not Chromium");
  const actualProduct = first.product; const actualVersion = first.product.match(/\/(\d+(?:\.\d+)+)/)?.[1] ?? null; const actualUA = first.navigator_user_agent;
  required(actualVersion !== null, "Chromium product version was not recorded");
  for (const [name,o] of Object.entries(result.observations)) {
    required(o.browser.product === actualProduct && (o.browser.product.match(/\/(\d+(?:\.\d+)+)/)?.[1] ?? null) === actualVersion, `${name}: Chromium product/version drift`);
    required(o.browser.navigator_user_agent === actualUA && /Chrome\//.test(o.browser.navigator_user_agent) && !/iPhone|iPad/.test(o.browser.navigator_user_agent), `${name}: non-Chromium navigator identity`);
    required(o.browser.max_touch_points === (o.profile.touch ? 5 : 0), `${name}: touch metrics do not match configured profile`);
    required(o.initial_bootstrap.full && o.initial_bootstrap.active_pointer.transitions===1,`${name}: bootstrap invariant`); required(o.offline.zero_api_requests,`${name}: offline API invariant`); required(o.isolation.online_unknown_path_status===404 && !o.isolation.offline_unknown_path_shell_fallback,`${name}: unknown path isolation invariant`); required(Object.values(o.accessibility.axe).every(v=>v.length===0),`${name}: axe invariant`); required(o.pointer_unchanged_after_routes,`${name}: pointer invariant`);
  }
}
async function main() { const options=parseArguments(process.argv.slice(2)); const output=options.check?await mkdtemp(join(tmpdir(),"songs-v2-p1008-output-")):join(ROOT,"migration/v2/phase1/hardening"); try { const result=await capture({output,port:options.port}); validate(result); process.stdout.write(options.check?"P1-008 native Chromium hardening capture: OK\n":`wrote ${output}\n`); } finally { if(options.check) await rm(output,{recursive:true,force:true}); } }
main().catch(error=>{process.stderr.write(`P1-008 native Chromium capture failed: ${error?.stack??error}\n`);process.exitCode=1;});
