import {
  BootstrapClientError,
  type BootstrapChunk,
  type BootstrapDocument,
  type BootstrapManifest,
  type ChunkDescriptor,
  type LeadSheetDocument,
  type SetListDocument,
  type SlugRoute,
  type VerifiedSnapshot,
} from "./types";

export const REVIEWED_BOOTSTRAP_MANIFEST_SHA256 = "a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f";
export const REVIEWED_BOOTSTRAP_GENERATION = "phase1-f9634173e25ef4ca4b8330a3";

export interface SnapshotProgress {
  readonly phase: "manifest" | "chunks" | "verifying";
  readonly completed: number;
  readonly total: number;
}

interface LoadOptions {
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly origin?: string;
  readonly onProgress?: (progress: SnapshotProgress) => void;
}

function fail(code: BootstrapClientError["code"], message: string, cause?: unknown): never {
  throw new BootstrapClientError(code, message, cause);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", source);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeJSON<T>(bytes: Uint8Array, label: string): T {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as T;
  } catch (error) {
    fail("API_PROTOCOL_INVALID", `${label} is not valid UTF-8 JSON`, error);
  }
}

async function fetchJSONBytes(fetchImpl: typeof fetch, url: string, signal?: AbortSignal): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "manual",
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    fail("NETWORK_OFFLINE", "No verified snapshot is available without a connection to the private V2 API", error);
  }
  if (response.type === "opaqueredirect" || response.status === 401 || (response.status >= 300 && response.status < 400)) fail("UNAUTHENTICATED", "Your exe.dev session is required to load this private library");
  if (!response.ok || response.redirected) fail("API_PROTOCOL_INVALID", `The V2 bootstrap API returned HTTP ${response.status}`);
  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) fail("API_PROTOCOL_INVALID", "The V2 bootstrap API returned a non-JSON response");
  return new Uint8Array(await response.arrayBuffer());
}

function validateManifest(value: unknown, origin: string): BootstrapManifest {
  if (!isObject(value) || value.schema_version !== "1" || value.kind !== "songs-v2.bootstrap.manifest" || value.generation !== REVIEWED_BOOTSTRAP_GENERATION) fail("MANIFEST_INVALID", "The bootstrap manifest schema or generation is unsupported");
  const manifest = value as unknown as BootstrapManifest;
  if (!isObject(manifest.counts) || manifest.counts.documents !== 373 || manifest.counts.lead_sheets !== 339 || manifest.counts.set_lists !== 34 || manifest.counts.set_sections !== 36 || manifest.counts.set_entries !== 1076 || manifest.counts.source_bytes !== 748034) fail("MANIFEST_INVALID", "The bootstrap manifest counts do not match the reviewed snapshot");
  if (!Array.isArray(manifest.chunks) || manifest.chunks.length !== 12 || !Array.isArray(manifest.slug_routes) || manifest.slug_routes.length !== 373 || manifest.physical_ipad?.status !== "pending") fail("MANIFEST_INVALID", "The bootstrap manifest is incomplete");
  const paths = new Set<string>();
  for (const [index, value] of manifest.chunks.entries()) {
    const name = `chunk-${String(index).padStart(3, "0")}.json`;
    if (!isObject(value) || value.index !== index || value.path !== name || typeof value.document_count !== "number" || value.document_count < 1 || typeof value.bytes !== "number" || value.bytes < 1 || typeof value.sha256 !== "string" || value.sha256.length !== 64 || typeof value.url !== "string" || paths.has(value.path)) fail("MANIFEST_INVALID", "The bootstrap chunk descriptors are invalid");
    const chunk = value as unknown as ChunkDescriptor;
    const url = new URL(chunk.url, origin);
    if (url.origin !== origin || url.pathname !== `/api/v2/bootstrap/${manifest.generation}/chunks/${name}` || url.search !== "" || url.hash !== "") fail("MANIFEST_INVALID", "A bootstrap chunk URL escaped the V2 origin");
    paths.add(chunk.path);
  }
  return manifest;
}

function validateChunk(value: unknown, descriptor: ChunkDescriptor, manifest: BootstrapManifest): BootstrapChunk {
  if (!isObject(value) || value.schema_version !== "1" || value.kind !== "songs-v2.bootstrap.chunk" || value.generation !== manifest.generation || value.index !== descriptor.index || !Array.isArray(value.documents)) fail("CHUNK_INVALID", `Chunk ${descriptor.index + 1} has an invalid schema`);
  const chunk = value as unknown as BootstrapChunk;
  if (chunk.documents.length !== descriptor.document_count || chunk.documents[0]?.path !== descriptor.first_path || chunk.documents.at(-1)?.path !== descriptor.last_path || chunk.documents.reduce((sum, document) => sum + document.source.bytes, 0) !== descriptor.source_bytes) fail("CHUNK_INVALID", `Chunk ${descriptor.index + 1} does not match its descriptor`);
  return chunk;
}

