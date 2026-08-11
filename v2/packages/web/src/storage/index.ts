export const SONGS_STORAGE_NAME = "songs-v2";
export const SONGS_STORAGE_VERSION = 2;

/** The TASK-006 schema. These names are deliberately fixed and V2-only. */
export const SONGS_STORAGE_STORES = [
  "snapshots",
  "documents",
  "chunks",
  "meta",
  "outbox",
  "drafts",
  "conflicts",
] as const;

export type SongsStorageStore = (typeof SONGS_STORAGE_STORES)[number];
export type GenerationState = "staging" | "verified" | "active" | "retained" | "obsolete";

export type SongsStorageErrorCode =
  | "OPEN_BLOCKED"
  | "SCHEMA_NEWER"
  | "SCHEMA_INVALID"
  | "OPEN_FAILED"
  | "VERSION_CHANGE"
  | "CLOSED"
  | "TRANSACTION_FAILED"
  | "INVALID_INPUT"
  | "STAGE_NOT_FOUND"
  | "STAGE_STATE"
  | "STAGE_INCOMPLETE"
  | "CAS_STALE"
  | "INTEGRITY";

/** A typed, fail-closed error from the V2 storage boundary. */
export class SongsStorageError extends Error {
  constructor(readonly code: SongsStorageErrorCode, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "SongsStorageError";
  }
}

export interface OpenSongsStorageOptions {
  /** Injection point for tests; callers cannot select another database name. */
  readonly indexedDB?: IDBFactory;
}

export interface BeginStageOptions<Catalog> {
  readonly generation: string;
  /** Already-verified manifest/catalog data. It must be structured-cloneable. */
  readonly catalog: Catalog;
  readonly expectedChunks: number;
  readonly expectedArtifacts: number;
  /**
   * Binds retries to the exact reviewed stage input. It is intentionally
   * caller-defined because integrity verification happens before storage I/O.
   */
  readonly stageIdentity?: string;
  /**
   * Optional compare-and-swap guard for beginning a stage.  When omitted the
   * current active generation is captured as the stage's activation base.
   */
  readonly expectedActiveGeneration?: string | null;
  /** Optional CAS guard captured alongside the active-generation pointer. */
  readonly expectedTransitionCount?: number;
}

export interface VerifiedChunk<Catalog = undefined> {
  readonly index: number;
  /** Raw, pre-verified bytes. Storage never hashes or fetches inside a transaction. */
  readonly bytes: ArrayBuffer;
  readonly catalog?: Catalog;
}

export interface VerifiedArtifact<Catalog = undefined> {
  readonly path: string;
  /** Raw, pre-verified bytes. Storage never parses, hashes, or fetches these bytes. */
  readonly bytes: ArrayBuffer;
  readonly catalog?: Catalog;
}

export interface GenerationInfo<Catalog = unknown> {
  readonly generation: string;
  readonly state: GenerationState;
  readonly catalog: Catalog;
  readonly expectedChunks: number;
  readonly expectedArtifacts: number;
  /** Exact identity required to resume this stage, when one was supplied. */
  readonly stageIdentity?: string;
  /** The active generation that was current when this stage began. */
  readonly baseGeneration: string | null;
  /** Pointer transition epoch captured with baseGeneration to prevent ABA. */
  readonly baseTransitionCount: number;
}

export interface StoredChunk<Catalog = unknown> {
  readonly index: number;
  readonly bytes: ArrayBuffer;
  readonly catalog?: Catalog;
}

export interface StoredArtifact<Catalog = unknown> {
  readonly path: string;
  readonly bytes: ArrayBuffer;
  readonly catalog?: Catalog;
}

export interface StoredGeneration<GenerationCatalog = unknown, ChunkCatalog = unknown, ArtifactCatalog = unknown> {
  readonly snapshot: GenerationInfo<GenerationCatalog>;
  readonly chunks: readonly StoredChunk<ChunkCatalog>[];
  readonly artifacts: readonly StoredArtifact<ArtifactCatalog>[];
}

export interface ActivationOptions {
  /** An additional caller-side CAS guard, in addition to the stage base. */
  readonly expectedActiveGeneration?: string | null;
  /** CAS guard for the active pointer's monotonic transition epoch. */
  readonly expectedTransitionCount?: number;
}

export interface ActivationResult {
  readonly generation: string;
  readonly activated: boolean;
  readonly idempotent: boolean;
  readonly previousGeneration: string | null;
  readonly transitionCount: number;
}

export interface RecoveryOptions {
  /** CAS guard captured before external verification began. */
  readonly expectedActiveGeneration?: string | null;
  /** CAS guard captured before external verification began. */
  readonly expectedTransitionCount?: number;
}

export interface RecoveryResult {
  readonly generation: string;
  readonly recovered: boolean;
  readonly idempotent: boolean;
  /** The active generation that external verification rejected. */
  readonly replacedGeneration: string | null;
  readonly transitionCount: number;
}

export interface DiscardResult {
  readonly generation: string;
  readonly discarded: boolean;
}

export interface CleanupOptions {
  /**
   * Keep cleanup transactions bounded. Call again when `hasMore` is true.
   * The default removes one unreachable generation.
   */
  readonly maxGenerations?: number;
}

export interface CleanupResult {
  readonly removed: readonly string[];
  readonly hasMore: boolean;
}

export interface StorageInspection {
  readonly database: typeof SONGS_STORAGE_NAME;
  readonly version: number;
  readonly activeGeneration: string | null;
  readonly retainedGeneration: string | null;
  readonly transitionCount: number;
  readonly snapshots: readonly GenerationInfo[];
  readonly pending: Readonly<{ outbox: number; drafts: number; conflicts: number }>;
}

type MetaRecord = { key: string; value: unknown };
type SnapshotRecord = {
  generation: string;
  state: GenerationState;
  catalog: unknown;
  expectedChunks: number;
  expectedArtifacts: number;
  stageIdentity?: string;
  baseGeneration: string | null;
  baseTransitionCount: number;
};
type ChunkRecord = { generation: string; index: number; bytes: ArrayBuffer; catalog?: unknown };
type ArtifactRecord = { generation: string; path: string; bytes: ArrayBuffer; catalog?: unknown };

