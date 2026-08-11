import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../../..");
const targetRoot = resolve(repositoryRoot, "internal/v2shell/data");
const bootstrapManifestSha256 = "a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f";
const acceptedBootstrapManifestSha256 = Object.freeze([bootstrapManifestSha256]);
const cachePrefix = "songs-v2-shell-";
const databaseName = "songs-v2";

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, sorted(item)]));
  return value;
}

function canonical(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(sorted(value), null, 2)}\n`, "utf8");
}

function compact(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(sorted(value)), "utf8");
}

function files(root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name);
      if (statSync(path).isDirectory()) visit(path);
      else output.push(relative(root, path).split(sep).join("/"));
    }
  };
  visit(root);
  return output;
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}

function cacheControl(path: string): string {
  return path.startsWith("assets/") ? "private, max-age=31536000, immutable" : "private, no-store";
}

function serviceWorker(release: string, paths: readonly string[], acceptedManifests: readonly string[]): string {
  return `const CACHE_PREFIX = ${JSON.stringify(cachePrefix)};\nconst CACHE_NAME = CACHE_PREFIX + ${JSON.stringify(release.replace(/^shell-/, ""))};\nconst RELEASE = ${JSON.stringify(release)};\nconst ACCEPTED_BOOTSTRAP_MANIFESTS = ${JSON.stringify(acceptedManifests)};\nconst PRECACHE = ${JSON.stringify(paths.map((path) => `/${path}`), null, 2)};\n\nself.addEventListener('install', (event) => {\n  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));\n});\n\nself.addEventListener('activate', (event) => {\n  event.waitUntil(Promise.all([\n    caches.keys().then((names) => {\n      const previous = names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME);\n      return Promise.all(previous.slice(0, Math.max(0, previous.length - 1)).map((name) => caches.delete(name)));\n    }),\n    self.clients.claim(),\n  ]));\n});\n\nself.addEventListener('message', (event) => {\n  if (event.data && event.data.type === 'GET_COMPATIBILITY') {\n    event.ports[0]?.postMessage({release: RELEASE, accepted_bootstrap_manifest_sha256: ACCEPTED_BOOTSTRAP_MANIFESTS});\n    return;\n  }\n  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();\n});\n\nself.addEventListener('fetch', (event) => {\n  const url = new URL(event.request.url);\n  if (url.origin !== self.location.origin || url.pathname === '/api/v2' || url.pathname.startsWith('/api/v2/')) return;\n  if (event.request.mode === 'navigate') {\n    event.respondWith(caches.open(CACHE_NAME).then((cache) => cache.match('/index.html')).then((cached) => cached || fetch(event.request)));\n    return;\n  }\n  if (PRECACHE.includes(url.pathname)) {\n    event.respondWith(caches.open(CACHE_NAME).then((cache) => cache.match(event.request)).then((cached) => cached || fetch(event.request)));\n  }\n});\n`;
}

async function createBuild(root: string): Promise<void> {
  await build({ configFile: resolve(packageRoot, "vite.config.ts"), build: { outDir: root, emptyOutDir: true } });
  const precache = files(root).filter((path) => path !== "asset-manifest.json" && path !== "sw.js");
  const identityAssets = precache.map((path) => {
    const raw = readFileSync(resolve(root, path));
    return { path, bytes: raw.byteLength, sha256: sha256(raw) };
  });
  const release = `shell-${sha256(compact({ bootstrap_manifest_sha256: bootstrapManifestSha256, accepted_bootstrap_manifest_sha256: acceptedBootstrapManifestSha256, assets: identityAssets })).slice(0, 24)}`;
  writeFileSync(resolve(root, "sw.js"), serviceWorker(release, precache, acceptedBootstrapManifestSha256));
  const assets = files(root).filter((path) => path !== "asset-manifest.json").map((path) => {
    const raw = readFileSync(resolve(root, path));
    return { path, bytes: raw.byteLength, sha256: sha256(raw), content_type: contentType(path), cache_control: cacheControl(path) };
  });
  const unsigned = {
    schema_version: "1",
    kind: "songs-v2.shell.assets",
    release,
    bootstrap_manifest_sha256: bootstrapManifestSha256,
    accepted_bootstrap_manifest_sha256: acceptedBootstrapManifestSha256,
    cache_prefix: cachePrefix,
    indexeddb_name: databaseName,
    assets,
    verification: { output_sha256: null as string | null },
  };
  const manifest = { ...unsigned, verification: { output_sha256: sha256(compact(unsigned)) } };
  writeFileSync(resolve(root, "asset-manifest.json"), canonical(manifest));
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "check";
  if (command !== "check" && command !== "generate") throw new Error("usage: build-shell.ts [check|generate]");
  const temporary = mkdtempSync(resolve(tmpdir(), "songs-v2-shell-"));
  try {
    await createBuild(temporary);
    const expectedFiles = files(temporary);
    const actualFiles = existsSync(targetRoot) ? files(targetRoot) : [];
    const changed = expectedFiles.filter((path) => !existsSync(resolve(targetRoot, path)) || !readFileSync(resolve(targetRoot, path)).equals(readFileSync(resolve(temporary, path))));
    const stale = actualFiles.filter((path) => !expectedFiles.includes(path));
    if (command === "check") {
      if (changed.length > 0 || stale.length > 0) {
        console.error(`generated V2 shell differs:\n${[...changed, ...stale].join("\n")}`);
        process.exitCode = 1;
      } else console.log("TASK-011 shell assets: OK");
      return;
    }
    rmSync(targetRoot, { recursive: true, force: true });
    mkdirSync(targetRoot, { recursive: true });
    cpSync(temporary, targetRoot, { recursive: true });
    console.log(`wrote ${targetRoot}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

await main();
