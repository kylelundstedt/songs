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

export interface ReviewedBootstrapTrust {
  readonly manifestSha256: string;
  readonly generation: string;
}

export const PREFERRED_BOOTSTRAP_TRUST: ReviewedBootstrapTrust = Object.freeze({
  manifestSha256: "a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f",
  generation: "phase1-f9634173e25ef4ca4b8330a3",
});

/**
 * Build-time policy for local retention. A release may append its immediate
 * predecessor here without changing the preferred network snapshot.
 */
export const ACCEPTED_BOOTSTRAP_TRUST: readonly ReviewedBootstrapTrust[] = Object.freeze([PREFERRED_BOOTSTRAP_TRUST]);
const PREFERRED_ONLY_BOOTSTRAP_TRUST: readonly ReviewedBootstrapTrust[] = Object.freeze([PREFERRED_BOOTSTRAP_TRUST]);

/** Compatibility aliases for callers compiled against the TASK-011 shell. */
export const REVIEWED_BOOTSTRAP_MANIFEST_SHA256 = PREFERRED_BOOTSTRAP_TRUST.manifestSha256;
export const REVIEWED_BOOTSTRAP_GENERATION = PREFERRED_BOOTSTRAP_TRUST.generation;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface SnapshotProgress {
  readonly phase: "manifest" | "chunks" | "verifying";
  readonly completed: number;
  readonly total: number;
}

export interface VerifiedManifestPayload {
  readonly manifest: BootstrapManifest;
  readonly raw: Uint8Array;
  readonly manifestSha256: string;
  readonly trust: ReviewedBootstrapTrust;
}

export interface SnapshotStagingHooks {
  readonly begin: (manifest: BootstrapManifest, raw: Uint8Array) => void | Promise<void>;
  readonly chunk: (descriptor: ChunkDescriptor, raw: Uint8Array, documents: readonly BootstrapDocument[]) => void | Promise<void>;
}

export interface FetchReviewedManifestOptions {
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly origin?: string;
}

export interface LoadOptions extends FetchReviewedManifestOptions {
  readonly onProgress?: (progress: SnapshotProgress) => void;
  readonly verifiedManifest?: VerifiedManifestPayload;
  readonly staging?: SnapshotStagingHooks;
}

export type BootstrapArtifactBytes = Uint8Array | ArrayBuffer;

function fail(code: BootstrapClientError["code"], message: string, cause?: unknown): never {
  throw new BootstrapClientError(code, message, cause);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isGitObjectId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (hasUnpairedSurrogate(value)) throw new Error("unpaired surrogate is outside the canonical JSON domain");
    return value;
  }
  if (typeof value === "number") {
    const text = String(value);
    const fractionalDigits = text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
    if (
      !Number.isFinite(value) || Object.is(value, -0) || /e/i.test(text) ||
      (Number.isInteger(value) ? !Number.isSafeInteger(value) : Math.abs(value) >= 1_000_000 || fractionalDigits < 1 || fractionalDigits > 6)
    ) throw new Error("number is outside the canonical JSON domain");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (entries.some(([key]) => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key))) throw new Error("object key is outside the canonical JSON domain");
    return Object.fromEntries(
      entries
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  throw new Error("value is outside the canonical JSON domain");
}