const ACTIVE_GENERATION_KEY = "active-generation";
const RETAINED_GENERATION_KEY = "retained-generation";
const POINTER_TRANSITIONS_KEY = "pointer-transitions";
const ALL_CONTENT_STORES = ["snapshots", "documents", "chunks", "meta"] as const;

function storageError(code: SongsStorageErrorCode, message: string, detail?: unknown): SongsStorageError {
  return new SongsStorageError(code, message, detail);
}

function errorName(error: unknown): string | undefined {
  return error instanceof DOMException || error instanceof Error ? error.name : undefined;
}

function asStorageError(error: unknown, fallback = "IndexedDB transaction failed"): SongsStorageError {
  if (error instanceof SongsStorageError) return error;
  return storageError("TRANSACTION_FAILED", fallback, { name: errorName(error) });
}

function copyBytes(bytes: ArrayBuffer): ArrayBuffer {
  return bytes.slice(0);
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch (error) {
    throw storageError("INVALID_INPUT", "Storage values must be structured-cloneable", { name: errorName(error) });
  }
}

function ensureGeneration(value: string): void {
  if (value.length === 0) throw storageError("INVALID_INPUT", "A generation must not be empty");
}

function ensureCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw storageError("INVALID_INPUT", `${name} must be a non-negative safe integer`);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? storageError("TRANSACTION_FAILED", "IndexedDB request failed"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? storageError("TRANSACTION_FAILED", "IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? storageError("TRANSACTION_FAILED", "IndexedDB transaction aborted"));
  });
}

function createBaseStores(database: IDBDatabase): void {
  if (!database.objectStoreNames.contains("snapshots")) database.createObjectStore("snapshots", { keyPath: "generation" });
  if (!database.objectStoreNames.contains("documents")) database.createObjectStore("documents", { keyPath: ["generation", "path"] });
  if (!database.objectStoreNames.contains("chunks")) database.createObjectStore("chunks", { keyPath: ["generation", "index"] });
  if (!database.objectStoreNames.contains("meta")) database.createObjectStore("meta", { keyPath: "key" });
  if (!database.objectStoreNames.contains("outbox")) database.createObjectStore("outbox", { keyPath: "id" });
  if (!database.objectStoreNames.contains("drafts")) database.createObjectStore("drafts", { keyPath: "id" });
}

const REQUIRED_STORE_KEY_PATHS: Readonly<Record<SongsStorageStore, string | readonly string[]>> = {
  snapshots: "generation",
  documents: ["generation", "path"],
  chunks: ["generation", "index"],
  meta: "key",
  outbox: "id",
  drafts: "id",
  conflicts: "id",
};

function keyPathMatches(actual: string | string[] | null, expected: string | readonly string[]): boolean {
  if (typeof expected === "string") return actual === expected;
  return Array.isArray(actual) && actual.length === expected.length && actual.every((part, index) => part === expected[index]);
}

/**
 * Version 2 can validate its fixed schema but must never try to repair a
 * same-version database: missing stores/key paths require a future migration.
 */
async function validateSchema(database: IDBDatabase): Promise<void> {
  const missing = SONGS_STORAGE_STORES.filter((store) => !database.objectStoreNames.contains(store));
  if (missing.length > 0) throw storageError("SCHEMA_INVALID", "songs-v2 schema is missing required stores", { missing });
  const transaction = database.transaction([...SONGS_STORAGE_STORES], "readonly");
  const invalidKeyPaths = SONGS_STORAGE_STORES.flatMap((store) => {
    const actual = transaction.objectStore(store).keyPath;
    const expected = REQUIRED_STORE_KEY_PATHS[store];
    return keyPathMatches(actual, expected) ? [] : [{ store, expected, actual }];
  });
  await transactionComplete(transaction);
  if (invalidKeyPaths.length > 0) throw storageError("SCHEMA_INVALID", "songs-v2 schema has invalid store key paths", { invalidKeyPaths });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(SONGS_STORAGE_NAME, SONGS_STORAGE_VERSION);
    } catch (error) {
      const code = errorName(error) === "VersionError" ? "SCHEMA_NEWER" : "OPEN_FAILED";
      reject(storageError(code, "Unable to open the songs-v2 IndexedDB database", { name: errorName(error) }));
      return;
    }
    request.onupgradeneeded = (event) => {
      const database = request.result;
      // This is intentionally additive: v1 had the six base stores and v2
      // only adds conflicts, leaving pending records untouched.
      if (event.oldVersion < 1) createBaseStores(database);
      if (event.oldVersion < 2 && !database.objectStoreNames.contains("conflicts")) {
        database.createObjectStore("conflicts", { keyPath: "id" });
      }
    };
    request.onblocked = () => settle(() => reject(storageError("OPEN_BLOCKED", "songs-v2 is blocked by another open database connection")));
    request.onerror = () => {
      const name = errorName(request.error);
      const code = name === "VersionError" ? "SCHEMA_NEWER" : "OPEN_FAILED";
      settle(() => reject(storageError(code, "Unable to open the songs-v2 IndexedDB database", { name })));
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      void validateSchema(request.result).then(
        () => {
          if (settled) {
            request.result.close();
            return;
          }
          settled = true;
          resolve(request.result);
        },
        (error: unknown) => {
          request.result.close();
          settle(() => reject(error instanceof SongsStorageError ? error : storageError("SCHEMA_INVALID", "songs-v2 schema validation failed", { name: errorName(error) })));
        },
      );
    };
  });
}

function valueFromMeta(record: MetaRecord | undefined, key: string): string | null {
  if (record === undefined) return null;
  if (typeof record.value !== "string") throw storageError("INTEGRITY", `Metadata ${key} is not a generation string`);
  return record.value;
}

function transitionsFromMeta(record: MetaRecord | undefined): number {
  if (record === undefined) return 0;
  if (!Number.isSafeInteger(record.value) || (record.value as number) < 0) throw storageError("INTEGRITY", "Metadata pointer-transitions is invalid");
  return record.value as number;
}

