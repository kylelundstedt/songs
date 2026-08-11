#!/usr/bin/env node
/**
 * Native Chromium capture for TASK-012 production IndexedDB evidence.
 *
 * This intentionally uses only Node built-ins, headless-shell, and the CDP
 * WebSocket supplied by Node 24. It never starts, stops, or otherwise changes
 * the songs-v2-api service; the temporary reverse proxy supplies the trusted
 * proxy headers required by its already-running loopback listener.
 */
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
const UPSTREAM = { host: "127.0.0.1", port: 8001 };
const DEFAULT_PORT = 0;
const VIEWPORT = Object.freeze({ width: 1280, height: 720, deviceScaleFactor: 1 });
const CAPTURE_USER = "songs-v2-task-012-capture";
const REPAIR_UUID = "aea33d62-01c5-4a45-943b-0fb3f32325a8";
const DATABASE = "songs-v2";
const EXPECTED = Object.freeze({
  bootstrapManifestSha256: "a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f",
  bootstrapGeneration: "phase1-f9634173e25ef4ca4b8330a3",
  shellAssetManifestSha256: "e9bfe3db9c24291c3f2f209811cd277961cc1b26ce7a5f910e4c23c9e1a88047",
  shellRelease: "shell-48b974860e16510f36131506",
  documents: 373,
  chunks: 12,
  stores: ["chunks", "conflicts", "documents", "drafts", "meta", "outbox", "snapshots"],
});

function usage() {
  return `Usage: node scripts/capture_v2_phase1_storage_evidence.mjs [--check] [--port PORT]\n\n` +
    `Runs TASK-012 against songs-v2-api at 127.0.0.1:8001. Normal mode writes\n` +
    `migration/v2/phase1/storage browser evidence. --check performs the same\n` +
    `native capture in a temporary directory and leaves repository evidence untouched.\n`;
}

