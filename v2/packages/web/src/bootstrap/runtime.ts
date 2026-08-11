import {
  ACCEPTED_BOOTSTRAP_TRUST,
  PREFERRED_BOOTSTRAP_TRUST,
  fetchReviewedManifest,
  loadVerifiedSnapshot,
  verifyReviewedArtifacts,
  type ReviewedBootstrapTrust,
  type SnapshotProgress,
} from "./load";
import {
  openSongsStorage,
  SongsStorageError,
  type ActivationOptions,
  type BeginStageOptions,
  type GenerationInfo,
  type RecoveryOptions,
  type StorageInspection,
  type StoredGeneration,
} from "../storage";
import {
  BootstrapClientError,
  type BootstrapDocument,
  type BootstrapManifest,
  type VerifiedSnapshot,
} from "./types";

/** The release epoch understood by this shell. Newer persisted epochs are opaque. */
export const BOOTSTRAP_RELEASE_EPOCH = 1 as const;

export type BootstrapUpdate = "current" | "activated" | "recovered" | "memory-only" | "failed-retained";
export type BootstrapSource = "indexeddb" | "network" | "memory";
export type BootstrapDatabase = "available" | "unavailable";
export type PersistenceStatus = "granted" | "denied" | "unsupported" | "unknown";

export interface BootstrapCountStatus {
  readonly completed: number;
  readonly total: number;
}

export interface BootstrapRuntimeStatus {
  readonly source: BootstrapSource;
  readonly database: BootstrapDatabase;
  /** Logical reviewed generations; never physical IndexedDB keys. */
  readonly activeGeneration: string | null;
  readonly retainedGeneration: string | null;
  /** Physical CAS/pointer identities, useful for repair diagnostics. */
  readonly activeStorageGeneration?: string | null;
  readonly retainedStorageGeneration?: string | null;
  readonly manifestSha256?: string | null;
  readonly transitions: number;
  readonly chunks: BootstrapCountStatus;
  readonly docs: BootstrapCountStatus;
  readonly chunkCount: number;
  readonly docCount: number;
  readonly documents: BootstrapCountStatus;
  readonly offlineReady: boolean;
  readonly update: BootstrapUpdate;
  readonly persistence: PersistenceStatus;
  readonly usage: number | null;
  readonly quota: number | null;
  readonly headroom: number | null;
  readonly warning: string | null;
}

export interface OperationalResult {
  readonly snapshot: VerifiedSnapshot;
  readonly status: BootstrapRuntimeStatus;
}

export interface BootstrapStorageManager {
  readonly persisted?: () => Promise<boolean> | boolean;
  readonly persist?: () => Promise<boolean> | boolean;
  readonly estimate?: () => Promise<{ readonly usage?: number; readonly quota?: number }> | { readonly usage?: number; readonly quota?: number };
}

export interface RuntimeStageCatalog {
  readonly manifestBytes: ArrayBuffer;
  readonly manifest: ArrayBuffer;
  readonly rawManifest: ArrayBuffer;
  /** Logical reviewed generation, not the IndexedDB snapshot key. */
  readonly generation: string;
  readonly logicalGeneration: string;
  readonly physicalGeneration: string;
  readonly manifestSha256: string;
  readonly releaseEpoch: number;
  readonly snapshotSha256: string;
  readonly snapshotIdentity: string;
}

export interface RuntimeArtifactCatalog {
  readonly id: string;
  readonly ordinal: number;
  readonly kind: BootstrapDocument["kind"];
  readonly slug: string;
  readonly documentSha256: string;
  readonly sourceSha256: string;
  readonly chunkIndex: number;
}

export interface BootstrapStorageRepository {
  readonly beginStage: <Catalog>(options: BeginStageOptions<Catalog>) => Promise<GenerationInfo<Catalog>>;
  readonly putVerifiedChunkAndArtifacts: <ChunkCatalog, ArtifactCatalog>(
    generation: string,
    chunk: { readonly index: number; readonly bytes: ArrayBuffer; readonly catalog?: ChunkCatalog },
    artifacts: readonly { readonly path: string; readonly bytes: ArrayBuffer; readonly catalog?: ArtifactCatalog }[],
  ) => Promise<void>;
  readonly markVerified: <Catalog = unknown>(generation: string) => Promise<GenerationInfo<Catalog>>;
  readonly activate: (generation: string, options?: ActivationOptions) => Promise<unknown>;
  readonly recoverRetained: (generation: string, options?: RecoveryOptions) => Promise<unknown>;
  readonly readGeneration: <GenerationCatalog = unknown, ChunkCatalog = unknown, ArtifactCatalog = unknown>(generation: string) => Promise<StoredGeneration<GenerationCatalog, ChunkCatalog, ArtifactCatalog> | null>;
  readonly readActiveGeneration: <GenerationCatalog = unknown, ChunkCatalog = unknown, ArtifactCatalog = unknown>() => Promise<StoredGeneration<GenerationCatalog, ChunkCatalog, ArtifactCatalog> | null>;
  readonly readRetainedGeneration: <GenerationCatalog = unknown, ChunkCatalog = unknown, ArtifactCatalog = unknown>() => Promise<StoredGeneration<GenerationCatalog, ChunkCatalog, ArtifactCatalog> | null>;
  readonly inspect: () => Promise<StorageInspection>;
  readonly discardUnreachableGeneration: (generation: string) => Promise<unknown>;
  readonly cleanupUnreachable: (options?: { readonly maxGenerations?: number }) => Promise<{ readonly removed: readonly string[]; readonly hasMore: boolean }>;
  readonly close?: () => void;
}