function decodeBase64(value: string): Uint8Array {
  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch (error) {
    fail("SNAPSHOT_INVALID", "A canonical source payload is not valid base64", error);
  }
}

async function validateDocuments(manifest: BootstrapManifest, documents: readonly BootstrapDocument[]): Promise<VerifiedSnapshot> {
  const ids = new Set<string>();
  const paths = new Set<string>();
  const entryIds = new Set<string>();
  const documentsById = new Map<string, BootstrapDocument>();
  const leadSheets: LeadSheetDocument[] = [];
  const setLists: SetListDocument[] = [];
  let sourceBytes = 0;
  let sections = 0;
  let entries = 0;
  let previousPath = "";

  for (const [ordinal, document] of documents.entries()) {
    if (!isObject(document) || document.ordinal !== ordinal || typeof document.id !== "string" || typeof document.path !== "string" || typeof document.slug !== "string" || ids.has(document.id) || paths.has(document.path) || (ordinal > 0 && document.path <= previousPath)) fail("SNAPSHOT_INVALID", "Document identity or ordering is invalid");
    if (!isObject(document.source) || document.source.ref !== manifest.source_baseline.ref || document.source.commit !== manifest.source_baseline.commit || typeof document.source.content_base64 !== "string" || document.source.bytes < 0 || document.source.sha256.length !== 64) fail("SNAPSHOT_INVALID", `Source binding failed for ${document.path}`);
    previousPath = document.path;
    ids.add(document.id);
    paths.add(document.path);
    documentsById.set(document.id, document);
    sourceBytes += document.source.bytes;
    const source = decodeBase64(document.source.content_base64);
    if (source.byteLength !== document.source.bytes || await sha256(source) !== document.source.sha256) fail("SNAPSHOT_INVALID", `Canonical source verification failed for ${document.path}`);
    if (!isObject(document.projection) || document.projection.id !== document.id || document.projection.path !== document.path || document.projection.slug !== document.slug || document.projection.kind !== document.kind) fail("SNAPSHOT_INVALID", `Projection binding failed for ${document.path}`);

    if (document.kind === "lead-sheet") {
      const leadSheet = document as LeadSheetDocument;
      if (!isObject(leadSheet.apex) || leadSheet.apex.source_sha256 !== leadSheet.source.sha256 || new TextEncoder().encode(leadSheet.apex.html).byteLength !== leadSheet.apex.bytes || await sha256(new TextEncoder().encode(leadSheet.apex.html)) !== leadSheet.apex.sha256) fail("SNAPSHOT_INVALID", `Apex verification failed for ${document.path}`);
      if (/<script\b|\son[a-z]+\s*=|javascript:/i.test(leadSheet.apex.html)) fail("SNAPSHOT_INVALID", `Apex safety policy failed for ${document.path}`);
      if (!isObject(leadSheet.fit) || leadSheet.fit.source_sha256 !== leadSheet.source.sha256 || !Array.isArray(leadSheet.fit.profiles) || leadSheet.fit.profiles.length !== 3 || new Set(leadSheet.fit.profiles.map((profile) => profile.profile)).size !== 3) fail("SNAPSHOT_INVALID", `Fit evidence failed for ${document.path}`);
      leadSheets.push(leadSheet);
    } else if (document.kind === "set-list") {
      const setList = document as SetListDocument;
      if (setList.apex !== null || setList.fit !== null || !Array.isArray(setList.projection.sections) || !Array.isArray(setList.projection.entries)) fail("SNAPSHOT_INVALID", `Set List projection failed for ${document.path}`);
      sections += setList.projection.sections.length;
      entries += setList.projection.entries.length;
      for (const [index, entry] of setList.projection.entries.entries()) {
        if (entry.setId !== setList.id || entry.ordinal !== index + 1 || entryIds.has(entry.id)) fail("SNAPSHOT_INVALID", `Set Entry identity failed for ${setList.path}`);
        entryIds.add(entry.id);
      }
      setLists.push(setList);
    } else fail("SNAPSHOT_INVALID", `Unsupported document kind for ${document.path}`);
  }

  for (const setList of setLists) {
    for (const entry of setList.projection.entries) {
      const target = documentsById.get(entry.targetLeadSheetId);
      if (target?.kind !== "lead-sheet") fail("SNAPSHOT_INVALID", `Set Entry ${entry.id} has no lead-sheet target`);
    }
  }
  if (documents.length !== manifest.counts.documents || leadSheets.length !== manifest.counts.lead_sheets || setLists.length !== manifest.counts.set_lists || sections !== manifest.counts.set_sections || entries !== manifest.counts.set_entries || sourceBytes !== manifest.counts.source_bytes) fail("SNAPSHOT_INVALID", "The verified document counts do not match the manifest");

  const routeByKey = new Map<string, SlugRoute>();
  const songRouteById = new Map<string, SlugRoute>();
  for (const route of manifest.slug_routes) {
    const target = documentsById.get(route.documentId);
    const expectedKind = target?.kind === "lead-sheet" ? "song" : target?.kind === "set-list" ? "set" : undefined;
    const key = `${route.kind}:${route.slug}`;
    if (target === undefined || route.kind !== expectedKind || route.path !== target.path || route.slug !== target.slug || routeByKey.has(key)) fail("SNAPSHOT_INVALID", "A slug route does not match its document");
    routeByKey.set(key, route);
    if (route.kind === "song") songRouteById.set(route.documentId, route);
  }
  if (routeByKey.size !== documents.length) fail("SNAPSHOT_INVALID", "Slug route coverage is incomplete");
  for (const leadSheet of leadSheets) {
    for (const match of leadSheet.apex.html.matchAll(/href="([^"]+)"/g)) {
      const href = match[1];
      if (href === undefined) fail("SNAPSHOT_INVALID", `Apex link in ${leadSheet.path} is malformed`);
      if (href.startsWith("/song/")) {
        const slug = href.slice(6);
        if (!routeByKey.has(`song:${slug}`)) fail("SNAPSHOT_INVALID", `Apex link in ${leadSheet.path} has no V2 route`);
      } else {
        let url: URL;
        try { url = new URL(href); } catch { fail("SNAPSHOT_INVALID", `Apex link in ${leadSheet.path} is not an absolute HTTPS URL`); }
        if (url.protocol !== "https:") fail("SNAPSHOT_INVALID", `Apex link in ${leadSheet.path} uses an unsafe protocol`);
      }
    }
  }

  return Object.freeze({
    manifest,
    documents: Object.freeze([...documents]),
    leadSheets: Object.freeze(leadSheets),
    setLists: Object.freeze(setLists),
    documentsById,
    routeByKey,
    songRouteById,
  });
}