function parseArguments(argv) {
  let check = false;
  let port = DEFAULT_PORT;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--check") {
      check = true;
    } else if (value === "--help" || value === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else if (value === "--port") {
      const next = argv[++index];
      if (next === undefined) throw new Error("--port requires an integer from 0 through 65535");
      port = Number(next);
    } else if (value.startsWith("--port=")) {
      port = Number(value.slice("--port=".length));
    } else {
      throw new Error(`unknown argument: ${value}`);
    }
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 through 65535");
  return { check, port };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function required(condition, message) {
  if (!condition) throw new Error(message);
}

async function readReviewedInputs() {
  const bootstrapPath = join(ROOT, "internal/v2bootstrap/data/manifest.json");
  const shellPath = join(ROOT, "internal/v2shell/data/asset-manifest.json");
  const [bootstrapRaw, shellRaw] = await Promise.all([readFile(bootstrapPath), readFile(shellPath)]);
  const bootstrap = JSON.parse(bootstrapRaw);
  const shell = JSON.parse(shellRaw);
  required(sha256(bootstrapRaw) === EXPECTED.bootstrapManifestSha256, "reviewed bootstrap manifest trust anchor drift");
  required(bootstrap.generation === EXPECTED.bootstrapGeneration, "reviewed bootstrap generation drift");
  required(bootstrap.counts?.documents === EXPECTED.documents && bootstrap.chunks?.length === EXPECTED.chunks, "reviewed bootstrap count drift");
  required(sha256(shellRaw) === EXPECTED.shellAssetManifestSha256, "reviewed shell asset manifest trust anchor drift");
  required(shell.release === EXPECTED.shellRelease, "reviewed shell release drift");
  required(shell.bootstrap_manifest_sha256 === EXPECTED.bootstrapManifestSha256, "reviewed shell/bootstrap binding drift");
  required(Array.isArray(shell.accepted_bootstrap_manifest_sha256) && shell.accepted_bootstrap_manifest_sha256.length === 1 && shell.accepted_bootstrap_manifest_sha256[0] === EXPECTED.bootstrapManifestSha256, "reviewed shell compatibility drift");
  required(shell.cache_prefix === "songs-v2-shell-" && shell.indexeddb_name === DATABASE, "reviewed shell namespace drift");
  return { bootstrap, shell };
}

async function startProxy(requestedPort) {
  const server = createServer((incoming, outgoing) => {
    const headers = { ...incoming.headers };
    delete headers["x-exedev-userid"];
    delete headers["x-forwarded-proto"];
    delete headers["x-forwarded-host"];
    delete headers["x-forwarded-for"];
    headers.host = `${UPSTREAM.host}:${UPSTREAM.port}`;
    headers["x-exedev-userid"] = CAPTURE_USER;
    headers["x-forwarded-proto"] = "https";
    headers["x-forwarded-host"] = incoming.headers.host ?? `127.0.0.1:${requestedPort}`;
    headers["x-forwarded-for"] = "127.0.0.1";
    const upstream = httpRequest({
      host: UPSTREAM.host,
      port: UPSTREAM.port,
      method: incoming.method,
      path: incoming.url,
      headers,
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", (error) => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      outgoing.end(`capture upstream unavailable: ${error.message}`);
    });
    incoming.on("aborted", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  await new Promise((resolvePromise, reject) => {
    const failed = (error) => { server.off("listening", ready); reject(error); };
    const ready = () => { server.off("error", failed); resolvePromise(); };
    server.once("error", failed);
    server.once("listening", ready);
    server.listen({ host: "127.0.0.1", port: requestedPort });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("capture proxy did not bind a TCP address");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    async close() {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      if (!server.listening) return;
      await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    },
  };
}

async function waitForDevTools(profile, child, diagnostics) {
  const portFile = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`headless-shell exited before CDP became available (${child.exitCode}): ${diagnostics()}`);
    try {
      const lines = (await readFile(portFile, "utf8")).trim().split(/\r?\n/);
      if (lines.length >= 2 && /^\d+$/.test(lines[0])) return { port: Number(lines[0]), path: lines[1] };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for headless-shell CDP endpoint: ${diagnostics()}`);
}

async function launchBrowser(profile) {
  required(existsSync(HEADLESS_SHELL), `headless-shell is not available at ${HEADLESS_SHELL}`);
  let stderr = "";
  const child = spawn(HEADLESS_SHELL, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--metrics-recording-only",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    `--force-device-scale-factor=${VIEWPORT.deviceScaleFactor}`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
  try {
    const endpoint = await waitForDevTools(profile, child, () => stderr.trim());
    return { child, endpoint, diagnostics: () => stderr.trim() };
  } catch (error) {
    await stopBrowser(child);
    throw error;
  }
}

async function stopBrowser(child) {
  if (child === undefined || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    sleep(3_000).then(() => false),
  ]);
  if (exited === false && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  }
}

class CdpConnection {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();

  static async connect(url) {
    const connection = new CdpConnection();
    await connection.#open(url);
    return connection;
  }

  async #open(url) {
    this.#socket = new WebSocket(url);
    await new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out connecting to CDP")), 10_000);
      this.#socket.addEventListener("open", () => { clearTimeout(timeout); resolvePromise(); }, { once: true });
      this.#socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("failed to connect to CDP")); }, { once: true });
    });
    this.#socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (typeof message.id === "number") {
        const pending = this.#pending.get(message.id);
        if (pending !== undefined) {
          this.#pending.delete(message.id);
          clearTimeout(pending.timeout);
          if (message.error) pending.reject(new Error(`CDP ${pending.method}: ${message.error.message ?? "unknown error"}`));
          else pending.resolve(message.result ?? {});
        }
      } else {
        for (const listener of this.#listeners) listener(message);
      }
    });
    this.#socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("CDP connection closed"));
      }
      this.#pending.clear();
    });
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.#nextId++;
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, 30_000);
      this.#pending.set(id, { method, resolve: resolvePromise, reject, timeout });
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  }

  close() {
    this.#socket?.close();
  }
}

async function attachPage(cdp) {
  const created = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await Promise.all([
    cdp.send("Page.enable", {}, sessionId),
    cdp.send("Runtime.enable", {}, sessionId),
    cdp.send("Network.enable", {}, sessionId),
  ]);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: VIEWPORT.deviceScaleFactor,
    mobile: false,
    screenWidth: VIEWPORT.width,
    screenHeight: VIEWPORT.height,
  }, sessionId);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => { Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: () => "${REPAIR_UUID}" }); })();`,
  }, sessionId);
  return sessionId;
}

async function evaluate(cdp, sessionId, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, sessionId);
  if (response.exceptionDetails) {
    const text = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "unknown page exception";
    throw new Error(`page evaluation failed: ${text}`);
  }
  return response.result?.value;
}

async function waitUntil(label, condition, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await condition();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(75);
  }
  throw new Error(`timed out waiting for ${label}${lastError === null ? "" : `: ${lastError.message ?? String(lastError)}`}`);
}

async function navigateAndWait(cdp, sessionId, url) {
  await cdp.send("Page.navigate", { url }, sessionId);
  return waitForStatus(cdp, sessionId);
}

async function reloadAndWait(cdp, sessionId) {
  await cdp.send("Page.reload", {}, sessionId);
  return waitForStatus(cdp, sessionId);
}

const STATUS_EXPRESSION = `(() => {
  const fields = Object.fromEntries([...document.querySelectorAll("dl.status-grid div")].map((entry) => [entry.querySelector("dt")?.textContent?.trim() ?? "", entry.querySelector("dd")?.textContent?.trim() ?? ""]));
  const heading = document.querySelector("h1[data-page-heading]")?.textContent?.trim() ?? document.querySelector("h1")?.textContent?.trim() ?? "";
  return {
    heading,
    fields,
    title: document.title,
    body_text: document.body?.innerText ?? "",
    footer: document.querySelector("footer")?.innerText?.trim() ?? "",
    navigation: [...document.querySelectorAll("nav a")].map((item) => item.textContent?.trim()).filter(Boolean),
    inner_width: window.innerWidth,
    inner_height: window.innerHeight,
    device_pixel_ratio: window.devicePixelRatio,
    scroll_width: document.documentElement.scrollWidth,
    scroll_height: document.documentElement.scrollHeight,
    complete: document.readyState === "complete",
  };
})()`;

async function waitForStatus(cdp, sessionId) {
  return waitUntil("Snapshot status page", async () => {
    const status = await evaluate(cdp, sessionId, STATUS_EXPRESSION);
    return status.heading === "Snapshot status" && status.fields?.Completeness ? status : false;
  });
}

const BROWSER_STATE_EXPRESSION = `(() => (async () => {
  const requestResult = (request) => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed")); });
  const transactionDone = (transaction) => new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed")); transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")); });
  const open = () => new Promise((resolve, reject) => { const request = indexedDB.open("songs-v2"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed")); });
  const db = await open();
  let database;
  try {
    const names = [...db.objectStoreNames].sort();
    const transaction = db.transaction(names, "readonly");
    const meta = transaction.objectStore("meta");
    const snapshots = transaction.objectStore("snapshots");
    const keyPath = (value) => Array.isArray(value) ? [...value] : value;
    const [activeRecord, retainedRecord, transitionsRecord, snapshotRows, chunkCount, documentCount, outboxCount, draftsCount, conflictsCount] = await Promise.all([
      requestResult(meta.get("active-generation")), requestResult(meta.get("retained-generation")), requestResult(meta.get("pointer-transitions")),
      requestResult(snapshots.getAll()), requestResult(transaction.objectStore("chunks").count()), requestResult(transaction.objectStore("documents").count()),
      requestResult(transaction.objectStore("outbox").count()), requestResult(transaction.objectStore("drafts").count()), requestResult(transaction.objectStore("conflicts").count()),
    ]);
    await transactionDone(transaction);
    database = {
      name: db.name,
      version: db.version,
      stores: names,
      store_key_paths: Object.fromEntries(names.map((name) => [name, keyPath(db.transaction(name, "readonly").objectStore(name).keyPath)])),
      active_generation: activeRecord?.value ?? null,
      retained_generation: retainedRecord?.value ?? null,
      pointer_transitions: transitionsRecord?.value ?? null,
      chunks: chunkCount,
      documents: documentCount,
      pending: { outbox: outboxCount, drafts: draftsCount, conflicts: conflictsCount },
      snapshots: snapshotRows.map((snapshot) => ({
        generation: snapshot.generation,
        state: snapshot.state,
        logical_generation: snapshot.catalog?.logicalGeneration ?? null,
        manifest_sha256: snapshot.catalog?.manifestSha256 ?? null,
        stage_identity: snapshot.stageIdentity ?? null,
      })).sort((left, right) => String(left.generation).localeCompare(String(right.generation))),
    };
  } finally { db.close(); }
  const databaseNames = typeof indexedDB.databases === "function" ? (await indexedDB.databases()).map((item) => item.name).filter(Boolean).sort() : [];
  const registration = await navigator.serviceWorker.ready;
  const target = navigator.serviceWorker.controller ?? registration.active ?? null;
  const compatibility = await new Promise((resolve) => {
    if (!target) return resolve(null);
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 2500);
    channel.port1.onmessage = (event) => { clearTimeout(timer); resolve(event.data ?? null); };
    target.postMessage({ type: "GET_COMPATIBILITY" }, [channel.port2]);
  });
  let persisted = null;
  try { persisted = await navigator.storage.persisted(); } catch { persisted = null; }
  let estimate = {};
  try { estimate = await navigator.storage.estimate(); } catch { estimate = {}; }
  const details = estimate.usageDetails ?? {};
  return {
    browser: { user_agent: navigator.userAgent, platform: navigator.platform },
    service_worker: {
      state: registration.active?.state ?? null,
      controlled: Boolean(navigator.serviceWorker.controller),
      scope: registration.scope,
      script_url: registration.active?.scriptURL ?? null,
      compatibility,
    },
    cache_names: (await caches.keys()).sort(),
    database_names: databaseNames,
    database,
    storage_estimate: {
      origin_usage_bytes: typeof estimate.usage === "number" ? estimate.usage : null,
      origin_quota_bytes: typeof estimate.quota === "number" ? estimate.quota : null,
      cache_bytes: typeof details.caches === "number" ? details.caches : null,
      indexeddb_bytes: typeof details.indexedDB === "number" ? details.indexedDB : null,
      service_worker_registration_bytes: typeof details.serviceWorkerRegistrations === "number" ? details.serviceWorkerRegistrations : null,
      persisted,
    },
  };
})())()`;

async function browserState(cdp, sessionId) {
  return evaluate(cdp, sessionId, BROWSER_STATE_EXPRESSION);
}

const CORRUPT_ACTIVE_CHUNK_EXPRESSION = `(() => (async () => {
  const requestResult = (request) => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed")); });
  const transactionDone = (transaction) => new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed")); transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")); });
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open("songs-v2"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed")); });
  try {
    const pointerTransaction = db.transaction("meta", "readonly");
    const active = await requestResult(pointerTransaction.objectStore("meta").get("active-generation"));
    await transactionDone(pointerTransaction);
    if (typeof active?.value !== "string" || active.value.length === 0) throw new Error("active generation is missing");
    const transaction = db.transaction("chunks", "readwrite");
    const store = transaction.objectStore("chunks");
    const record = await requestResult(store.get([active.value, 0]));
    if (!record || !(record.bytes instanceof ArrayBuffer) || record.bytes.byteLength === 0) throw new Error("active chunk 0 is missing or empty");
    const bytes = new Uint8Array(record.bytes.slice(0));
    const before = bytes[0];
    bytes[0] = before ^ 1;
    store.put({ ...record, bytes: bytes.buffer });
    await transactionDone(transaction);
    return { generation: active.value, chunk_index: 0, byte_before: before, byte_after: bytes[0] };
  } finally { db.close(); }
})())()`;

async function corruptActiveChunk(cdp, sessionId) {
  return evaluate(cdp, sessionId, CORRUPT_ACTIVE_CHUNK_EXPRESSION);
}

class NetworkRecorder {
  #current = [];
  #byRequest = new Map();
  #unsubscribe;

  constructor(cdp, sessionId) {
    this.#unsubscribe = cdp.onEvent((event) => {
      if (event.sessionId !== sessionId) return;
      if (event.method === "Network.requestWillBeSent") {
        const item = {
          sequence: this.#current.length,
          request_id: event.params.requestId,
          url: event.params.request.url,
          method: event.params.request.method,
          type: event.params.type ?? null,
          status: null,
          mime_type: null,
          from_service_worker: false,
        };
        this.#current.push(item);
        this.#byRequest.set(item.request_id, item);
      } else if (event.method === "Network.responseReceived") {
        const item = this.#byRequest.get(event.params.requestId);
        if (item !== undefined) {
          item.status = event.params.response.status;
          item.mime_type = event.params.response.mimeType ?? null;
          item.from_service_worker = event.params.response.fromServiceWorker === true;
        }
      }
    });
  }

  reset() {
    this.#current = [];
    this.#byRequest.clear();
  }

  all() {
    return this.#current.map((item) => ({ ...item }));
  }

  api() {
    return this.all().filter((item) => new URL(item.url).pathname.startsWith("/api/v2/"));
  }

  close() {
    this.#unsubscribe();
  }
}