export type BootstrapStorageFactory = (options?: { readonly indexedDB?: IDBFactory }) => Promise<BootstrapStorageRepository> | BootstrapStorageRepository;
export type StorageRepository = BootstrapStorageRepository;
export type StorageFactory = BootstrapStorageFactory;

export interface BootstrapRuntimeOptions {
  readonly fetchImpl?: typeof fetch;
  readonly origin?: string;
  readonly online?: boolean | (() => boolean);
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: SnapshotProgress) => void;
  readonly progress?: (progress: SnapshotProgress) => void;
  readonly indexedDB?: IDBFactory;
  readonly storage?: BootstrapStorageRepository | null;
  readonly storageRepository?: BootstrapStorageRepository | null;
  readonly storageFactory?: BootstrapStorageFactory;
  readonly storageManager?: BootstrapStorageManager;
  readonly acceptedTrusts?: readonly ReviewedBootstrapTrust[];
  /** Test hook for deterministic repair keys. The value is sanitized before use. */
  readonly instanceIdFactory?: () => string;
}

type PointerKind = "active" | "retained";
type LocalFailureKind = "accepted-corrupt" | "unsupported";

interface VerifiedStored {
  readonly stored: StoredGeneration<RuntimeStageCatalog, unknown, RuntimeArtifactCatalog>;
  readonly snapshot: VerifiedSnapshot;
  readonly trust: ReviewedBootstrapTrust;
}

interface LocalPointerFailure {
  readonly kind: LocalFailureKind;
  readonly physicalGeneration: string;
  readonly message: string;
}

interface LocalEvaluation {
  readonly active: VerifiedStored | null;
  readonly activeFailure: LocalPointerFailure | null;
  readonly retained: VerifiedStored | null;
  readonly retainedFailure: LocalPointerFailure | null;
  readonly storageFailure: unknown | null;
}

class LocalVerificationError extends Error {
  constructor(readonly kind: LocalFailureKind, message: string) {
    super(message);
    this.name = "LocalVerificationError";
  }
}

function bytesOf(value: ArrayBuffer | Uint8Array): Uint8Array {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value instanceof Uint8Array ? value : new Uint8Array(value));
  return copy;
}