function baseTransitionFromSnapshot(record: SnapshotRecord): number {
  if (!Number.isSafeInteger(record.baseTransitionCount) || record.baseTransitionCount < 0) {
    throw storageError("INTEGRITY", "A staging snapshot is missing its base pointer transition count", { generation: record.generation });
  }
  return record.baseTransitionCount;
}

function stateOf(record: unknown): GenerationState {
  if (record === null || typeof record !== "object" || !("state" in record)) throw storageError("INTEGRITY", "Snapshot state is missing");
  const state = (record as { state?: unknown }).state;
  if (state === "staging" || state === "verified" || state === "active" || state === "retained" || state === "obsolete") return state;
  throw storageError("INTEGRITY", "Snapshot state is invalid");
}

function snapshotInfo<Catalog = unknown>(record: SnapshotRecord): GenerationInfo<Catalog> {
  const state = stateOf(record);
  if (typeof record.generation !== "string") throw storageError("INTEGRITY", "Snapshot generation is invalid");
  const expectedChunks = Number.isSafeInteger(record.expectedChunks) && record.expectedChunks >= 0 ? record.expectedChunks : 0;
  const expectedArtifacts = Number.isSafeInteger(record.expectedArtifacts) && record.expectedArtifacts >= 0 ? record.expectedArtifacts : 0;
  if (record.stageIdentity !== undefined && typeof record.stageIdentity !== "string") throw storageError("INTEGRITY", "Snapshot stageIdentity is invalid");
  const stageIdentity = record.stageIdentity;
  const baseGeneration = typeof record.baseGeneration === "string" ? record.baseGeneration : null;
  const baseTransitionCount = Number.isSafeInteger(record.baseTransitionCount) && record.baseTransitionCount >= 0 ? record.baseTransitionCount : 0;
  return Object.freeze({
    generation: record.generation,
    state,
    catalog: cloneValue(record.catalog) as Catalog,
    expectedChunks,
    expectedArtifacts,
    ...(stageIdentity === undefined ? {} : { stageIdentity }),
    baseGeneration,
    baseTransitionCount,
  });
}

function snapshotRecord(record: unknown): SnapshotRecord | undefined {
  return record === undefined ? undefined : record as SnapshotRecord;
}

function isKeyForGeneration(key: IDBValidKey, generation: string): boolean {
  return Array.isArray(key) && key[0] === generation;
}

function copiedChunk<Catalog>(chunk: VerifiedChunk<Catalog>): ChunkRecord {
  ensureCount(chunk.index, "Chunk index");
  const catalog = chunk.catalog === undefined ? undefined : cloneValue(chunk.catalog);
  return {
    generation: "",
    index: chunk.index,
    bytes: copyBytes(chunk.bytes),
    ...(catalog === undefined ? {} : { catalog }),
  };
}

function copiedArtifact<Catalog>(artifact: VerifiedArtifact<Catalog>): ArtifactRecord {
  if (artifact.path.length === 0) throw storageError("INVALID_INPUT", "Artifact paths must not be empty");
  const catalog = artifact.catalog === undefined ? undefined : cloneValue(artifact.catalog);
  return {
    generation: "",
    path: artifact.path,
    bytes: copyBytes(artifact.bytes),
    ...(catalog === undefined ? {} : { catalog }),
  };
}

/**
 * Production storage core for TASK-012. It accepts only already-verified data:
 * checksum work, parsing, and networking must happen before these methods are
 * called. Every database transaction contains IndexedDB requests only.
 */
export class SongsStorage {
  private closed = false;
  private changedVersion = false;

  private constructor(private readonly database: IDBDatabase) {
    this.database.onversionchange = () => {
      this.changedVersion = true;
      this.database.close();
    };
  }

  /** Open the one reserved TASK-012 namespace at schema version 2. */
  static async open(options: OpenSongsStorageOptions = {}): Promise<SongsStorage> {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (factory === undefined) throw storageError("OPEN_FAILED", "IndexedDB is not available in this browser");
    return new SongsStorage(await openDatabase(factory));
  }