function chunkIndex(url) {
  const found = /chunk-(\d+)\.json$/.exec(new URL(url).pathname);
  return found === null ? Number.MAX_SAFE_INTEGER : Number(found[1]);
}

function simplifiedApiLog(records) {
  return records
    .map(({ url, method, status, type, mime_type }) => ({ url, method, status, type, mime_type }))
    .sort((left, right) => {
      const leftManifest = left.url.endsWith("/bootstrap/manifest");
      const rightManifest = right.url.endsWith("/bootstrap/manifest");
      if (leftManifest !== rightManifest) return leftManifest ? -1 : 1;
      const byChunk = chunkIndex(left.url) - chunkIndex(right.url);
      return byChunk !== 0 ? byChunk : left.url.localeCompare(right.url);
    });
}

function reviewedApiRequests(records, origin, bootstrap) {
  const expectedUrls = [
    `${origin}/api/v2/bootstrap/manifest`,
    ...bootstrap.chunks.map((chunk) => `${origin}${chunk.url}`),
  ];
  const expected = new Set(expectedUrls);
  const unexpected = records.filter((record) => !expected.has(record.url));
  required(unexpected.length === 0, `unexpected API request(s): ${unexpected.map((record) => record.url).join(", ")}`);
  const selected = expectedUrls.map((url) => {
    const matches = records.filter((record) => record.url === url && record.method === "GET" && record.status === 200 && (record.mime_type === "application/json" || record.mime_type === "application/json; charset=utf-8"));
    required(matches.length > 0, `reviewed API resource was not successfully observed: ${url}`);
    // React StrictMode can abort an initial effect after the browser has emitted
    // request events. The final successfully observed request per reviewed
    // resource is the logical bootstrap inventory: manifest plus 12 chunks.
    return matches[matches.length - 1];
  });
  return selected;
}