function bufferOf(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(value.byteLength);
  new Uint8Array(copy).set(value instanceof Uint8Array ? value : new Uint8Array(value));
  return copy;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

async function sha256(value: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytesOf(value).buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("source content is not canonical base64");
  const decode = globalThis.atob;
  if (typeof decode !== "function") throw new Error("base64 decoding is unavailable");
  return Uint8Array.from(decode(value), (character) => character.charCodeAt(0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  throw new DOMException("The bootstrap operation was aborted", "AbortError");
}

function browserOnline(): boolean {
  const value = (globalThis.navigator as Navigator | undefined)?.onLine;
  return value === undefined ? true : value;
}

function currentOrigin(): string | undefined {
  const value = globalThis.location?.origin;
  return value === undefined || value === "null" ? undefined : value;
}

function trustForHash(trusts: readonly ReviewedBootstrapTrust[], manifestSha256: string): ReviewedBootstrapTrust | null {
  return trusts.find((trust) => trust.manifestSha256 === manifestSha256) ?? null;
}

function requireAcceptedNetworkTrust(manifestSha256: string, trusts: readonly ReviewedBootstrapTrust[]): void {
  if (trustForHash(trusts, manifestSha256) === null) throw new BootstrapClientError("MANIFEST_UNSUPPORTED", "The network bootstrap manifest is not accepted by this shell release", { manifestSha256 });
}

function catalogManifestBytes(value: unknown): ArrayBuffer | null {
  if (!isRecord(value)) return null;
  const candidate = value.manifestBytes ?? value.manifest ?? value.rawManifest;
  if (candidate !== null && typeof candidate === "object" && typeof (candidate as { byteLength?: unknown }).byteLength === "number") {
    try {
      return bufferOf(candidate as ArrayBuffer);
    } catch {
      return null;
    }
  }
  return null;
}

function catalogString(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] as string : null;
}

function catalogNumber(value: unknown, key: string): number | null {
  return isRecord(value) && typeof value[key] === "number" && Number.isSafeInteger(value[key]) ? value[key] as number : null;
}

function classifyCatalogFailure(
  stored: StoredGeneration<RuntimeStageCatalog, unknown, RuntimeArtifactCatalog> | null,
  trusts: readonly ReviewedBootstrapTrust[],
  fallback: LocalFailureKind = "unsupported",
): LocalFailureKind {
  if (stored === null) return fallback;
  const catalog = stored.snapshot.catalog;
  const hash = catalogString(catalog, "manifestSha256");
  const epoch = catalogNumber(catalog, "releaseEpoch");
  if (epoch !== null && epoch > BOOTSTRAP_RELEASE_EPOCH) return "unsupported";
  if (hash === null || trustForHash(trusts, hash) === null) return "unsupported";
  return "accepted-corrupt";
}

async function verifyStoredGeneration(
  stored: StoredGeneration<RuntimeStageCatalog, unknown, RuntimeArtifactCatalog>,
  origin: string,
  trusts: readonly ReviewedBootstrapTrust[],
  allowStaging = false,
): Promise<VerifiedStored> {
  const catalog = stored.snapshot.catalog;
  const manifestBytes = catalogManifestBytes(catalog);
  const manifestSha256 = catalogString(catalog, "manifestSha256");
  const trust = manifestSha256 === null ? null : trustForHash(trusts, manifestSha256);
  const releaseEpoch = catalogNumber(catalog, "releaseEpoch");
  if (releaseEpoch !== null && releaseEpoch > BOOTSTRAP_RELEASE_EPOCH) throw new LocalVerificationError("unsupported", "The persisted bootstrap release epoch is newer than this shell");
  if (manifestBytes === null || manifestSha256 === null || trust === null) throw new LocalVerificationError("unsupported", "The persisted manifest is not accepted by this shell release");
  if (stored.snapshot.stageIdentity !== manifestSha256) throw new LocalVerificationError("accepted-corrupt", "Persisted stage identity does not match its manifest hash");
  if (releaseEpoch !== BOOTSTRAP_RELEASE_EPOCH) throw new LocalVerificationError("accepted-corrupt", "Persisted stage release epoch is malformed");
  if (!allowStaging && stored.snapshot.state !== "active" && stored.snapshot.state !== "retained") throw new LocalVerificationError("accepted-corrupt", "A pending generation is not a runtime snapshot");
  if (allowStaging && stored.snapshot.state !== "staging" && stored.snapshot.state !== "verified" && stored.snapshot.state !== "active" && stored.snapshot.state !== "retained") throw new LocalVerificationError("accepted-corrupt", "Persisted generation state is invalid");
  if (await sha256(manifestBytes) !== manifestSha256) throw new LocalVerificationError("accepted-corrupt", "Persisted raw manifest is corrupt");

  let snapshot: VerifiedSnapshot;
  try {
    const orderedChunks = [...stored.chunks].sort((left, right) => left.index - right.index);
    if (orderedChunks.length === 0 || orderedChunks.some((chunk, index) => chunk.index !== index)) throw new Error("persisted chunks are not a complete ordered set");
    snapshot = await verifyReviewedArtifacts(manifestBytes, orderedChunks.map((chunk) => bytesOf(chunk.bytes)), origin, trusts);
  } catch (error) {
    throw new LocalVerificationError("accepted-corrupt", `Persisted reviewed artifacts failed verification: ${errorMessage(error)}`);
  }

  const catalogGeneration = catalogString(catalog, "generation");
  const logicalGeneration = catalogString(catalog, "logicalGeneration") ?? catalogGeneration;
  const physicalGeneration = catalogString(catalog, "physicalGeneration");
  if ((catalogGeneration !== null && catalogGeneration !== logicalGeneration) || logicalGeneration !== snapshot.manifest.generation || logicalGeneration !== trust.generation || physicalGeneration !== stored.snapshot.generation) {
    throw new LocalVerificationError("accepted-corrupt", "Persisted logical and physical generation identities do not match");
  }
  if (catalogString(catalog, "snapshotSha256") !== snapshot.manifest.snapshot_sha256 || catalogString(catalog, "snapshotIdentity") !== snapshot.manifest.snapshot_sha256) {
    throw new LocalVerificationError("accepted-corrupt", "Persisted snapshot identity does not match the reviewed manifest");
  }

  if (stored.artifacts.length !== snapshot.documents.length) throw new LocalVerificationError("accepted-corrupt", "Persisted document artifact count is incomplete");
  const artifacts = new Map(stored.artifacts.map((artifact) => [artifact.path, artifact]));
  if (artifacts.size !== stored.artifacts.length) throw new LocalVerificationError("accepted-corrupt", "Persisted document artifact paths are duplicated");
  for (const document of snapshot.documents) {
    const artifact = artifacts.get(document.path);
    if (artifact === undefined || !isRecord(artifact.catalog)) throw new LocalVerificationError("accepted-corrupt", `Persisted artifact ${document.path} is missing its identity catalog`);
    const metadata = artifact.catalog;
    const source = decodeBase64(document.source.content_base64);
    if (!equalBytes(new Uint8Array(artifact.bytes), source)) throw new LocalVerificationError("accepted-corrupt", `Persisted artifact ${document.path} does not contain decoded source bytes`);
    if (
      metadata.id !== document.id || metadata.ordinal !== document.ordinal || metadata.kind !== document.kind || metadata.slug !== document.slug ||
      metadata.documentSha256 !== document.verification.document_sha256 || metadata.sourceSha256 !== document.source.sha256 ||
      metadata.chunkIndex !== documentChunkIndex(snapshot.manifest, document.ordinal)
    ) throw new LocalVerificationError("accepted-corrupt", `Persisted artifact ${document.path} identity catalog does not match the reviewed document`);
  }
  return { stored, snapshot, trust };
}

function documentChunkIndex(manifest: BootstrapManifest, ordinal: number): number {
  let offset = 0;
  for (const descriptor of manifest.chunks) {
    if (ordinal < offset + descriptor.document_count) return descriptor.index;
    offset += descriptor.document_count;
  }
  return -1;
}

async function evaluateLocal(storage: BootstrapStorageRepository, inspection: StorageInspection, origin: string, trusts: readonly ReviewedBootstrapTrust[]): Promise<LocalEvaluation> {
  let active: VerifiedStored | null = null;
  let activeFailure: LocalPointerFailure | null = null;
  let retained: VerifiedStored | null = null;
  let retainedFailure: LocalPointerFailure | null = null;
  let storageFailure: unknown | null = null;

  if (inspection.activeGeneration !== null) {
    let rawActive: StoredGeneration<RuntimeStageCatalog, unknown, RuntimeArtifactCatalog> | null = null;
    try {
      rawActive = await storage.readActiveGeneration<RuntimeStageCatalog, unknown, RuntimeArtifactCatalog>();
      if (rawActive === null) throw new LocalVerificationError("unsupported", "The active pointer has no snapshot");
      active = await verifyStoredGeneration(rawActive, origin, trusts);
    } catch (error) {
      if (error instanceof LocalVerificationError) {
        activeFailure = { kind: error.kind, physicalGeneration: inspection.activeGeneration, message: error.message };
      } else {
        storageFailure = error;
      }
      if (rawActive !== null && activeFailure === null) {
        const kind = classifyCatalogFailure(rawActive, trusts);
        activeFailure = { kind, physicalGeneration: inspection.activeGeneration, message: errorMessage(error) };
      }
    }
  }

  if (inspection.retainedGeneration !== null) {
    try {
      const rawRetained = await storage.readRetainedGeneration<RuntimeStageCatalog, unknown, RuntimeArtifactCatalog>();
      if (rawRetained === null) throw new LocalVerificationError("unsupported", "The retained pointer has no snapshot");
      retained = await verifyStoredGeneration(rawRetained, origin, trusts);
    } catch (error) {
      if (error instanceof LocalVerificationError) retainedFailure = { kind: error.kind, physicalGeneration: inspection.retainedGeneration, message: error.message };
      else storageFailure ??= error;
    }
  }
  return { active, activeFailure, retained, retainedFailure, storageFailure };
}

async function requestPersistence(manager: BootstrapStorageManager | undefined): Promise<Pick<BootstrapRuntimeStatus, "persistence" | "usage" | "quota" | "headroom">> {
  let persistence: PersistenceStatus = "unsupported";
  let usage: number | null = null;
  let quota: number | null = null;
  if (manager !== undefined && typeof manager.estimate === "function") {
    try {
      const estimate = await manager.estimate();
      if (typeof estimate.usage === "number" && Number.isFinite(estimate.usage) && estimate.usage >= 0) usage = estimate.usage;
      if (typeof estimate.quota === "number" && Number.isFinite(estimate.quota) && estimate.quota >= 0) quota = estimate.quota;
    } catch {
      // Advisory only.
    }
  }
  if (manager === undefined || (typeof manager.persisted !== "function" && typeof manager.persist !== "function")) return { persistence, usage, quota, headroom: usage !== null && quota !== null ? Math.max(0, quota - usage) : null };
  try {
    let granted = typeof manager.persisted === "function" ? await manager.persisted() : false;
    if (granted !== true && typeof manager.persist === "function") granted = await manager.persist();
    persistence = granted === true ? "granted" : "denied";
  } catch {
    persistence = "unknown";
  }
  return { persistence, usage, quota, headroom: usage !== null && quota !== null ? Math.max(0, quota - usage) : null };
}

interface StatusPointers {
  readonly active: VerifiedStored | null;
  readonly retained: VerifiedStored | null;
}

function makeStatus(
  source: BootstrapSource,
  database: BootstrapDatabase,
  update: BootstrapUpdate,
  snapshot: VerifiedSnapshot,
  inspection: StorageInspection | null,
  pointers: StatusPointers,
  manifestSha256: string | null,
  persistence: Pick<BootstrapRuntimeStatus, "persistence" | "usage" | "quota" | "headroom">,
  warning: string | null,
): BootstrapRuntimeStatus {
  const chunks = { completed: snapshot.manifest.chunks.length, total: snapshot.manifest.chunks.length } as const;
  const docs = { completed: snapshot.documents.length, total: snapshot.documents.length } as const;
  const local = source === "indexeddb";
  return Object.freeze({
    source,
    database,
    activeGeneration: local ? pointers.active?.snapshot.manifest.generation ?? null : null,
    retainedGeneration: pointers.retained?.snapshot.manifest.generation ?? null,
    activeStorageGeneration: inspection?.activeGeneration ?? null,
    retainedStorageGeneration: inspection?.retainedGeneration ?? null,
    manifestSha256,
    transitions: inspection?.transitionCount ?? 0,
    chunks,
    docs,
    chunkCount: chunks.completed,
    docCount: docs.completed,
    documents: docs,
    offlineReady: source === "indexeddb" && pointers.active !== null,
    update,
    ...persistence,
    warning,
  });
}

function resumablePhysicalGeneration(
  inspection: StorageInspection | null,
  logicalGeneration: string,
  manifestSha256: string,
  expectedActive: string | null,
  expectedTransitionCount: number,
): string | null {
  const candidate = inspection?.snapshots.find((snapshot) => {
    if (
      (snapshot.state !== "staging" && snapshot.state !== "verified")
      || snapshot.baseGeneration !== expectedActive
      || snapshot.baseTransitionCount !== expectedTransitionCount
      || snapshot.stageIdentity !== manifestSha256
    ) return false;
    return catalogString(snapshot.catalog, "logicalGeneration") === logicalGeneration && catalogString(snapshot.catalog, "manifestSha256") === manifestSha256 && catalogNumber(snapshot.catalog, "releaseEpoch") === BOOTSTRAP_RELEASE_EPOCH;
  });
  return candidate?.generation ?? null;
}

function stablePhysicalGeneration(logicalGeneration: string, manifestSha256: string): string {
  return `${logicalGeneration}@${manifestSha256.slice(0, 12)}`;
}

function safeInstanceId(factory?: () => string): string {
  let value = "";
  try {
    value = factory?.() ?? (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
  } catch {
    value = `${Date.now()}-${Math.random()}`;
  }
  const safe = String(value).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return safe || `${Date.now()}`;
}

function repairPhysicalGeneration(logicalGeneration: string, manifestSha256: string, activePhysical: string, factory?: () => string): string {
  const stable = stablePhysicalGeneration(logicalGeneration, manifestSha256);
  let candidate = `${stable}@repair-${safeInstanceId(factory)}`;
  if (candidate === activePhysical || candidate === stable) candidate = `${candidate}-repair`;
  return candidate;
}

function stageCatalog(manifest: BootstrapManifest, raw: Uint8Array, manifestSha256: string, physicalGeneration: string): RuntimeStageCatalog {
  const bytes = bufferOf(raw);
  return Object.freeze({
    manifestBytes: bytes,
    manifest: bytes.slice(0),
    rawManifest: bytes.slice(0),
    generation: manifest.generation,
    logicalGeneration: manifest.generation,
    physicalGeneration,
    manifestSha256,
    releaseEpoch: BOOTSTRAP_RELEASE_EPOCH,
    snapshotSha256: manifest.snapshot_sha256,
    snapshotIdentity: manifest.snapshot_sha256,
  });
}

async function openStorage(options: BootstrapRuntimeOptions): Promise<BootstrapStorageRepository | null> {
  if (options.storage !== undefined) return options.storage;
  if (options.storageRepository !== undefined) return options.storageRepository;
  const factory = options.storageFactory ?? openSongsStorage;
  try {
    return await factory(options.indexedDB === undefined ? {} : { indexedDB: options.indexedDB });
  } catch {
    return null;
  }
}

async function cleanup(storage: BootstrapStorageRepository): Promise<string | null> {
  try {
    while (true) {
      const result = await storage.cleanupUnreachable({ maxGenerations: 1 });
      if (!result.hasMore) return null;
    }
  } catch (error) {
    return `songs-v2 cleanup failed: ${errorMessage(error)}`;
  }
}

export async function bootstrapRuntime(options: BootstrapRuntimeOptions = {}): Promise<OperationalResult> {
  throwIfAborted(options.signal);
  const origin = options.origin ?? currentOrigin();
  if (origin === undefined) throw new Error("The V2 bootstrap origin is unavailable");
  const online = typeof options.online === "function" ? options.online() : (options.online ?? browserOnline());
  const trusts = options.acceptedTrusts ?? ACCEPTED_BOOTSTRAP_TRUST;
  const storage = await openStorage(options);

  try {
    const persistence = await requestPersistence(options.storageManager ?? (globalThis.navigator as Navigator | undefined)?.storage);
    let inspection: StorageInspection | null = null;
    let local: LocalEvaluation | null = null;
    let warning: string | null = storage === null ? "songs-v2 IndexedDB is unavailable" : null;

    if (storage !== null) {
      try {
        inspection = await storage.inspect();
        local = await evaluateLocal(storage, inspection, origin, trusts);

        if (local.activeFailure?.kind !== "unsupported") {
          const verifiedCandidates = inspection.snapshots
            .filter((snapshot) => (
              snapshot.state === "verified"
              && snapshot.baseGeneration === inspection!.activeGeneration
              && snapshot.baseTransitionCount === inspection!.transitionCount
            ))
            .sort((left, right) => left.generation.localeCompare(right.generation));
          for (const candidate of verifiedCandidates) {
            try {
              const stored = await storage.readGeneration<RuntimeStageCatalog, unknown, RuntimeArtifactCatalog>(candidate.generation);
              if (stored === null) continue;
              await verifyStoredGeneration(stored, origin, trusts, true);
              await storage.activate(candidate.generation, {
                expectedActiveGeneration: inspection.activeGeneration,
                expectedTransitionCount: inspection.transitionCount,
              });
              const activatedStored = await storage.readActiveGeneration<RuntimeStageCatalog, unknown, RuntimeArtifactCatalog>();
              if (activatedStored === null) throw new Error("verified-stage recovery did not produce an active snapshot");
              const activated = await verifyStoredGeneration(activatedStored, origin, trusts);
              const after = await storage.inspect();
              const cleanupWarning = await cleanup(storage);
              return {
                snapshot: activated.snapshot,
                status: makeStatus("indexeddb", "available", "activated", activated.snapshot, after, { active: activated, retained: local.active }, activated.trust.manifestSha256, persistence, cleanupWarning),
              };
            } catch (error) {
              warning = `verified-stage recovery failed: ${errorMessage(error)}`;
            }
          }
        }

        if (local.active !== null && (!online || local.active.trust.manifestSha256 === PREFERRED_BOOTSTRAP_TRUST.manifestSha256)) {
          return {
            snapshot: local.active.snapshot,
            status: makeStatus("indexeddb", "available", "current", local.active.snapshot, inspection, { active: local.active, retained: local.retained }, local.active.trust.manifestSha256, persistence, null),
          };
        }

        if (local.activeFailure?.kind === "accepted-corrupt" && local.retained !== null && inspection.activeGeneration !== null) {
          try {
            await storage.recoverRetained(local.retained.stored.snapshot.generation, {
              expectedActiveGeneration: inspection.activeGeneration,
              expectedTransitionCount: inspection.transitionCount,
            });
            const recoveredStored = await storage.readActiveGeneration<RuntimeStageCatalog, unknown, RuntimeArtifactCatalog>();
            if (recoveredStored === null) throw new Error("retained recovery did not produce an active snapshot");
            const recovered = await verifyStoredGeneration(recoveredStored, origin, trusts);
            const cleanupWarning = await cleanup(storage);
            const after = await storage.inspect();
            return {
              snapshot: recovered.snapshot,
              status: makeStatus("indexeddb", "available", "recovered", recovered.snapshot, after, { active: recovered, retained: null }, recovered.trust.manifestSha256, persistence, cleanupWarning),
            };
          } catch (error) {
            warning = `retained recovery is pending: ${errorMessage(error)}`;
            return {
              snapshot: local.retained.snapshot,
              status: makeStatus("indexeddb", "available", "failed-retained", local.retained.snapshot, inspection, { active: null, retained: local.retained }, local.retained.trust.manifestSha256, persistence, warning),
            };
          }
        }

        if (local.activeFailure?.kind === "unsupported") {
          if (!online) throw new BootstrapClientError("MANIFEST_UNSUPPORTED", "The active songs-v2 snapshot is newer than this shell release", { activeGeneration: inspection.activeGeneration });
          const payload = await fetchManifest(options, origin);
          requireAcceptedNetworkTrust(payload.manifestSha256, trusts);
          const networkSnapshot = await loadNetwork(payload, options, origin, options.onProgress, options.progress);
          return {
            snapshot: networkSnapshot,
            status: makeStatus("network", "available", "memory-only", networkSnapshot, inspection, { active: null, retained: local.retained }, payload.manifestSha256, persistence, "The active persisted snapshot is unsupported by this shell; the pointer was preserved"),
          };
        }
      } catch (error) {
        warning = `songs-v2 local verification failed: ${errorMessage(error)}`;
        if (error instanceof BootstrapClientError && error.code === "MANIFEST_UNSUPPORTED") {
          if (!online) throw error;
        }
      }
    }

    if (!online) {
      if (local?.activeFailure?.kind === "unsupported") throw new BootstrapClientError("MANIFEST_UNSUPPORTED", "The active songs-v2 snapshot is newer than this shell release");
      throw new BootstrapClientError("NETWORK_OFFLINE", "No verified songs-v2 snapshot is available while offline", warning ?? undefined);
    }

    let payload: NetworkPayload;
    try {
      payload = await fetchManifest(options, origin);
      requireAcceptedNetworkTrust(payload.manifestSha256, trusts);
    } catch (error) {
      if (local?.active !== null && local?.active !== undefined && inspection !== null) {
        return {
          snapshot: local.active.snapshot,
          status: makeStatus("indexeddb", "available", "failed-retained", local.active.snapshot, inspection, { active: local.active, retained: local.retained }, local.active.trust.manifestSha256, persistence, `Snapshot update failed; the active verified generation was retained: ${errorMessage(error)}`),
        };
      }
      throw error;
    }
    const networkManifestSha256 = payload.manifestSha256;
    const needsRepair = local?.activeFailure?.kind === "accepted-corrupt" && inspection?.activeGeneration !== null;
    const stageStorage = storage;
    if (stageStorage === null) {
      const networkSnapshot = await loadNetwork(payload, options, origin, options.onProgress, options.progress);
      return { snapshot: networkSnapshot, status: makeStatus("network", "unavailable", "memory-only", networkSnapshot, null, { active: null, retained: null }, networkManifestSha256, persistence, warning) };
    }

    const logicalGeneration = payload.manifest.generation;
    const expectedActive = inspection?.activeGeneration ?? null;
    const expectedTransitionCount = inspection?.transitionCount ?? 0;
    const resumablePhysical = resumablePhysicalGeneration(inspection, logicalGeneration, networkManifestSha256, expectedActive, expectedTransitionCount);
    const physicalGeneration = resumablePhysical ?? (needsRepair
      ? repairPhysicalGeneration(logicalGeneration, networkManifestSha256, inspection?.activeGeneration ?? "", options.instanceIdFactory)
      : stablePhysicalGeneration(logicalGeneration, networkManifestSha256));
    let stagingFailed: string | null = null;
    let stageStarted = false;
    const staging = {
      begin: async (manifest: BootstrapManifest, raw: Uint8Array) => {
        if (stagingFailed !== null) return;
        try {
          stageStarted = true;
          const current = await stageStorage.inspect();
          const existing = current.snapshots.find((snapshot) => snapshot.generation === physicalGeneration);
          const resumable = existing !== undefined
            && (existing.state === "staging" || existing.state === "verified")
            && existing.baseGeneration === expectedActive
            && existing.baseTransitionCount === expectedTransitionCount
            && existing.stageIdentity === networkManifestSha256
            && catalogString(existing.catalog, "logicalGeneration") === logicalGeneration
            && catalogString(existing.catalog, "manifestSha256") === networkManifestSha256
            && catalogNumber(existing.catalog, "releaseEpoch") === BOOTSTRAP_RELEASE_EPOCH;
          if (existing !== undefined && !resumable && physicalGeneration !== current.activeGeneration && physicalGeneration !== current.retainedGeneration) await stageStorage.discardUnreachableGeneration(physicalGeneration);
          if (physicalGeneration === current.activeGeneration || physicalGeneration === current.retainedGeneration) throw new SongsStorageError("STAGE_STATE", "The physical stage key is already pointed");
          await stageStorage.beginStage({
            generation: physicalGeneration,
            catalog: stageCatalog(manifest, raw, networkManifestSha256, physicalGeneration),
            expectedChunks: manifest.chunks.length,
            expectedArtifacts: manifest.counts.documents,
            stageIdentity: networkManifestSha256,
            expectedActiveGeneration: expectedActive,
            expectedTransitionCount,
          });
        } catch (error) {
          stagingFailed = `songs-v2 staging failed: ${errorMessage(error)}`;
        }
      },
      chunk: async (descriptor: BootstrapManifest["chunks"][number], raw: Uint8Array, documents: readonly BootstrapDocument[]) => {
        if (stagingFailed !== null) return;
        try {
          await stageStorage.putVerifiedChunkAndArtifacts(
            physicalGeneration,
            { index: descriptor.index, bytes: bufferOf(raw), catalog: { index: descriptor.index, path: descriptor.path, sha256: descriptor.sha256 } },
            documents.map((document) => ({
              path: document.path,
              bytes: bufferOf(decodeBase64(document.source.content_base64)),
              catalog: {
                id: document.id,
                ordinal: document.ordinal,
                kind: document.kind,
                slug: document.slug,
                documentSha256: document.verification.document_sha256,
                sourceSha256: document.source.sha256,
                chunkIndex: descriptor.index,
              } satisfies RuntimeArtifactCatalog,
            })),
          );
        } catch (error) {
          stagingFailed = `songs-v2 staging failed: ${errorMessage(error)}`;
        }
      },
    };

    let networkSnapshot: VerifiedSnapshot;
    try {
      networkSnapshot = await loadVerifiedSnapshot({
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        origin,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        verifiedManifest: payload,
        staging,
        onProgress: (progress) => {
          options.onProgress?.(progress);
          options.progress?.(progress);
        },
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (local?.active !== null && local?.active !== undefined && inspection !== null) {
        return { snapshot: local.active.snapshot, status: makeStatus("indexeddb", "available", "failed-retained", local.active.snapshot, inspection, { active: local.active, retained: local.retained }, local.active.trust.manifestSha256, persistence, `Snapshot update failed; the active verified generation was retained: ${errorMessage(error)}`) };
      }
      throw error;
    }

    if (stagingFailed !== null || !stageStarted) {
      if (local?.active !== null && local?.active !== undefined && inspection !== null) {
        return { snapshot: local.active.snapshot, status: makeStatus("indexeddb", "available", "failed-retained", local.active.snapshot, inspection, { active: local.active, retained: local.retained }, local.active.trust.manifestSha256, persistence, stagingFailed ?? warning) };
      }
      return { snapshot: networkSnapshot, status: makeStatus("memory", "available", "memory-only", networkSnapshot, inspection, { active: null, retained: local?.retained ?? null }, networkManifestSha256, persistence, stagingFailed ?? warning) };
    }

    try {
      const durable = await stageStorage.readGeneration<RuntimeStageCatalog, unknown, RuntimeArtifactCatalog>(physicalGeneration);
      if (durable === null) throw new Error("the completed stage is missing");
      await verifyStoredGeneration(durable, origin, trusts, true);
      await stageStorage.markVerified(physicalGeneration);
      await stageStorage.activate(physicalGeneration, {
        expectedActiveGeneration: expectedActive,
        expectedTransitionCount,
      });
      const activeStored = await stageStorage.readActiveGeneration<RuntimeStageCatalog, unknown, RuntimeArtifactCatalog>();
      if (activeStored === null) throw new Error("activation did not produce an active snapshot");
      const activated = await verifyStoredGeneration(activeStored, origin, trusts);
      let retained: VerifiedStored | null = null;
      try {
        const retainedStored = await stageStorage.readRetainedGeneration<RuntimeStageCatalog, unknown, RuntimeArtifactCatalog>();
        if (retainedStored !== null) retained = await verifyStoredGeneration(retainedStored, origin, trusts);
      } catch {
        // A corrupt retained generation is preserved but never exposed as verified.
      }
      const after = await stageStorage.inspect();
      const cleanupWarning = await cleanup(stageStorage);
      const finalInspection = cleanupWarning === null ? await stageStorage.inspect() : after;
      return {
        snapshot: activated.snapshot,
        status: makeStatus("indexeddb", "available", "activated", activated.snapshot, finalInspection, { active: activated, retained }, activated.trust.manifestSha256, persistence, cleanupWarning),
      };
    } catch (error) {
      if (local?.active !== null && local?.active !== undefined && inspection !== null) {
        return { snapshot: local.active.snapshot, status: makeStatus("indexeddb", "available", "failed-retained", local.active.snapshot, inspection, { active: local.active, retained: local.retained }, local.active.trust.manifestSha256, persistence, `Snapshot update persistence failed; the active verified generation was retained: ${errorMessage(error)}`) };
      }
      return { snapshot: networkSnapshot, status: makeStatus("memory", "available", "memory-only", networkSnapshot, inspection, { active: null, retained: local?.retained ?? null }, networkManifestSha256, persistence, `songs-v2 persistence failed: ${errorMessage(error)}`) };
    }
  } finally {
    storage?.close?.();
  }
}

type NetworkPayload = Awaited<ReturnType<typeof fetchReviewedManifest>>;

async function fetchManifest(options: BootstrapRuntimeOptions, origin: string): Promise<NetworkPayload> {
  return fetchReviewedManifest({
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    origin,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

async function loadNetwork(
  payload: NetworkPayload,
  options: BootstrapRuntimeOptions,
  origin: string,
  onProgress?: (progress: SnapshotProgress) => void,
  progress?: (progress: SnapshotProgress) => void,
): Promise<VerifiedSnapshot> {
  return loadVerifiedSnapshot({
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    origin,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    verifiedManifest: payload,
    onProgress: (value) => {
      onProgress?.(value);
      progress?.(value);
    },
  });
}

export type OperationalStatus = BootstrapRuntimeStatus;
export type RuntimeOptions = BootstrapRuntimeOptions;
export const bootstrap = bootstrapRuntime;
export const openBootstrapRuntime = bootstrapRuntime;
export const loadBootstrapRuntime = bootstrapRuntime;
export default bootstrapRuntime;