  /** Close this connection. A connection closed for versionchange stays failed-closed. */
  close(): void {
    if (!this.closed) this.database.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.changedVersion) throw storageError("VERSION_CHANGE", "songs-v2 closed because another context changed its schema");
    if (this.closed) throw storageError("CLOSED", "songs-v2 storage is closed");
  }

  private async transaction<T>(stores: readonly SongsStorageStore[], mode: IDBTransactionMode, operation: (transaction: IDBTransaction) => Promise<T>): Promise<T> {
    this.assertOpen();
    let transaction: IDBTransaction;
    try {
      transaction = this.database.transaction([...stores], mode);
    } catch (error) {
      throw asStorageError(error, "Unable to start IndexedDB transaction");
    }
    const complete = transactionComplete(transaction);
    try {
      const result = await operation(transaction);
      await complete;
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have completed or aborted.
      }
      let terminalError: unknown = error;
      try {
        await complete;
      } catch (completionError) {
        terminalError = error instanceof SongsStorageError ? error : completionError;
      }
      throw asStorageError(terminalError);
    }
  }

  /** Begin (or resume) a private, non-visible generation stage. */
  async beginStage<Catalog>(options: BeginStageOptions<Catalog>): Promise<GenerationInfo<Catalog>> {
    ensureGeneration(options.generation);
    ensureCount(options.expectedChunks, "expectedChunks");
    ensureCount(options.expectedArtifacts, "expectedArtifacts");
    if (options.expectedTransitionCount !== undefined) ensureCount(options.expectedTransitionCount, "expectedTransitionCount");
    if (options.stageIdentity !== undefined && typeof options.stageIdentity !== "string") throw storageError("INVALID_INPUT", "stageIdentity must be a string when supplied");
    const catalog = cloneValue(options.catalog);
    return this.transaction(["snapshots", "meta"], "readwrite", async (transaction) => {
      const snapshots = transaction.objectStore("snapshots");
      const meta = transaction.objectStore("meta");
      const existingRequest = snapshots.get(options.generation);
      const activeRequest = meta.get(ACTIVE_GENERATION_KEY);
      const transitionsRequest = meta.get(POINTER_TRANSITIONS_KEY);
      const [existingValue, activeValue, transitionsValue] = await Promise.all([
        requestResult(existingRequest),
        requestResult(activeRequest),
        requestResult(transitionsRequest),
      ]);
      const active = valueFromMeta(activeValue as MetaRecord | undefined, ACTIVE_GENERATION_KEY);
      const transitions = transitionsFromMeta(transitionsValue as MetaRecord | undefined);
      if (
        (options.expectedActiveGeneration !== undefined && options.expectedActiveGeneration !== active)
        || (options.expectedTransitionCount !== undefined && options.expectedTransitionCount !== transitions)
      ) {
        throw storageError("CAS_STALE", "The active generation or pointer transition count changed before staging began", {
          expectedActiveGeneration: options.expectedActiveGeneration,
          actualActiveGeneration: active,
          expectedTransitionCount: options.expectedTransitionCount,
          actualTransitionCount: transitions,
        });
      }
      const existing = snapshotRecord(existingValue);
      if (existing !== undefined) {
        const info = snapshotInfo<Catalog>(existing);
        const baseTransitionCount = info.state === "staging" || info.state === "verified" ? baseTransitionFromSnapshot(existing) : null;
        if (
          (info.state === "staging" || info.state === "verified")
          && info.baseGeneration === active
          && baseTransitionCount === transitions
          && info.expectedChunks === options.expectedChunks
          && info.expectedArtifacts === options.expectedArtifacts
          && info.stageIdentity === options.stageIdentity
        ) {
          return info;
        }
        throw storageError("STAGE_STATE", "This generation cannot be restaged without cleanup", { generation: options.generation, state: info.state });
      }
      const record: SnapshotRecord = {
        generation: options.generation,
        state: "staging",
        catalog,
        expectedChunks: options.expectedChunks,
        expectedArtifacts: options.expectedArtifacts,
        ...(options.stageIdentity === undefined ? {} : { stageIdentity: options.stageIdentity }),
        baseGeneration: active,
        baseTransitionCount: transitions,
      };
      snapshots.put(record);
      return snapshotInfo<Catalog>(record);
    });
  }

  /** Store one already-verified transport chunk while its stage is still private. */
  async putVerifiedChunk<Catalog = undefined>(generation: string, chunk: VerifiedChunk<Catalog>): Promise<void> {
    const copied = copiedChunk(chunk);
    await this.writeVerified(generation, copied, []);
  }

  /** Store already-verified document/artifact bytes while its stage is still private. */
  async putVerifiedArtifacts<Catalog = undefined>(generation: string, artifacts: readonly VerifiedArtifact<Catalog>[]): Promise<void> {
    const copied = artifacts.map(copiedArtifact);
    await this.writeVerified(generation, undefined, copied);
  }

  /** Convenience singular form for bounded per-artifact writers. */
  async putVerifiedArtifact<Catalog = undefined>(generation: string, artifact: VerifiedArtifact<Catalog>): Promise<void> {
    await this.putVerifiedArtifacts(generation, [artifact]);
  }

  /** Atomically write a verified chunk and the artifacts it carried. */
  async putVerifiedChunkAndArtifacts<ChunkCatalog = undefined, ArtifactCatalog = undefined>(generation: string, chunk: VerifiedChunk<ChunkCatalog>, artifacts: readonly VerifiedArtifact<ArtifactCatalog>[]): Promise<void> {
    const copiedChunkValue = copiedChunk(chunk);
    const copiedArtifacts = artifacts.map(copiedArtifact);
    await this.writeVerified(generation, copiedChunkValue, copiedArtifacts);
  }

  private async writeVerified(generation: string, chunk: ChunkRecord | undefined, artifacts: readonly ArtifactRecord[]): Promise<void> {
    ensureGeneration(generation);
    const paths = new Set<string>();
    for (const artifact of artifacts) {
      if (paths.has(artifact.path)) throw storageError("INVALID_INPUT", "A verified artifact batch has duplicate paths", { path: artifact.path });
      paths.add(artifact.path);
    }
    await this.transaction(["snapshots", "chunks", "documents"], "readwrite", async (transaction) => {
      const snapshots = transaction.objectStore("snapshots");
      const snapshot = snapshotRecord(await requestResult(snapshots.get(generation)));
      if (snapshot === undefined) throw storageError("STAGE_NOT_FOUND", "Cannot write to an unknown stage", { generation });
      if (stateOf(snapshot) !== "staging") throw storageError("STAGE_STATE", "Verified bytes can only be written to a staging generation", { generation, state: stateOf(snapshot) });
      if (chunk !== undefined) transaction.objectStore("chunks").put({ ...chunk, generation });
      const documents = transaction.objectStore("documents");
      for (const artifact of artifacts) documents.put({ ...artifact, generation });
    });
  }

  /**
   * Seal a stage only after the caller has verified the whole manifest. The
   * count check prevents an incomplete stage from reaching activation.
   */
  async markVerified<Catalog = unknown>(generation: string): Promise<GenerationInfo<Catalog>> {
    ensureGeneration(generation);
    return this.transaction(["snapshots", "chunks", "documents"], "readwrite", async (transaction) => {
      const snapshots = transaction.objectStore("snapshots");
      const chunks = transaction.objectStore("chunks");
      const documents = transaction.objectStore("documents");
      const snapshotRequest = snapshots.get(generation);
      const chunkKeysRequest = chunks.getAllKeys();
      const artifactKeysRequest = documents.getAllKeys();
      const [value, chunkKeys, artifactKeys] = await Promise.all([
        requestResult(snapshotRequest),
        requestResult(chunkKeysRequest),
        requestResult(artifactKeysRequest),
      ]);
      const snapshot = snapshotRecord(value);
      if (snapshot === undefined) throw storageError("STAGE_NOT_FOUND", "Cannot verify an unknown stage", { generation });
      const info = snapshotInfo<Catalog>(snapshot);
      if (info.state === "verified") return info;
      if (info.state !== "staging") throw storageError("STAGE_STATE", "Only a staging generation can be marked verified", { generation, state: info.state });
      const chunkCount = (chunkKeys as IDBValidKey[]).filter((key) => isKeyForGeneration(key, generation)).length;
      const artifactCount = (artifactKeys as IDBValidKey[]).filter((key) => isKeyForGeneration(key, generation)).length;
      if (chunkCount !== info.expectedChunks || artifactCount !== info.expectedArtifacts) {
        throw storageError("STAGE_INCOMPLETE", "A stage does not contain every verified chunk and artifact", {
          generation,
          expectedChunks: info.expectedChunks,
          actualChunks: chunkCount,
          expectedArtifacts: info.expectedArtifacts,
          actualArtifacts: artifactCount,
        });
      }
      const verified: SnapshotRecord = { ...snapshot, state: "verified" };
      snapshots.put(verified);
      return snapshotInfo<Catalog>(verified);
    });
  }

  /**
   * Atomically move the sole active pointer. The immediately previous active
   * snapshot is retained; repeated activation of the active generation is a
   * no-op and does not increment the pointer transition counter.
   */
  async activate(generation: string, options: ActivationOptions = {}): Promise<ActivationResult> {
    ensureGeneration(generation);
    if (options.expectedTransitionCount !== undefined) ensureCount(options.expectedTransitionCount, "expectedTransitionCount");
    return this.transaction(["snapshots", "meta"], "readwrite", async (transaction) => {
      const snapshots = transaction.objectStore("snapshots");
      const meta = transaction.objectStore("meta");
      const targetRequest = snapshots.get(generation);
      const activeRequest = meta.get(ACTIVE_GENERATION_KEY);
      const retainedRequest = meta.get(RETAINED_GENERATION_KEY);
      const transitionsRequest = meta.get(POINTER_TRANSITIONS_KEY);
      const [targetValue, activeValue, retainedValue, transitionsValue] = await Promise.all([
        requestResult(targetRequest),
        requestResult(activeRequest),
        requestResult(retainedRequest),
        requestResult(transitionsRequest),
      ]);
      const target = snapshotRecord(targetValue);
      if (target === undefined) throw storageError("STAGE_NOT_FOUND", "Cannot activate an unknown generation", { generation });
      const active = valueFromMeta(activeValue as MetaRecord | undefined, ACTIVE_GENERATION_KEY);
      const retained = valueFromMeta(retainedValue as MetaRecord | undefined, RETAINED_GENERATION_KEY);
      const transitions = transitionsFromMeta(transitionsValue as MetaRecord | undefined);
      if (
        (options.expectedActiveGeneration !== undefined && options.expectedActiveGeneration !== active)
        || (options.expectedTransitionCount !== undefined && options.expectedTransitionCount !== transitions)
      ) {
        throw storageError("CAS_STALE", "The active generation or pointer transition count did not match the activation precondition", {
          expectedActiveGeneration: options.expectedActiveGeneration,
          actualActiveGeneration: active,
          expectedTransitionCount: options.expectedTransitionCount,
          actualTransitionCount: transitions,
        });
      }
      const targetState = stateOf(target);

      if (targetState === "active") {
        if (active !== generation) throw storageError("INTEGRITY", "The active snapshot and active-generation pointer disagree", { generation, active });
        return Object.freeze({ generation, activated: false, idempotent: true, previousGeneration: retained, transitionCount: transitions });
      }
      if (targetState !== "verified") throw storageError("STAGE_STATE", "Only a verified generation can be activated", { generation, state: targetState });
      const base = typeof target.baseGeneration === "string" ? target.baseGeneration : null;
      const baseTransitionCount = baseTransitionFromSnapshot(target);
      if (base !== active || baseTransitionCount !== transitions) {
        throw storageError("CAS_STALE", "This stage was built against a stale active generation or pointer transition count", {
          generation,
          expectedActiveGeneration: base,
          actualActiveGeneration: active,
          expectedTransitionCount: baseTransitionCount,
          actualTransitionCount: transitions,
        });
      }

      let previous: SnapshotRecord | undefined;
      if (active !== null) {
        previous = snapshotRecord(await requestResult(snapshots.get(active)));
        if (previous === undefined || stateOf(previous) !== "active") {
          throw storageError("INTEGRITY", "The active-generation pointer has no active snapshot", { active });
        }
      }
      let previouslyRetained: SnapshotRecord | undefined;
      if (retained !== null) {
        previouslyRetained = snapshotRecord(await requestResult(snapshots.get(retained)));
        if (previouslyRetained === undefined || stateOf(previouslyRetained) !== "retained") {
          throw storageError("INTEGRITY", "The retained-generation pointer has no retained snapshot", { retained });
        }
      }

      if (previouslyRetained !== undefined && retained !== active) snapshots.put({ ...previouslyRetained, state: "obsolete" });
      if (previous !== undefined) snapshots.put({ ...previous, state: "retained" });
      snapshots.put({ ...target, state: "active" });
      meta.put({ key: ACTIVE_GENERATION_KEY, value: generation } satisfies MetaRecord);
      if (active === null) meta.delete(RETAINED_GENERATION_KEY);
      else meta.put({ key: RETAINED_GENERATION_KEY, value: active } satisfies MetaRecord);
      meta.put({ key: POINTER_TRANSITIONS_KEY, value: transitions + 1 } satisfies MetaRecord);
      return Object.freeze({ generation, activated: true, idempotent: false, previousGeneration: active, transitionCount: transitions + 1 });
    });
  }

  /**
   * Promote a retained generation only after the caller has independently
   * re-verified it. This method performs no hashing, parsing, or network I/O.
   */
  async recoverRetained(generation: string, options: RecoveryOptions = {}): Promise<RecoveryResult> {
    ensureGeneration(generation);
    if (options.expectedTransitionCount !== undefined) ensureCount(options.expectedTransitionCount, "expectedTransitionCount");
    if (options.expectedActiveGeneration !== undefined && options.expectedActiveGeneration !== null && typeof options.expectedActiveGeneration !== "string") {
      throw storageError("INVALID_INPUT", "expectedActiveGeneration must be a generation string or null");
    }
    return this.transaction(["snapshots", "meta"], "readwrite", async (transaction) => {
      const snapshots = transaction.objectStore("snapshots");
      const meta = transaction.objectStore("meta");
      const targetRequest = snapshots.get(generation);
      const activeRequest = meta.get(ACTIVE_GENERATION_KEY);
      const retainedRequest = meta.get(RETAINED_GENERATION_KEY);
      const transitionsRequest = meta.get(POINTER_TRANSITIONS_KEY);
      const [targetValue, activeValue, retainedValue, transitionsValue] = await Promise.all([
        requestResult(targetRequest),
        requestResult(activeRequest),
        requestResult(retainedRequest),
        requestResult(transitionsRequest),
      ]);
      const target = snapshotRecord(targetValue);
      const active = valueFromMeta(activeValue as MetaRecord | undefined, ACTIVE_GENERATION_KEY);
      const retained = valueFromMeta(retainedValue as MetaRecord | undefined, RETAINED_GENERATION_KEY);
      const transitions = transitionsFromMeta(transitionsValue as MetaRecord | undefined);
      if (
        (options.expectedActiveGeneration !== undefined && options.expectedActiveGeneration !== active)
        || (options.expectedTransitionCount !== undefined && options.expectedTransitionCount !== transitions)
      ) {
        throw storageError("CAS_STALE", "The active generation or pointer transition count changed before retained recovery", {
          expectedActiveGeneration: options.expectedActiveGeneration,
          actualActiveGeneration: active,
          expectedTransitionCount: options.expectedTransitionCount,
          actualTransitionCount: transitions,
        });
      }
      if (target === undefined) throw storageError("STAGE_NOT_FOUND", "Cannot recover an unknown generation", { generation });
      const targetState = stateOf(target);

      if (targetState === "active") {
        if (active !== generation) throw storageError("INTEGRITY", "The active snapshot and active-generation pointer disagree", { generation, active });
        return Object.freeze({ generation, recovered: false, idempotent: true, replacedGeneration: null, transitionCount: transitions });
      }
      if (targetState !== "retained") throw storageError("STAGE_STATE", "Only the retained generation can be recovered", { generation, state: targetState });
      if (retained !== generation) throw storageError("INTEGRITY", "The retained-generation pointer does not identify the requested retained snapshot", { generation, retained });
      if (active === null) throw storageError("INTEGRITY", "A retained generation exists without an active generation");

      const current = snapshotRecord(await requestResult(snapshots.get(active)));
      if (current === undefined || stateOf(current) !== "active") {
        throw storageError("INTEGRITY", "The active-generation pointer has no active snapshot", { active });
      }
      snapshots.put({ ...current, state: "obsolete" });
      snapshots.put({ ...target, state: "active" });
      meta.put({ key: ACTIVE_GENERATION_KEY, value: generation } satisfies MetaRecord);
      meta.delete(RETAINED_GENERATION_KEY);
      meta.put({ key: POINTER_TRANSITIONS_KEY, value: transitions + 1 } satisfies MetaRecord);
      return Object.freeze({ generation, recovered: true, idempotent: false, replacedGeneration: active, transitionCount: transitions + 1 });
    });
  }

  /** Read explicit generation bytes and catalogs; this deliberately does not select a stage as active. */
  async readGeneration<GenerationCatalog = unknown, ChunkCatalog = unknown, ArtifactCatalog = unknown>(generation: string): Promise<StoredGeneration<GenerationCatalog, ChunkCatalog, ArtifactCatalog> | null> {
    ensureGeneration(generation);
    return this.transaction(["snapshots", "chunks", "documents"], "readonly", async (transaction) => {
      const snapshots = transaction.objectStore("snapshots");
      const chunks = transaction.objectStore("chunks");
      const documents = transaction.objectStore("documents");
      const snapshotRequest = snapshots.get(generation);
      const chunkRequest = chunks.getAll();
      const artifactRequest = documents.getAll();
      const [value, chunkValues, artifactValues] = await Promise.all([
        requestResult(snapshotRequest),
        requestResult(chunkRequest),
        requestResult(artifactRequest),
      ]);
      const snapshot = snapshotRecord(value);
      if (snapshot === undefined) return null;
      const selectedChunks = (chunkValues as ChunkRecord[])
        .filter((chunk) => chunk.generation === generation)
        .sort((left, right) => left.index - right.index)
        .map((chunk) => Object.freeze({
          index: chunk.index,
          bytes: copyBytes(chunk.bytes),
          ...(chunk.catalog === undefined ? {} : { catalog: cloneValue(chunk.catalog) as ChunkCatalog }),
        }));
      const selectedArtifacts = (artifactValues as ArtifactRecord[])
        .filter((artifact) => artifact.generation === generation)
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((artifact) => Object.freeze({
          path: artifact.path,
          bytes: copyBytes(artifact.bytes),
          ...(artifact.catalog === undefined ? {} : { catalog: cloneValue(artifact.catalog) as ArtifactCatalog }),
        }));
      return Object.freeze({
        snapshot: snapshotInfo<GenerationCatalog>(snapshot),
        chunks: Object.freeze(selectedChunks),
        artifacts: Object.freeze(selectedArtifacts),
      });
    });
  }

  /** Read only the currently active, complete generation. Pending stages are never selected here. */
  async readActiveGeneration<GenerationCatalog = unknown, ChunkCatalog = unknown, ArtifactCatalog = unknown>(): Promise<StoredGeneration<GenerationCatalog, ChunkCatalog, ArtifactCatalog> | null> {
    const active = await this.transaction(["snapshots", "meta", "chunks", "documents"], "readonly", async (transaction) => {
      const meta = transaction.objectStore("meta");
      const activeValue = await requestResult(meta.get(ACTIVE_GENERATION_KEY));
      const generation = valueFromMeta(activeValue as MetaRecord | undefined, ACTIVE_GENERATION_KEY);
      if (generation === null) return null;
      const snapshots = transaction.objectStore("snapshots");
      const chunks = transaction.objectStore("chunks");
      const documents = transaction.objectStore("documents");
      const snapshotRequest = snapshots.get(generation);
      const chunkRequest = chunks.getAll();
      const artifactRequest = documents.getAll();
      const [snapshotValue, chunkValues, artifactValues] = await Promise.all([
        requestResult(snapshotRequest),
        requestResult(chunkRequest),
        requestResult(artifactRequest),
      ]);
      const snapshot = snapshotRecord(snapshotValue);
      if (snapshot === undefined || stateOf(snapshot) !== "active") {
        throw storageError("INTEGRITY", "The active-generation pointer does not identify an active snapshot", { generation });
      }
      const selectedChunks = (chunkValues as ChunkRecord[])
        .filter((chunk) => chunk.generation === generation)
        .sort((left, right) => left.index - right.index)
        .map((chunk) => Object.freeze({
          index: chunk.index,
          bytes: copyBytes(chunk.bytes),
          ...(chunk.catalog === undefined ? {} : { catalog: cloneValue(chunk.catalog) as ChunkCatalog }),
        }));
      const selectedArtifacts = (artifactValues as ArtifactRecord[])
        .filter((artifact) => artifact.generation === generation)
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((artifact) => Object.freeze({
          path: artifact.path,
          bytes: copyBytes(artifact.bytes),
          ...(artifact.catalog === undefined ? {} : { catalog: cloneValue(artifact.catalog) as ArtifactCatalog }),
        }));
      return Object.freeze({
        snapshot: snapshotInfo<GenerationCatalog>(snapshot),
        chunks: Object.freeze(selectedChunks),
        artifacts: Object.freeze(selectedArtifacts),
      });
    });
    return active;
  }

  /**
   * Read only the retained pointer when it still identifies a retained
   * snapshot. This is intentionally separate from explicit generation reads.
   */
  async readRetainedGeneration<GenerationCatalog = unknown, ChunkCatalog = unknown, ArtifactCatalog = unknown>(): Promise<StoredGeneration<GenerationCatalog, ChunkCatalog, ArtifactCatalog> | null> {
    return this.transaction(["snapshots", "meta", "chunks", "documents"], "readonly", async (transaction) => {
      const meta = transaction.objectStore("meta");
      const retainedValue = await requestResult(meta.get(RETAINED_GENERATION_KEY));
      const generation = valueFromMeta(retainedValue as MetaRecord | undefined, RETAINED_GENERATION_KEY);
      if (generation === null) return null;
      const snapshots = transaction.objectStore("snapshots");
      const chunks = transaction.objectStore("chunks");
      const documents = transaction.objectStore("documents");
      const snapshotRequest = snapshots.get(generation);
      const chunkRequest = chunks.getAll();
      const artifactRequest = documents.getAll();
      const [snapshotValue, chunkValues, artifactValues] = await Promise.all([
        requestResult(snapshotRequest),
        requestResult(chunkRequest),
        requestResult(artifactRequest),
      ]);
      const snapshot = snapshotRecord(snapshotValue);
      if (snapshot === undefined || stateOf(snapshot) !== "retained") {
        throw storageError("INTEGRITY", "The retained-generation pointer does not identify a retained snapshot", { generation });
      }
      const selectedChunks = (chunkValues as ChunkRecord[])
        .filter((chunk) => chunk.generation === generation)
        .sort((left, right) => left.index - right.index)
        .map((chunk) => Object.freeze({
          index: chunk.index,
          bytes: copyBytes(chunk.bytes),
          ...(chunk.catalog === undefined ? {} : { catalog: cloneValue(chunk.catalog) as ChunkCatalog }),
        }));
      const selectedArtifacts = (artifactValues as ArtifactRecord[])
        .filter((artifact) => artifact.generation === generation)
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((artifact) => Object.freeze({
          path: artifact.path,
          bytes: copyBytes(artifact.bytes),
          ...(artifact.catalog === undefined ? {} : { catalog: cloneValue(artifact.catalog) as ArtifactCatalog }),
        }));
      return Object.freeze({
        snapshot: snapshotInfo<GenerationCatalog>(snapshot),
        chunks: Object.freeze(selectedChunks),
        artifacts: Object.freeze(selectedArtifacts),
      });
    });
  }

  /** Alias that makes the raw-byte nature of `readGeneration` explicit at call sites. */
  async readGenerationRawBytes<GenerationCatalog = unknown, ChunkCatalog = unknown, ArtifactCatalog = unknown>(generation: string): Promise<StoredGeneration<GenerationCatalog, ChunkCatalog, ArtifactCatalog> | null> {
    return this.readGeneration<GenerationCatalog, ChunkCatalog, ArtifactCatalog>(generation);
  }

  /** Inspect storage state without selecting or exposing a pending generation as active. */
  async inspect(): Promise<StorageInspection> {
    return this.transaction(["snapshots", "meta", "outbox", "drafts", "conflicts"], "readonly", async (transaction) => {
      const snapshots = transaction.objectStore("snapshots");
      const meta = transaction.objectStore("meta");
      const outbox = transaction.objectStore("outbox");
      const drafts = transaction.objectStore("drafts");
      const conflicts = transaction.objectStore("conflicts");
      const [snapshotValues, metaValues, outboxCount, draftCount, conflictCount] = await Promise.all([
        requestResult(snapshots.getAll()),
        requestResult(meta.getAll()),
        requestResult(outbox.count()),
        requestResult(drafts.count()),
        requestResult(conflicts.count()),
      ]);
      const metadata = new Map((metaValues as MetaRecord[]).map((entry) => [entry.key, entry]));
      const active = valueFromMeta(metadata.get(ACTIVE_GENERATION_KEY), ACTIVE_GENERATION_KEY);
      const retained = valueFromMeta(metadata.get(RETAINED_GENERATION_KEY), RETAINED_GENERATION_KEY);
      return Object.freeze({
        database: SONGS_STORAGE_NAME,
        version: this.database.version,
        activeGeneration: active,
        retainedGeneration: retained,
        transitionCount: transitionsFromMeta(metadata.get(POINTER_TRANSITIONS_KEY)),
        snapshots: Object.freeze((snapshotValues as SnapshotRecord[]).map(snapshotInfo).sort((left, right) => left.generation.localeCompare(right.generation))),
        pending: Object.freeze({ outbox: outboxCount, drafts: draftCount, conflicts: conflictCount }),
      });
    });
  }

  /**
   * Atomically remove a non-pointed generation and its raw content. This is
   * intended to reset corrupt or partial staging data before activation.
   */
  async discardUnreachableGeneration(generation: string): Promise<DiscardResult> {
    ensureGeneration(generation);
    return this.transaction(ALL_CONTENT_STORES, "readwrite", async (transaction) => {
      const snapshots = transaction.objectStore("snapshots");
      const chunks = transaction.objectStore("chunks");
      const documents = transaction.objectStore("documents");
      const meta = transaction.objectStore("meta");
      const snapshotRequest = snapshots.get(generation);
      const activeRequest = meta.get(ACTIVE_GENERATION_KEY);
      const retainedRequest = meta.get(RETAINED_GENERATION_KEY);
      const chunkKeysRequest = chunks.getAllKeys();
      const artifactKeysRequest = documents.getAllKeys();
      const [snapshotValue, activeValue, retainedValue, chunkKeys, artifactKeys] = await Promise.all([
        requestResult(snapshotRequest),
        requestResult(activeRequest),
        requestResult(retainedRequest),
        requestResult(chunkKeysRequest),
        requestResult(artifactKeysRequest),
      ]);
      const active = valueFromMeta(activeValue as MetaRecord | undefined, ACTIVE_GENERATION_KEY);
      const retained = valueFromMeta(retainedValue as MetaRecord | undefined, RETAINED_GENERATION_KEY);
      if (generation === active || generation === retained) {
        throw storageError("STAGE_STATE", "The active or retained generation cannot be discarded", { generation, active, retained });
      }
      const snapshot = snapshotRecord(snapshotValue);
      if (snapshot !== undefined && (stateOf(snapshot) === "active" || stateOf(snapshot) === "retained")) {
        throw storageError("STAGE_STATE", "An active or retained snapshot cannot be discarded", { generation, state: stateOf(snapshot) });
      }
      const chunkKeysForGeneration = (chunkKeys as IDBValidKey[]).filter((key) => isKeyForGeneration(key, generation));
      const artifactKeysForGeneration = (artifactKeys as IDBValidKey[]).filter((key) => isKeyForGeneration(key, generation));
      for (const key of chunkKeysForGeneration) chunks.delete(key);
      for (const key of artifactKeysForGeneration) documents.delete(key);
      if (snapshot !== undefined) snapshots.delete(generation);
      return Object.freeze({ generation, discarded: snapshot !== undefined || chunkKeysForGeneration.length > 0 || artifactKeysForGeneration.length > 0 });
    });
  }

  /**
   * Remove only generations that are no longer reachable from the active and
   * retained pointers. Cleanup is disabled until at least one activation has
   * succeeded, and it never opens a pending-work store for writing.
   */
  async cleanupUnreachable(options: CleanupOptions = {}): Promise<CleanupResult> {
    const maxGenerations = options.maxGenerations ?? 1;
    if (!Number.isSafeInteger(maxGenerations) || maxGenerations < 1) throw storageError("INVALID_INPUT", "maxGenerations must be a positive safe integer");
    return this.transaction(ALL_CONTENT_STORES, "readwrite", async (transaction) => {
      const snapshots = transaction.objectStore("snapshots");
      const meta = transaction.objectStore("meta");
      const [snapshotValues, metaValues] = await Promise.all([requestResult(snapshots.getAll()), requestResult(meta.getAll())]);
      const metadata = new Map((metaValues as MetaRecord[]).map((entry) => [entry.key, entry]));
      const active = valueFromMeta(metadata.get(ACTIVE_GENERATION_KEY), ACTIVE_GENERATION_KEY);
      const retained = valueFromMeta(metadata.get(RETAINED_GENERATION_KEY), RETAINED_GENERATION_KEY);
      const transitions = transitionsFromMeta(metadata.get(POINTER_TRANSITIONS_KEY));
      if (active === null || transitions === 0) return Object.freeze({ removed: Object.freeze([]), hasMore: false });

      const unreachable = (snapshotValues as SnapshotRecord[])
        .filter((snapshot) => {
          const state = stateOf(snapshot);
          if (snapshot.generation === active || snapshot.generation === retained) return false;
          // A stage based on the current active generation may still be retried.
          if ((state === "staging" || state === "verified") && snapshot.baseGeneration === active && baseTransitionFromSnapshot(snapshot) === transitions) return false;
          return true;
        })
        .map((snapshot) => snapshot.generation)
        .sort((left, right) => left.localeCompare(right));
      const selected = unreachable.slice(0, maxGenerations);
      if (selected.length === 0) return Object.freeze({ removed: Object.freeze([]), hasMore: false });

      const chunks = transaction.objectStore("chunks");
      const documents = transaction.objectStore("documents");
      const [chunkKeys, artifactKeys] = await Promise.all([requestResult(chunks.getAllKeys()), requestResult(documents.getAllKeys())]);
      for (const generation of selected) {
        for (const key of chunkKeys as IDBValidKey[]) if (isKeyForGeneration(key, generation)) chunks.delete(key);
        for (const key of artifactKeys as IDBValidKey[]) if (isKeyForGeneration(key, generation)) documents.delete(key);
        snapshots.delete(generation);
      }
      return Object.freeze({ removed: Object.freeze(selected), hasMore: unreachable.length > selected.length });
    });
  }
}

/** Open the one reserved TASK-012 namespace at schema version 2. */
export async function openSongsStorage(options: OpenSongsStorageOptions = {}): Promise<SongsStorage> {
  return SongsStorage.open(options);
}