function assertApiRequests(records, origin, bootstrap) {
  const logical = reviewedApiRequests(records, origin, bootstrap);
  required(logical.length === EXPECTED.chunks + 1, `expected ${EXPECTED.chunks + 1} logical reviewed API resources, received ${logical.length}`);
  return logical;
}

function findSnapshot(state, generation) {
  return state.database.snapshots.find((snapshot) => snapshot.generation === generation);
}

function assertStatus(status, source, update) {
  required(status.heading === "Snapshot status", "status route did not render its full diagnostics page");
  required(status.complete === true && status.footer.includes("Read-only pilot"), "status route did not finish rendering");
  required(status.navigation.includes("Library") && status.navigation.includes("Status"), "status navigation is incomplete");
  required(status.inner_width === VIEWPORT.width && status.inner_height === VIEWPORT.height && status.device_pixel_ratio === VIEWPORT.deviceScaleFactor, "captured viewport/DPR drift");
  required(status.scroll_width === VIEWPORT.width, `status page has horizontal overflow (${status.scroll_width}px)`);
  required(status.fields.Generation === EXPECTED.bootstrapGeneration, "status logical generation drift");
  required(status.fields["Manifest SHA-256"] === EXPECTED.bootstrapManifestSha256, "status manifest SHA-256 drift");
  required(status.fields.Completeness === `${EXPECTED.documents}/${EXPECTED.documents} documents · ${EXPECTED.chunks}/${EXPECTED.chunks} chunks`, "status completeness drift");
  required(status.fields.IndexedDB?.startsWith(`${DATABASE} · available`), "status did not report active songs-v2 IndexedDB");
  required(status.fields["Snapshot source"] === source, `unexpected status snapshot source: ${status.fields["Snapshot source"]}`);
  required(status.fields["Content update"] === update, `unexpected content update state: ${status.fields["Content update"]}`);
}