function canonicalBytes(value: unknown, compact: boolean): Uint8Array {
  const json = compact ? JSON.stringify(canonicalValue(value)) : `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
  return encoder.encode(json);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", source);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function framedSha256(parts: readonly string[]): Promise<string> {
  const encoded = parts.map((part) => encoder.encode(part));
  const total = encoded.reduce((sum, part) => sum + 8 + part.byteLength, 0);
  const framed = new Uint8Array(total);
  const view = new DataView(framed.buffer);
  let offset = 0;
  for (const part of encoded) {
    const length = BigInt(part.byteLength);
    view.setUint32(offset, Number(length >> 32n), false);
    view.setUint32(offset + 4, Number(length & 0xffffffffn), false);
    offset += 8;
    framed.set(part, offset);
    offset += part.byteLength;
  }
  return sha256(framed);
}

function parseCanonical<T>(bytes: Uint8Array, label: string, code: BootstrapClientError["code"]): T {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch (error) {
    fail(code, `${label} is not valid UTF-8 JSON`, error);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    fail(code, `${label} is not valid UTF-8 JSON`, error);
  }
  try {
    if (!equalBytes(bytes, canonicalBytes(value, false))) fail(code, `${label} is not canonical JSON`);
  } catch (error) {
    if (error instanceof BootstrapClientError) throw error;
    fail(code, `${label} is not canonical JSON`, error);
  }
  return value as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function asBytes(value: BootstrapArtifactBytes, label: string): Uint8Array {
  if (ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]") {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") return new Uint8Array(value as ArrayBuffer);
  fail("API_PROTOCOL_INVALID", `${label} is not a raw byte buffer`);
}

function selectReviewedTrust(
  manifestSha256: string,
  trusts: readonly ReviewedBootstrapTrust[],
  unknownCode: "MANIFEST_HASH_MISMATCH" | "MANIFEST_UNSUPPORTED",
): ReviewedBootstrapTrust {
  if (!Array.isArray(trusts) || trusts.length === 0) fail("API_PROTOCOL_INVALID", "The reviewed bootstrap trust policy is empty");
  let selected: ReviewedBootstrapTrust | undefined;
  const hashes = new Set<string>();
  for (const value of trusts) {
    if (!isObject(value) || !isSha256(value.manifestSha256) || typeof value.generation !== "string" || !/^phase1-[0-9a-f]{24}$/.test(value.generation)) fail("API_PROTOCOL_INVALID", "The reviewed bootstrap trust policy is malformed");
    if (hashes.has(value.manifestSha256)) fail("API_PROTOCOL_INVALID", "The reviewed bootstrap trust policy contains a duplicate manifest hash");
    hashes.add(value.manifestSha256);
    if (value.manifestSha256 === manifestSha256) selected = Object.freeze({ manifestSha256: value.manifestSha256, generation: value.generation });
  }
  if (selected === undefined) fail(unknownCode, "The bootstrap manifest is not accepted by this shell release", { manifestSha256 });
  return selected;
}

/** Selects a reviewed manifest by exact raw SHA-256 without parsing untrusted bytes. */
export async function preflightManifestTrust(
  manifestBytes: BootstrapArtifactBytes,
  trusts: readonly ReviewedBootstrapTrust[] = ACCEPTED_BOOTSTRAP_TRUST,
): Promise<ReviewedBootstrapTrust> {
  const raw = asBytes(manifestBytes, "Bootstrap manifest").slice();
  return selectReviewedTrust(await sha256(raw), trusts, "MANIFEST_UNSUPPORTED");
}

function currentOrigin(): string {
  const origin = globalThis.location?.origin;
  if (origin === undefined || origin === "null") fail("API_PROTOCOL_INVALID", "The V2 bootstrap origin is unavailable");
  return origin;
}

function normalizedOrigin(origin: string): string {
  try {
    const normalized = new URL(origin).origin;
    if (normalized === "null") fail("MANIFEST_INVALID", "The V2 bootstrap origin is invalid");
    return normalized;
  } catch (error) {
    if (error instanceof BootstrapClientError) throw error;
    fail("MANIFEST_INVALID", "The V2 bootstrap origin is invalid", error);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) signal.throwIfAborted();
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
  try {
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (signal?.aborted) throw error;
    fail("NETWORK_OFFLINE", "The V2 bootstrap API response ended before its verified bytes were available", error);
  }
}

function hasBaselineShape(value: unknown): boolean {
  return isObject(value) && isNonEmptyString(value.ref) && isGitObjectId(value.tag_object) && isGitObjectId(value.commit);
}

function validateManifestShape(value: unknown, origin: string): BootstrapManifest {
  if (!isObject(value) || value.schema_version !== "1" || value.kind !== "songs-v2.bootstrap.manifest") fail("MANIFEST_INVALID", "The bootstrap manifest schema is unsupported");
  const manifest = value as unknown as BootstrapManifest;
  if (!isNonEmptyString(manifest.generation) || !hasBaselineShape(manifest.source_baseline) || !hasBaselineShape(manifest.evidence_baseline)) fail("MANIFEST_INVALID", "The bootstrap manifest baseline identity is malformed");
  if (
    !isObject(manifest.read_model_anchor) || !isGitObjectId(manifest.read_model_anchor.implementation_commit) ||
    !isSha256(manifest.read_model_anchor.import_report_file_sha256) || !isSha256(manifest.read_model_anchor.import_report_output_sha256) ||
    !isObject(manifest.contract_hashes) || !isSha256(manifest.contract_hashes.read_model_projection) ||
    !isSha256(manifest.contract_hashes.corpus_manifest) || !isSha256(manifest.contract_hashes.identity_sidecars)
  ) fail("MANIFEST_INVALID", "The bootstrap manifest read-model anchors are malformed");
  if (
    !isObject(manifest.evidence_hashes) || !isSha256(manifest.evidence_hashes.renderer_baseline) ||
    !isSha256(manifest.evidence_hashes.browser_fit_summary) || !isObject(manifest.evidence_hashes.fit_captures) ||
    !Object.values(manifest.evidence_hashes.fit_captures).every(isSha256) ||
    !["ipad-landscape", "ipad-portrait", "phone"].every((profile) => isSha256(manifest.evidence_hashes.fit_captures[profile]))
  ) fail("MANIFEST_INVALID", "The bootstrap manifest evidence anchors are malformed");
  if (
    !isObject(manifest.counts) || !isPositiveInteger(manifest.counts.documents) || !isNonNegativeInteger(manifest.counts.lead_sheets) ||
    !isNonNegativeInteger(manifest.counts.set_lists) || !isNonNegativeInteger(manifest.counts.set_sections) ||
    !isNonNegativeInteger(manifest.counts.set_entries) || !isNonNegativeInteger(manifest.counts.source_bytes) ||
    manifest.counts.lead_sheets + manifest.counts.set_lists !== manifest.counts.documents
  ) fail("MANIFEST_INVALID", "The bootstrap manifest counts are malformed");
  if (
    !isObject(manifest.apex) || !isNonEmptyString(manifest.apex.version_output) || !isSha256(manifest.apex.executable_sha256) ||
    !Array.isArray(manifest.apex.flags) || !manifest.apex.flags.every(isNonEmptyString) || !isObject(manifest.physical_ipad) ||
    manifest.physical_ipad.status !== "pending" || typeof manifest.physical_ipad.note !== "string" || !isSha256(manifest.snapshot_sha256) ||
    !isObject(manifest.verification) || !isSha256(manifest.verification.output_sha256)
  ) fail("MANIFEST_INVALID", "The bootstrap manifest metadata is incomplete");
  if (
    !Array.isArray(manifest.chunks) || manifest.chunks.length === 0 || !Array.isArray(manifest.slug_routes) ||
    manifest.slug_routes.length !== manifest.counts.documents
  ) fail("MANIFEST_INVALID", "The bootstrap manifest inventory is incomplete");

  const expectedOrigin = normalizedOrigin(origin);
  const paths = new Set<string>();
  let documentCount = 0;
  let sourceBytes = 0;
  for (const [index, value] of manifest.chunks.entries()) {
    const name = `chunk-${String(index).padStart(3, "0")}.json`;
    const expectedUrl = `/api/v2/bootstrap/${manifest.generation}/chunks/${name}`;
    if (
      !isObject(value) || value.index !== index || value.path !== name || value.url !== expectedUrl || !isSha256(value.sha256) ||
      !isPositiveInteger(value.document_count) || !isPositiveInteger(value.bytes) || !isNonNegativeInteger(value.source_bytes) ||
      !isNonEmptyString(value.first_path) || !isNonEmptyString(value.last_path) || value.first_path > value.last_path || paths.has(value.path)
    ) fail("MANIFEST_INVALID", "The bootstrap chunk descriptors are invalid");
    const descriptor = value as unknown as ChunkDescriptor;
    let url: URL;
    try {
      url = new URL(descriptor.url, expectedOrigin);
    } catch (error) {
      fail("MANIFEST_INVALID", "A bootstrap chunk URL is invalid", error);
    }
    if (url.origin !== expectedOrigin || url.pathname !== expectedUrl || url.search !== "" || url.hash !== "") fail("MANIFEST_INVALID", "A bootstrap chunk URL escaped the V2 origin");
    paths.add(descriptor.path);
    documentCount += descriptor.document_count;
    sourceBytes += descriptor.source_bytes;
  }
  if (documentCount !== manifest.counts.documents || sourceBytes !== manifest.counts.source_bytes) fail("MANIFEST_INVALID", "The bootstrap chunk descriptor totals do not match the manifest");
  return manifest;
}

interface VerifiedChunkPayload {
  readonly chunk: BootstrapChunk;
  readonly raw: Uint8Array;
}

async function verifyManifestBytes(
  input: Uint8Array,
  origin: string,
  trusts: readonly ReviewedBootstrapTrust[],
  unknownCode: "MANIFEST_HASH_MISMATCH" | "MANIFEST_UNSUPPORTED",
): Promise<VerifiedManifestPayload> {
  const raw = input.slice();
  const manifestSha256 = await sha256(raw);
  const trust = selectReviewedTrust(manifestSha256, trusts, unknownCode);
  const manifest = validateManifestShape(parseCanonical<unknown>(raw, "Bootstrap manifest", "MANIFEST_INVALID"), origin);
  if (manifest.generation !== trust.generation) fail("MANIFEST_UNSUPPORTED", "The bootstrap manifest generation does not match its reviewed trust entry", { manifestSha256, expected: trust.generation, actual: manifest.generation });
  const unsigned = { ...manifest, verification: { ...manifest.verification, output_sha256: null } };
  if (await sha256(canonicalBytes(unsigned, true)) !== manifest.verification.output_sha256) fail("MANIFEST_INVALID", "The bootstrap manifest self-hash does not verify");
  return Object.freeze({ manifest: deepFreeze(manifest), raw, manifestSha256, trust });
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail("SNAPSHOT_INVALID", "A canonical source payload is not valid base64");
  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch (error) {
    fail("SNAPSHOT_INVALID", "A canonical source payload is not valid base64", error);
  }
}

function validateFitBox(value: unknown, path: string): void {
  if (
    !isObject(value) || !isPositiveNumber(value.client_width) || !isPositiveNumber(value.client_height) ||
    !isPositiveNumber(value.scroll_width) || !isPositiveNumber(value.scroll_height)
  ) fail("SNAPSHOT_INVALID", `Fit geometry failed for ${path}`);
}

async function validateDocumentLocally(manifest: BootstrapManifest, value: unknown, ordinal: number): Promise<BootstrapDocument> {
  if (
    !isObject(value) || value.ordinal !== ordinal || !isNonEmptyString(value.id) || !isNonEmptyString(value.path) ||
    !isNonEmptyString(value.slug) || (value.kind !== "lead-sheet" && value.kind !== "set-list") || !isObject(value.source)
  ) fail("SNAPSHOT_INVALID", "Document identity or ordering is invalid");
  const document = value as unknown as BootstrapDocument;
  if (
    document.source.ref !== manifest.source_baseline.ref || document.source.commit !== manifest.source_baseline.commit ||
    !isSha256(document.source.sha256) || !isNonNegativeInteger(document.source.bytes) || typeof document.source.content_base64 !== "string"
  ) fail("SNAPSHOT_INVALID", `Source binding failed for ${document.path}`);
  if (
    !isObject(document.verification) || !isSha256(document.verification.projection_sha256) || !isSha256(document.verification.document_sha256) ||
    !isObject(document.projection)
  ) fail("SNAPSHOT_INVALID", `Document verification metadata failed for ${document.path}`);
  const projection = document.projection as unknown as Record<string, unknown>;
  if (projection.id !== document.id || projection.path !== document.path || projection.slug !== document.slug || projection.kind !== document.kind) fail("SNAPSHOT_INVALID", `Projection binding failed for ${document.path}`);

  const source = decodeBase64(document.source.content_base64);
  if (source.byteLength !== document.source.bytes) fail("SNAPSHOT_INVALID", `Canonical source verification failed for ${document.path}`);
  const unsigned = { ...document, verification: { ...document.verification, document_sha256: null } };
  const [sourceHash, projectionHash, documentHash] = await Promise.all([
    sha256(source),
    sha256(canonicalBytes(document.projection, true)),
    sha256(canonicalBytes(unsigned, true)),
  ]);
  if (sourceHash !== document.source.sha256) fail("SNAPSHOT_INVALID", `Canonical source verification failed for ${document.path}`);
  if (projectionHash !== document.verification.projection_sha256 || documentHash !== document.verification.document_sha256) fail("SNAPSHOT_INVALID", `Document projection or self-hash failed for ${document.path}`);

  if (document.kind === "lead-sheet") {
    if (
      !isObject(document.apex) || document.apex.source_sha256 !== document.source.sha256 || typeof document.apex.html !== "string" ||
      !isSha256(document.apex.sha256) || !isNonNegativeInteger(document.apex.bytes)
    ) fail("SNAPSHOT_INVALID", `Apex verification failed for ${document.path}`);
    const html = encoder.encode(document.apex.html);
    if (html.byteLength !== document.apex.bytes || await sha256(html) !== document.apex.sha256) fail("SNAPSHOT_INVALID", `Apex verification failed for ${document.path}`);
    if (/<script\b|\son[a-z]+\s*=|javascript:/i.test(document.apex.html)) fail("SNAPSHOT_INVALID", `Apex safety policy failed for ${document.path}`);
    if (!isObject(document.fit) || document.fit.source_sha256 !== document.source.sha256 || !Array.isArray(document.fit.profiles) || document.fit.profiles.length !== 3) fail("SNAPSHOT_INVALID", `Fit evidence failed for ${document.path}`);
    const profiles = new Set<string>();
    for (const profile of document.fit.profiles) {
      if (
        !isObject(profile) || (profile.profile !== "ipad-portrait" && profile.profile !== "ipad-landscape" && profile.profile !== "phone") ||
        (profile.status !== "fit" && profile.status !== "needs-editing" && profile.status !== "scrollable") || profiles.has(profile.profile) ||
        (profile.profile === "phone" ? profile.status !== "scrollable" : profile.status === "scrollable") ||
        !isPositiveNumber(profile.body_px) || !isPositiveNumber(profile.auto_body_px) || !isPositiveNumber(profile.line_height) ||
        !isPositiveInteger(profile.column_count) || !Array.isArray(profile.columns) || profile.column_count !== profile.columns.length
      ) fail("SNAPSHOT_INVALID", `Fit result is outside the frozen schema for ${document.path}`);
      validateFitBox(profile, document.path);
      for (const column of profile.columns) validateFitBox(column, document.path);
      profiles.add(profile.profile);
    }
  } else {
    if (document.apex !== null || document.fit !== null || !Array.isArray(projection.sections) || !Array.isArray(projection.entries)) fail("SNAPSHOT_INVALID", `Set List projection failed for ${document.path}`);
    const localEntryIds = new Set<string>();
    const entrySectionById = new Map<string, string>();
    for (const [index, item] of projection.entries.entries()) {
      if (
        !isObject(item) || !isNonEmptyString(item.id) || localEntryIds.has(item.id) || item.setId !== document.id || item.ordinal !== index + 1 ||
        typeof item.columnBreakBefore !== "boolean" || typeof item.label !== "string" || typeof item.suffix !== "string" ||
        (item.singer !== undefined && typeof item.singer !== "string") || (item.note !== undefined && typeof item.note !== "string") ||
        !isNonEmptyString(item.sectionProjectionKey) || !isNonEmptyString(item.targetPath) || !isNonEmptyString(item.targetLeadSheetId)
      ) fail("SNAPSHOT_INVALID", `Set Entry identity failed for ${document.path}`);
      localEntryIds.add(item.id);
      entrySectionById.set(item.id, item.sectionProjectionKey);
    }
    const sectionKeys = new Set<string>();
    const sectionEntryIds: string[] = [];
    const sectionByEntryId = new Map<string, string>();
    for (const [index, item] of projection.sections.entries()) {
      if (
        !isObject(item) || !isNonEmptyString(item.projectionKey) || sectionKeys.has(item.projectionKey) || item.identityScope !== "frozen-snapshot" ||
        item.setId !== document.id || item.ordinal !== index + 1 || typeof item.columnBreakBefore !== "boolean" ||
        (item.heading !== undefined && typeof item.heading !== "string") || !Array.isArray(item.entryIds) ||
        !item.entryIds.every((id) => typeof id === "string" && localEntryIds.has(id))
      ) fail("SNAPSHOT_INVALID", `Set section identity failed for ${document.path}`);
      sectionKeys.add(item.projectionKey);
      for (const entryId of item.entryIds as string[]) {
        sectionEntryIds.push(entryId);
        sectionByEntryId.set(entryId, item.projectionKey);
      }
    }
    if (sectionEntryIds.length !== localEntryIds.size || new Set(sectionEntryIds).size !== localEntryIds.size) fail("SNAPSHOT_INVALID", `Set sections do not cover entries exactly once for ${document.path}`);
    for (const [entryId, sectionKey] of entrySectionById) if (sectionByEntryId.get(entryId) !== sectionKey) fail("SNAPSHOT_INVALID", `Set Entry section binding failed for ${document.path}`);
  }
  return document;
}

async function verifyChunkBytes(input: Uint8Array, descriptor: ChunkDescriptor, manifest: BootstrapManifest, ordinalOffset: number): Promise<VerifiedChunkPayload> {
  const raw = input.slice();
  if (raw.byteLength !== descriptor.bytes || await sha256(raw) !== descriptor.sha256) fail("CHUNK_HASH_MISMATCH", `Chunk ${descriptor.index + 1} failed integrity verification`);
  const value = parseCanonical<unknown>(raw, `Chunk ${descriptor.index + 1}`, "CHUNK_INVALID");
  if (
    !isObject(value) || value.schema_version !== "1" || value.kind !== "songs-v2.bootstrap.chunk" || value.generation !== manifest.generation ||
    value.index !== descriptor.index || !Array.isArray(value.documents) || !isObject(value.verification) ||
    !isSha256(value.verification.documents_sha256) || !isSha256(value.verification.output_sha256)
  ) fail("CHUNK_INVALID", `Chunk ${descriptor.index + 1} has an invalid schema`);
  const chunk = value as unknown as BootstrapChunk;
  if (chunk.documents.length !== descriptor.document_count || chunk.documents.length === 0) fail("CHUNK_INVALID", `Chunk ${descriptor.index + 1} does not match its descriptor`);
  const documentHashes: string[] = [];
  for (const document of chunk.documents) {
    if (!isObject(document) || !isObject(document.verification) || !isSha256(document.verification.document_sha256)) fail("CHUNK_INVALID", `Chunk ${descriptor.index + 1} has invalid document hashes`);
    documentHashes.push(document.verification.document_sha256);
  }
  const unsigned = { ...chunk, verification: { ...chunk.verification, output_sha256: null } };
  const [selfHash, documentsHash] = await Promise.all([
    sha256(canonicalBytes(unsigned, true)),
    framedSha256(documentHashes),
  ]);
  if (selfHash !== chunk.verification.output_sha256) fail("CHUNK_HASH_MISMATCH", `Chunk ${descriptor.index + 1} self-hash failed integrity verification`);
  if (documentsHash !== chunk.verification.documents_sha256) fail("CHUNK_HASH_MISMATCH", `Chunk ${descriptor.index + 1} document hash frame failed integrity verification`);

  await Promise.all(chunk.documents.map((document, index) => validateDocumentLocally(manifest, document, ordinalOffset + index)));
  if (
    chunk.documents[0]?.path !== descriptor.first_path || chunk.documents.at(-1)?.path !== descriptor.last_path ||
    chunk.documents.reduce((sum, document) => sum + document.source.bytes, 0) !== descriptor.source_bytes
  ) fail("CHUNK_INVALID", `Chunk ${descriptor.index + 1} does not match its descriptor`);
  return Object.freeze({ chunk: deepFreeze(chunk), raw });
}

async function validateSnapshot(manifest: BootstrapManifest, documents: readonly BootstrapDocument[]): Promise<VerifiedSnapshot> {
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
    if (document.ordinal !== ordinal || ids.has(document.id) || paths.has(document.path) || (ordinal > 0 && document.path <= previousPath)) fail("SNAPSHOT_INVALID", "Document identity or ordering is invalid");
    previousPath = document.path;
    ids.add(document.id);
    paths.add(document.path);
    documentsById.set(document.id, document);
    sourceBytes += document.source.bytes;
    if (document.kind === "lead-sheet") {
      leadSheets.push(document);
    } else {
      sections += document.projection.sections.length;
      entries += document.projection.entries.length;
      for (const entry of document.projection.entries) {
        if (entryIds.has(entry.id)) fail("SNAPSHOT_INVALID", `Set Entry identity failed for ${document.path}`);
        entryIds.add(entry.id);
      }
      setLists.push(document);
    }
  }

  for (const setList of setLists) {
    for (const entry of setList.projection.entries) {
      const target = documentsById.get(entry.targetLeadSheetId);
      if (target?.kind !== "lead-sheet" || entry.targetPath !== target.path) fail("SNAPSHOT_INVALID", `Set Entry ${entry.id} has no matching lead-sheet target`);
    }
  }
  if (
    documents.length !== manifest.counts.documents || leadSheets.length !== manifest.counts.lead_sheets || setLists.length !== manifest.counts.set_lists ||
    sections !== manifest.counts.set_sections || entries !== manifest.counts.set_entries || sourceBytes !== manifest.counts.source_bytes
  ) fail("SNAPSHOT_INVALID", "The verified document counts do not match the manifest");

  const routeByKey = new Map<string, SlugRoute>();
  const songRouteById = new Map<string, SlugRoute>();
  for (const value of manifest.slug_routes) {
    if (!isObject(value) || (value.kind !== "song" && value.kind !== "set") || !isNonEmptyString(value.slug) || !isNonEmptyString(value.path) || !isNonEmptyString(value.documentId)) fail("SNAPSHOT_INVALID", "A slug route is malformed");
    const route = value as unknown as SlugRoute;
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
        if (!routeByKey.has(`song:${href.slice(6)}`)) fail("SNAPSHOT_INVALID", `Apex link in ${leadSheet.path} has no V2 route`);
      } else {
        let url: URL;
        try {
          url = new URL(href);
        } catch {
          fail("SNAPSHOT_INVALID", `Apex link in ${leadSheet.path} is not an absolute HTTPS URL`);
        }
        if (url.protocol !== "https:") fail("SNAPSHOT_INVALID", `Apex link in ${leadSheet.path} uses an unsafe protocol`);
      }
    }
  }

  const logicalSnapshot = {
    source_baseline: manifest.source_baseline,
    evidence_baseline: manifest.evidence_baseline,
    read_model_anchor: manifest.read_model_anchor,
    contract_hashes: manifest.contract_hashes,
    evidence_hashes: manifest.evidence_hashes,
    apex: manifest.apex,
    physical_ipad: manifest.physical_ipad,
    slug_routes: manifest.slug_routes,
    document_hashes: documents.map((document) => document.verification.document_sha256),
  };
  const snapshotSha256 = await sha256(canonicalBytes(logicalSnapshot, true));
  if (snapshotSha256 !== manifest.snapshot_sha256 || manifest.generation !== `phase1-${snapshotSha256.slice(0, 24)}`) fail("SNAPSHOT_INVALID", "The logical snapshot hash or generation does not verify");

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

export async function fetchReviewedManifest(options: FetchReviewedManifestOptions = {}): Promise<VerifiedManifestPayload> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const origin = options.origin ?? currentOrigin();
  const raw = await fetchJSONBytes(fetchImpl, "/api/v2/bootstrap/manifest", options.signal);
  if (options.signal !== undefined) throwIfAborted(options.signal);
  const payload = await verifyManifestBytes(raw, origin, PREFERRED_ONLY_BOOTSTRAP_TRUST, "MANIFEST_HASH_MISMATCH");
  if (options.signal !== undefined) throwIfAborted(options.signal);
  return payload;
}

export async function verifyReviewedArtifacts(
  manifestBytes: BootstrapArtifactBytes,
  orderedChunkBytes: readonly BootstrapArtifactBytes[],
  origin: string,
  trusts: readonly ReviewedBootstrapTrust[] = ACCEPTED_BOOTSTRAP_TRUST,
): Promise<VerifiedSnapshot> {
  const payload = await verifyManifestBytes(asBytes(manifestBytes, "Bootstrap manifest"), origin, trusts, "MANIFEST_UNSUPPORTED");
  const manifest = payload.manifest;
  if (!Array.isArray(orderedChunkBytes) || orderedChunkBytes.length !== manifest.chunks.length) fail("CHUNK_INVALID", "The persisted bootstrap chunk set is incomplete or unexpected");
  const documents: BootstrapDocument[] = [];
  for (const [index, descriptor] of manifest.chunks.entries()) {
    const rawValue = orderedChunkBytes[index];
    if (rawValue === undefined) fail("CHUNK_INVALID", `Persisted chunk ${index + 1} is missing`);
    const verified = await verifyChunkBytes(asBytes(rawValue, `Chunk ${index + 1}`), descriptor, manifest, documents.length);
    documents.push(...verified.chunk.documents);
  }
  return validateSnapshot(manifest, documents);
}

export async function preflightReviewedManifest(fetchImpl: typeof fetch = fetch): Promise<void> {
  const bytes = await fetchJSONBytes(fetchImpl, "/api/v2/bootstrap/manifest");
  if (await sha256(bytes) !== REVIEWED_BOOTSTRAP_MANIFEST_SHA256) fail("MANIFEST_HASH_MISMATCH", "The bootstrap manifest does not match this reviewed shell release");
}

export async function loadVerifiedSnapshot(options: LoadOptions = {}): Promise<VerifiedSnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const origin = options.origin ?? currentOrigin();
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  let terminal = false;
  const progress = (value: SnapshotProgress) => { if (!terminal) options.onProgress?.(value); };
  try {
    progress({ phase: "manifest", completed: 0, total: 1 });
    throwIfAborted(controller.signal);
    let payload: VerifiedManifestPayload;
    if (options.verifiedManifest === undefined) {
      payload = await fetchReviewedManifest({ fetchImpl, origin, signal: controller.signal });
    } else {
      payload = await verifyManifestBytes(
        asBytes(options.verifiedManifest.raw, "Bootstrap manifest"),
        origin,
        PREFERRED_ONLY_BOOTSTRAP_TRUST,
        "MANIFEST_HASH_MISMATCH",
      );
    }
    throwIfAborted(controller.signal);
    progress({ phase: "manifest", completed: 1, total: 1 });
    throwIfAborted(controller.signal);
    await options.staging?.begin(payload.manifest, payload.raw);
    throwIfAborted(controller.signal);

    const documents: BootstrapDocument[] = [];
    progress({ phase: "chunks", completed: 0, total: payload.manifest.chunks.length });
    throwIfAborted(controller.signal);
    for (const descriptor of payload.manifest.chunks) {
      const fetched = await fetchJSONBytes(fetchImpl, descriptor.url, controller.signal);
      const verified = await verifyChunkBytes(fetched, descriptor, payload.manifest, documents.length);
      throwIfAborted(controller.signal);
      await options.staging?.chunk(descriptor, verified.raw, verified.chunk.documents);
      throwIfAborted(controller.signal);
      documents.push(...verified.chunk.documents);
      progress({ phase: "chunks", completed: descriptor.index + 1, total: payload.manifest.chunks.length });
      throwIfAborted(controller.signal);
    }
    progress({ phase: "verifying", completed: 0, total: payload.manifest.counts.documents });
    throwIfAborted(controller.signal);
    const snapshot = await validateSnapshot(payload.manifest, documents);
    throwIfAborted(controller.signal);
    progress({ phase: "verifying", completed: payload.manifest.counts.documents, total: payload.manifest.counts.documents });
    throwIfAborted(controller.signal);
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