export async function preflightReviewedManifest(fetchImpl: typeof fetch = fetch): Promise<void> {
  const bytes = await fetchJSONBytes(fetchImpl, "/api/v2/bootstrap/manifest");
  if (await sha256(bytes) !== REVIEWED_BOOTSTRAP_MANIFEST_SHA256) fail("MANIFEST_HASH_MISMATCH", "The bootstrap manifest does not match this reviewed shell release");
}

export async function loadVerifiedSnapshot(options: LoadOptions = {}): Promise<VerifiedSnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const origin = options.origin ?? window.location.origin;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  let terminal = false;
  const progress = (value: SnapshotProgress) => { if (!terminal) options.onProgress?.(value); };
  try {
    progress({ phase: "manifest", completed: 0, total: 1 });
    const manifestBytes = await fetchJSONBytes(fetchImpl, "/api/v2/bootstrap/manifest", controller.signal);
    if (await sha256(manifestBytes) !== REVIEWED_BOOTSTRAP_MANIFEST_SHA256) fail("MANIFEST_HASH_MISMATCH", "The bootstrap manifest does not match this reviewed shell release");
    const manifest = validateManifest(decodeJSON<unknown>(manifestBytes, "Bootstrap manifest"), origin);
    progress({ phase: "manifest", completed: 1, total: 1 });

    let completed = 0;
    progress({ phase: "chunks", completed, total: manifest.chunks.length });
    const staged = await Promise.all(manifest.chunks.map(async (descriptor) => {
      const raw = await fetchJSONBytes(fetchImpl, descriptor.url, controller.signal);
      if (raw.byteLength !== descriptor.bytes || await sha256(raw) !== descriptor.sha256) fail("CHUNK_HASH_MISMATCH", `Chunk ${descriptor.index + 1} failed integrity verification`);
      const chunk = validateChunk(decodeJSON<unknown>(raw, `Chunk ${descriptor.index + 1}`), descriptor, manifest);
      completed += 1;
      progress({ phase: "chunks", completed, total: manifest.chunks.length });
      return chunk.documents;
    }));
    progress({ phase: "verifying", completed: 0, total: manifest.counts.documents });
    const documents = staged.flat();
    const snapshot = await validateDocuments(manifest, documents);
    progress({ phase: "verifying", completed: manifest.counts.documents, total: manifest.counts.documents });
    terminal = true;
    return snapshot;
  } catch (error) {
    terminal = true;
    controller.abort(error);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}