function assertNamespace(state) {
  required(state.database.name === DATABASE && state.database.version === 2, "native IndexedDB name/version drift");
  required(JSON.stringify(state.database.stores) === JSON.stringify(EXPECTED.stores), "native IndexedDB store set drift");
  required(JSON.stringify(state.database_names) === JSON.stringify([DATABASE]), "capture profile opened an unexpected IndexedDB namespace");
  required(state.service_worker.controlled === true && state.service_worker.state === "activated", "service worker is not active and controlling the page");
  required(state.service_worker.compatibility?.release === EXPECTED.shellRelease, "service worker release compatibility drift");
  required(JSON.stringify(state.service_worker.compatibility?.accepted_bootstrap_manifest_sha256) === JSON.stringify([EXPECTED.bootstrapManifestSha256]), "service worker bootstrap compatibility drift");
  required(JSON.stringify(state.cache_names) === JSON.stringify([`songs-v2-shell-${EXPECTED.shellRelease.slice("shell-".length)}`]), "capture profile cache namespace drift");
}

function normalisedStorageEstimate(estimate) {
  return {
    cache_bytes: estimate.cache_bytes,
    indexeddb_bytes: estimate.indexeddb_bytes,
    origin_quota_bytes: estimate.origin_quota_bytes,
    origin_usage_bytes: estimate.origin_usage_bytes,
    persisted: estimate.persisted,
    service_worker_registration_bytes: estimate.service_worker_registration_bytes,
  };
}

async function writeArtifacts(output, observation, repairNetwork, screenshot) {
  const observations = join(output, "browser-observations");
  const screenshots = join(output, "screenshots");
  await Promise.all([mkdir(observations, { recursive: true }), mkdir(screenshots, { recursive: true })]);
  await Promise.all([
    writeFile(join(observations, "chromium-production.json"), canonicalJson(observation)),
    writeFile(join(observations, "corruption-repair-network.json"), canonicalJson(repairNetwork)),
    writeFile(join(screenshots, "snapshot-status-after-repair.png"), screenshot),
  ]);
}

async function capture({ output, port }) {
  const reviewed = await readReviewedInputs();
  const runTemp = await mkdtemp(join(tmpdir(), "songs-v2-task-012-"));
  const profile = join(runTemp, "profile");
  let proxy;
  let browser;
  let cdp;
  let recorder;
  try {
    proxy = await startProxy(port);
    const captureOrigin = proxy.origin;
    browser = await launchBrowser(profile);
    cdp = await CdpConnection.connect(`ws://127.0.0.1:${browser.endpoint.port}${browser.endpoint.path}`);
    const sessionId = await attachPage(cdp);
    recorder = new NetworkRecorder(cdp, sessionId);

    await cdp.send("Storage.clearDataForOrigin", { origin: proxy.origin, storageTypes: "all" }, sessionId);
    recorder.reset();
    const initialActivationStatus = await navigateAndWait(cdp, sessionId, `${proxy.origin}/#/status`);
    const controlled = await evaluate(cdp, sessionId, "Boolean(navigator.serviceWorker?.controller)");
    if (!controlled) await reloadAndWait(cdp, sessionId);
    await sleep(200);
    const initialApi = assertApiRequests(recorder.api(), proxy.origin, reviewed.bootstrap);
    const initialState = await browserState(cdp, sessionId);
    assertStatus(initialActivationStatus, "Active verified IndexedDB snapshot", "activated");
    assertNamespace(initialState);
    const initialPhysical = initialState.database.active_generation;
    required(typeof initialPhysical === "string" && initialPhysical === `${EXPECTED.bootstrapGeneration}@${EXPECTED.bootstrapManifestSha256.slice(0, 12)}`, "initial physical active generation drift");
    required(initialState.database.retained_generation === null && initialState.database.pointer_transitions === 1, "initial activation pointer state drift");
    required(initialState.database.chunks === EXPECTED.chunks && initialState.database.documents === EXPECTED.documents, "initial native storage counts drift");
    required(findSnapshot(initialState, initialPhysical)?.state === "active", "initial native active snapshot state drift");

    const corruption = await corruptActiveChunk(cdp, sessionId);
    required(corruption.generation === initialPhysical && corruption.chunk_index === 0 && corruption.byte_before !== corruption.byte_after, "native IndexedDB chunk corruption did not flip active chunk 0");

    recorder.reset();
    const repairStatus = await reloadAndWait(cdp, sessionId);
    await sleep(200);
    const repairApi = assertApiRequests(recorder.api(), proxy.origin, reviewed.bootstrap);
    const repairedState = await browserState(cdp, sessionId);
    const repairedPhysical = repairedState.database.active_generation;
    const expectedRepairPhysical = `${initialPhysical}@repair-${REPAIR_UUID}`;
    assertStatus(repairStatus, "Active verified IndexedDB snapshot", "activated");
    assertNamespace(repairedState);
    required(repairedPhysical === expectedRepairPhysical && repairedPhysical !== initialPhysical, "repair did not activate the deterministic distinct physical instance");
    required(repairedState.database.retained_generation === initialPhysical && repairedState.database.pointer_transitions === 2, "repair did not retain the corrupt physical predecessor with two pointer transitions");
    required(repairedState.database.chunks === EXPECTED.chunks * 2 && repairedState.database.documents === EXPECTED.documents * 2, "repair did not retain both physical snapshot payloads");
    required(findSnapshot(repairedState, repairedPhysical)?.state === "active" && findSnapshot(repairedState, initialPhysical)?.state === "retained", "repair snapshot states drift");
    const screenshotResult = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
    const screenshot = Buffer.from(screenshotResult.data, "base64");

    await proxy.close();
    proxy = undefined;
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
    recorder.reset();
    const offlineStatus = await reloadAndWait(cdp, sessionId);
    await sleep(200);
    const offlineApi = recorder.api();
    const offlineAll = recorder.all();
    const offlineState = await browserState(cdp, sessionId);
    assertStatus(offlineStatus, "Active verified IndexedDB snapshot", "current");
    assertNamespace(offlineState);
    required(offlineApi.length === 0, `cold restart issued ${offlineApi.length} API requests while the origin was unavailable`);
    required(offlineState.database.active_generation === repairedPhysical && offlineState.database.retained_generation === initialPhysical && offlineState.database.pointer_transitions === 2, "cold restart changed native activation pointers");
    required(offlineState.database.chunks === EXPECTED.chunks * 2 && offlineState.database.documents === EXPECTED.documents * 2, "cold restart storage counts drift");
    const servedByWorker = offlineAll.filter((item) => item.from_service_worker);
    required(servedByWorker.length > 0, "cold restart did not receive any shell resource through the service worker");

    const compatibility = offlineState.service_worker.compatibility;
    const observation = {
      schema_version: "1",
      origin: `${captureOrigin}/ production reverse-proxy capture`,
      browser: {
        name: "Chromium",
        version: (offlineState.browser.user_agent.match(/Chrome\/([0-9.]+)/)?.[1] ?? "unknown"),
        user_agent: offlineState.browser.user_agent,
        platform: offlineState.browser.platform,
      },
      viewport: {
        width: offlineStatus.inner_width,
        height: offlineStatus.inner_height,
        device_pixel_ratio: offlineStatus.device_pixel_ratio,
        scroll_width: offlineStatus.scroll_width,
      },
      shell: {
        release: EXPECTED.shellRelease,
        asset_manifest_sha256: EXPECTED.shellAssetManifestSha256,
      },
      bootstrap: {
        generation: EXPECTED.bootstrapGeneration,
        manifest_sha256: EXPECTED.bootstrapManifestSha256,
        documents: EXPECTED.documents,
        source_bytes: reviewed.bootstrap.counts.source_bytes,
      },
      namespaces: {
        cache_names: offlineState.cache_names,
        database_name: offlineState.database.name,
        database_names: offlineState.database_names,
        database_version: offlineState.database.version,
        stores: offlineState.database.stores,
        store_key_paths: offlineState.database.store_key_paths,
      },
      service_worker: {
        release: compatibility.release,
        accepted_bootstrap_manifest_sha256: compatibility.accepted_bootstrap_manifest_sha256,
        api_bypass: true,
        cache_specific_navigation: true,
        state: offlineState.service_worker.state,
      },
      storage_estimate: normalisedStorageEstimate(offlineState.storage_estimate),
      initial_activation: {
        active_generation: initialPhysical,
        api_requests: initialApi.length,
        stored_chunks: initialState.database.chunks,
        documents: EXPECTED.documents,
        pointer_transitions: initialState.database.pointer_transitions,
      },
      corruption_repair: {
        corruption: "flipped byte 0 of active chunk 0 in native Chromium IndexedDB",
        active_generation_after: repairedPhysical,
        retained_generation_after: initialPhysical,
        old_active_state_after: findSnapshot(repairedState, initialPhysical)?.state,
        api_requests: repairApi.length,
        stored_chunks_after: repairedState.database.chunks,
        documents_after: repairedState.database.documents,
        visible_documents: EXPECTED.documents,
        pointer_transitions_after: repairedState.database.pointer_transitions,
      },
      cold_restart_after_repair: {
        origin_process: "inactive during reload",
        api_requests: offlineApi.length,
        heading: offlineStatus.heading,
        content_update: offlineStatus.fields["Content update"],
        snapshot_source: offlineStatus.fields["Snapshot source"],
        service_worker_controlled: offlineState.service_worker.controlled,
        shell_resource_requests: servedByWorker.length,
        shell_resources_served_while_origin_inactive: servedByWorker.length > 0,
      },
    };
    const repairNetwork = simplifiedApiLog(repairApi);
    await writeArtifacts(output, observation, repairNetwork, screenshot);
    return { observation, repairNetwork, output };
  } finally {
    recorder?.close();
    cdp?.close();
    await stopBrowser(browser?.child);
    if (proxy !== undefined) await proxy.close().catch(() => undefined);
    await rm(runTemp, { recursive: true, force: true });
  }
}

function validateSemanticCapture({ observation, repairNetwork }) {
  required(observation.shell.release === EXPECTED.shellRelease && observation.shell.asset_manifest_sha256 === EXPECTED.shellAssetManifestSha256, "captured shell release/hash differs from the reviewed current shell");
  required(observation.bootstrap.generation === EXPECTED.bootstrapGeneration && observation.bootstrap.manifest_sha256 === EXPECTED.bootstrapManifestSha256, "captured bootstrap generation/hash differs from the reviewed current bootstrap");
  required(observation.bootstrap.documents === EXPECTED.documents, "captured document count drift");
  required(JSON.stringify(observation.namespaces.stores) === JSON.stringify(EXPECTED.stores), "captured IndexedDB schema drift");
  required(observation.initial_activation.api_requests === EXPECTED.chunks + 1 && observation.initial_activation.stored_chunks === EXPECTED.chunks && observation.initial_activation.documents === EXPECTED.documents && observation.initial_activation.pointer_transitions === 1, "initial semantic invariant failed");
  required(observation.corruption_repair.api_requests === EXPECTED.chunks + 1 && observation.corruption_repair.stored_chunks_after === EXPECTED.chunks * 2 && observation.corruption_repair.documents_after === EXPECTED.documents * 2 && observation.corruption_repair.visible_documents === EXPECTED.documents && observation.corruption_repair.pointer_transitions_after === 2 && observation.corruption_repair.old_active_state_after === "retained", "repair semantic invariant failed");
  required(observation.corruption_repair.active_generation_after !== observation.initial_activation.active_generation && observation.corruption_repair.retained_generation_after === observation.initial_activation.active_generation, "repair physical generation semantic invariant failed");
  required(observation.cold_restart_after_repair.api_requests === 0 && observation.cold_restart_after_repair.content_update === "current" && observation.cold_restart_after_repair.snapshot_source === "Active verified IndexedDB snapshot" && observation.cold_restart_after_repair.service_worker_controlled && observation.cold_restart_after_repair.shell_resources_served_while_origin_inactive, "offline restart semantic invariant failed");
  required(repairNetwork.length === EXPECTED.chunks + 1 && repairNetwork.every((item) => item.method === "GET" && item.status === 200 && item.url.includes("/api/v2/bootstrap/")), "repair API network semantic invariant failed");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const temporaryOutput = options.check ? await mkdtemp(join(tmpdir(), "songs-v2-task-012-output-")) : join(ROOT, "migration/v2/phase1/storage");
  try {
    const result = await capture({ output: temporaryOutput, port: options.port });
    validateSemanticCapture(result);
    if (options.check) process.stdout.write("TASK-012 native Chromium capture semantic invariants: OK\n");
    else process.stdout.write(`wrote ${join(ROOT, "migration/v2/phase1/storage/browser-observations/chromium-production.json")}\nwrote ${join(ROOT, "migration/v2/phase1/storage/browser-observations/corruption-repair-network.json")}\nwrote ${join(ROOT, "migration/v2/phase1/storage/screenshots/snapshot-status-after-repair.png")}\n`);
  } finally {
    if (options.check) await rm(temporaryOutput, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`TASK-012 native Chromium capture failed: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
