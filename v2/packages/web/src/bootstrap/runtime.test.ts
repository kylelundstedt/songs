import "fake-indexeddb/auto";

import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapRuntime, type BootstrapStorageRepository } from "./runtime";
import {
  ACCEPTED_BOOTSTRAP_TRUST,
  fetchReviewedManifest,
  loadVerifiedSnapshot,
  PREFERRED_BOOTSTRAP_TRUST,
  verifyReviewedArtifacts,
  type ReviewedBootstrapTrust,
  type VerifiedManifestPayload,
} from "./load";
import { BootstrapClientError } from "./types";
import { openSongsStorage, SONGS_STORAGE_NAME, SongsStorageError, type RecoveryOptions, type SongsStorage } from "../storage";

const dataRoot = resolve(process.cwd(), "../../../internal/v2bootstrap/data");
const origin = "http://v2.test";
const connections: SongsStorage[] = [];

function fixtureFetch(counter?: { value: number }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    if (counter !== undefined) counter.value += 1;
    const url = String(input);
    const path = url === "/api/v2/bootstrap/manifest"
      ? resolve(dataRoot, "manifest.json")
      : resolve(dataRoot, "chunks", basename(new URL(url, origin).pathname));
    return new Response(readFileSync(path), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
  }) as typeof fetch;
}

function canonicalFixtureValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalFixtureValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, canonicalFixtureValue(item)]),
    );
  }
  return value;
}

function canonicalFixtureBytes(value: unknown, compact = false): Uint8Array {
  return new TextEncoder().encode(compact ? JSON.stringify(canonicalFixtureValue(value)) : `${JSON.stringify(canonicalFixtureValue(value), null, 2)}\n`);
}

function fixtureSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function currentFixtureArtifacts(): { readonly manifest: any; readonly manifestRaw: Uint8Array; readonly chunks: readonly Uint8Array[] } {
  const manifestRaw = new Uint8Array(readFileSync(resolve(dataRoot, "manifest.json")));
  const manifest = JSON.parse(new TextDecoder().decode(manifestRaw)) as any;
  const chunks = manifest.chunks.map((descriptor: { readonly path: string }) => new Uint8Array(readFileSync(resolve(dataRoot, "chunks", descriptor.path))));
  return { manifest, manifestRaw, chunks };
}

function makeSecondReviewedFixture(): { readonly manifest: any; readonly manifestRaw: Uint8Array; readonly chunks: readonly Uint8Array[]; readonly trust: ReviewedBootstrapTrust } {
  const current = currentFixtureArtifacts();
  const manifest = structuredClone(current.manifest) as any;
  const chunks = current.chunks.map((raw) => JSON.parse(new TextDecoder().decode(raw)) as any);
  manifest.read_model_anchor.implementation_commit = "1".repeat(40);
  const logicalSnapshot = {
    source_baseline: manifest.source_baseline,
    evidence_baseline: manifest.evidence_baseline,
    read_model_anchor: manifest.read_model_anchor,
    contract_hashes: manifest.contract_hashes,
    evidence_hashes: manifest.evidence_hashes,
    apex: manifest.apex,
    physical_ipad: manifest.physical_ipad,
    slug_routes: manifest.slug_routes,
    document_hashes: chunks.flatMap((chunk: any) => chunk.documents.map((document: any) => document.verification.document_sha256)),
  };
  manifest.snapshot_sha256 = fixtureSha256(canonicalFixtureBytes(logicalSnapshot, true));
  manifest.generation = `phase1-${manifest.snapshot_sha256.slice(0, 24)}`;
  const rawChunks = chunks.map((chunk: any, index: number) => {
    chunk.generation = manifest.generation;
    chunk.verification.output_sha256 = null;
    chunk.verification.output_sha256 = fixtureSha256(canonicalFixtureBytes(chunk, true));
    const raw = canonicalFixtureBytes(chunk);
    const descriptor = manifest.chunks[index] as any;
    descriptor.url = `/api/v2/bootstrap/${manifest.generation}/chunks/${descriptor.path}`;
    descriptor.bytes = raw.byteLength;
    descriptor.sha256 = fixtureSha256(raw);
    return raw;
  });
  manifest.verification.output_sha256 = null;
  manifest.verification.output_sha256 = fixtureSha256(canonicalFixtureBytes(manifest, true));
  const manifestRaw = canonicalFixtureBytes(manifest);
  return {
    manifest,
    manifestRaw,
    chunks: rawChunks,
    trust: Object.freeze({ manifestSha256: fixtureSha256(manifestRaw), generation: manifest.generation }),
  };
}

async function stageRawArtifacts(
  storage: SongsStorage,
  manifestRaw: Uint8Array,
  rawChunks: readonly Uint8Array[],
  physicalGeneration: string,
  releaseEpoch: number,
  expectedActiveGeneration: string | null,
  trusts: readonly ReviewedBootstrapTrust[],
): Promise<{ readonly snapshot: Awaited<ReturnType<typeof verifyReviewedArtifacts>>; readonly manifestSha256: string }> {
  const manifestSha256 = fixtureSha256(manifestRaw);
  const snapshot = await verifyReviewedArtifacts(manifestRaw, rawChunks, origin, trusts);
  const manifestBytes = arrayBuffer(manifestRaw);
  const inspection = await storage.inspect();
  await storage.beginStage({
    generation: physicalGeneration,
    catalog: {
      manifestBytes,
      manifest: manifestBytes.slice(0),
      rawManifest: manifestBytes.slice(0),
      generation: snapshot.manifest.generation,
      logicalGeneration: snapshot.manifest.generation,
      physicalGeneration,
      manifestSha256,
      releaseEpoch,
      snapshotSha256: snapshot.manifest.snapshot_sha256,
      snapshotIdentity: snapshot.manifest.snapshot_sha256,
    },
    expectedChunks: snapshot.manifest.chunks.length,
    expectedArtifacts: snapshot.documents.length,
    stageIdentity: manifestSha256,
    expectedActiveGeneration,
    expectedTransitionCount: inspection.transitionCount,
  });
  let ordinal = 0;
  for (const descriptor of snapshot.manifest.chunks) {
    const documents = snapshot.documents.slice(ordinal, ordinal + descriptor.document_count);
    await storage.putVerifiedChunkAndArtifacts(
      physicalGeneration,
      { index: descriptor.index, bytes: arrayBuffer(rawChunks[descriptor.index] as Uint8Array), catalog: { index: descriptor.index, sha256: descriptor.sha256 } },
      documents.map((document) => ({
        path: document.path,
        bytes: arrayBuffer(Uint8Array.from(atob(document.source.content_base64), (character) => character.charCodeAt(0))),
        catalog: {
          id: document.id,
          ordinal: document.ordinal,
          kind: document.kind,
          slug: document.slug,
          documentSha256: document.verification.document_sha256,
          sourceSha256: document.source.sha256,
          chunkIndex: descriptor.index,
        },
      })),
    );
    ordinal += descriptor.document_count;
  }
  await storage.markVerified(physicalGeneration);
  await storage.activate(physicalGeneration, { expectedActiveGeneration, expectedTransitionCount: inspection.transitionCount });
  return { snapshot, manifestSha256 };
}

function arrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(value.byteLength);
  new Uint8Array(copy).set(value instanceof Uint8Array ? value : new Uint8Array(value));
  return copy;
}
async function stagePayload(
  storage: SongsStorage,
  payload: VerifiedManifestPayload,
  physicalGeneration: string,
  releaseEpoch: number,
  expectedActiveGeneration: string | null,
  activate = true,
): Promise<void> {
  const manifestBytes = arrayBuffer(payload.raw);
  const inspection = await storage.inspect();
  await storage.beginStage({
    generation: physicalGeneration,
    catalog: {
      manifestBytes,
      manifest: manifestBytes.slice(0),
      rawManifest: manifestBytes.slice(0),
      generation: payload.manifest.generation,
      logicalGeneration: payload.manifest.generation,
      physicalGeneration,
      manifestSha256: payload.manifestSha256,
      releaseEpoch,
      snapshotSha256: payload.manifest.snapshot_sha256,
      snapshotIdentity: payload.manifest.snapshot_sha256,
    },
    expectedChunks: payload.manifest.chunks.length,
    expectedArtifacts: payload.manifest.counts.documents,
    stageIdentity: payload.manifestSha256,
    expectedActiveGeneration,
    expectedTransitionCount: inspection.transitionCount,
  });
  await loadVerifiedSnapshot({
    fetchImpl: fixtureFetch(),
    origin,
    verifiedManifest: payload,
    staging: {
      begin: () => undefined,
      chunk: async (descriptor, raw, documents) => {
        await storage.putVerifiedChunkAndArtifacts(
          physicalGeneration,
          { index: descriptor.index, bytes: arrayBuffer(raw), catalog: { index: descriptor.index, sha256: descriptor.sha256 } },
          documents.map((document) => ({
            path: document.path,
            bytes: arrayBuffer(Uint8Array.from(atob(document.source.content_base64), (character) => character.charCodeAt(0))),
            catalog: {
              id: document.id,
              ordinal: document.ordinal,
              kind: document.kind,
              slug: document.slug,
              documentSha256: document.verification.document_sha256,
              sourceSha256: document.source.sha256,
              chunkIndex: descriptor.index,
            },
          })),
        );
      },
    },
  });
  await storage.markVerified(physicalGeneration);
  if (activate) await storage.activate(physicalGeneration, { expectedActiveGeneration, expectedTransitionCount: inspection.transitionCount });
}

async function corruptChunk(generation: string): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolvePromise, reject) => {
    const request = indexedDB.open(SONGS_STORAGE_NAME, 2);
    request.onsuccess = () => resolvePromise(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = database.transaction("chunks", "readwrite");
  const chunks = transaction.objectStore("chunks");
  const record = await new Promise<{ generation: string; index: number; bytes: ArrayBuffer; catalog?: unknown }>((resolvePromise, reject) => {
    const request = chunks.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) reject(new Error("target chunk missing"));
      else if (cursor.value.generation === generation) resolvePromise(cursor.value);
      else cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  const bytes = new Uint8Array(record.bytes.slice(0));
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  chunks.put({ ...record, bytes: bytes.buffer });
  await new Promise<void>((resolvePromise, reject) => {
    transaction.oncomplete = () => resolvePromise();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  database.close();
}

async function storageFactory(options?: { readonly indexedDB?: IDBFactory }): Promise<BootstrapStorageRepository> {
  const storage = await openSongsStorage(options === undefined ? {} : options);
  connections.push(storage);
  return storage;
}

async function deleteDatabase(): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const request = indexedDB.deleteDatabase(SONGS_STORAGE_NAME);
    request.onsuccess = () => resolvePromise();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("songs-v2 test connection remained open"));
  });
}

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close();
  await deleteDatabase();
});

describe("bootstrapRuntime TASK-012", () => {
  it("activates the real 373-document fixture and reopens offline with zero fetches", async () => {
    const calls = { value: 0 };
    const first = await bootstrapRuntime({
      online: true,
      origin,
      fetchImpl: fixtureFetch(calls),
      storageFactory,
    });
    expect(first.snapshot.documents).toHaveLength(373);
    expect(first.status).toMatchObject({ source: "indexeddb", database: "available", update: "activated", offlineReady: true });
    expect(first.status.chunks).toEqual({ completed: 12, total: 12 });
    expect(first.status.docs).toEqual({ completed: 373, total: 373 });
    expect(calls.value).toBe(13);

    for (const connection of connections.splice(0)) connection.close();
    const noNetwork = async () => { throw new Error("offline fetch must not run"); };
    const reopened = await bootstrapRuntime({ online: false, origin, fetchImpl: noNetwork as typeof fetch, storageFactory });
    expect(reopened.snapshot.documents).toHaveLength(373);
    expect(reopened.status).toMatchObject({ source: "indexeddb", update: "current", offlineReady: true });
    expect(calls.value).toBe(13);
  }, 20_000);

  it("activates a durably verified stage after an offline reopen without fetching", async () => {
    const storage = await openSongsStorage();
    connections.push(storage);
    const payload = await fetchReviewedManifest({ fetchImpl: fixtureFetch(), origin });
    const physical = `${payload.manifest.generation}@verified-before-close`;
    await stagePayload(storage, payload, physical, 1, null, false);
    expect(await storage.inspect()).toMatchObject({ activeGeneration: null, transitionCount: 0, snapshots: [expect.objectContaining({ generation: physical, state: "verified" })] });
    storage.close();

    let fetches = 0;
    const noFetch = (async () => { fetches += 1; throw new Error("verified-stage recovery must not fetch"); }) as typeof fetch;
    const result = await bootstrapRuntime({ online: false, origin, fetchImpl: noFetch, storageFactory });
    expect(result.status).toMatchObject({ source: "indexeddb", update: "activated", activeStorageGeneration: physical, transitions: 1, offlineReady: true });
    expect(fetches).toBe(0);
  }, 20_000);

  it("keeps an interrupted stage invisible and fails closed on persisted raw corruption", async () => {
    const first = await bootstrapRuntime({ online: true, origin, fetchImpl: fixtureFetch(), storageFactory });
    const storage = await openSongsStorage();
    connections.push(storage);
    const interruptedInspection = await storage.inspect();
    await storage.beginStage({
      generation: "interrupted",
      catalog: {},
      expectedChunks: 2,
      expectedArtifacts: 1,
      stageIdentity: "partial",
      expectedActiveGeneration: interruptedInspection.activeGeneration,
      expectedTransitionCount: interruptedInspection.transitionCount,
    });
    expect((await storage.readActiveGeneration())?.snapshot.generation).toBe(`${first.snapshot.manifest.generation}@a81aafbdef0d`);

    await corruptChunk(`${first.snapshot.manifest.generation}@a81aafbdef0d`);

    await expect(bootstrapRuntime({ online: false, origin, fetchImpl: fixtureFetch(), storageFactory })).rejects.toMatchObject({ code: "NETWORK_OFFLINE" });
    expect(await storage.inspect()).toMatchObject({ activeGeneration: `${first.snapshot.manifest.generation}@a81aafbdef0d`, transitionCount: 1 });

    storage.close();
    const repairCalls = { value: 0 };
    const repaired = await bootstrapRuntime({
      online: true,
      origin,
      fetchImpl: fixtureFetch(repairCalls),
      storageFactory,
      instanceIdFactory: () => "deterministic-repair",
    });
    expect(repaired.status).toMatchObject({ source: "indexeddb", update: "activated", activeGeneration: first.snapshot.manifest.generation, activeStorageGeneration: `${first.snapshot.manifest.generation}@a81aafbdef0d@repair-deterministic-repair` });
    expect(repairCalls.value).toBe(13);

    const noNetwork = async () => { throw new Error("repair should be offline-ready"); };
    const offline = await bootstrapRuntime({ online: false, origin, fetchImpl: noNetwork as typeof fetch, storageFactory });
    expect(offline.status).toMatchObject({ source: "indexeddb", update: "current", activeGeneration: first.snapshot.manifest.generation, offlineReady: true });
  }, 20_000);

  it("preserves an unsupported newer active pointer and never recovers an accepted retained snapshot", async () => {
    const first = await bootstrapRuntime({ online: true, origin, fetchImpl: fixtureFetch(), storageFactory });
    const storage = await openSongsStorage();
    connections.push(storage);
    const payload = await fetchReviewedManifest({ fetchImpl: fixtureFetch(), origin });
    const activePhysical = `${payload.manifest.generation}@newer-release`;
    await stagePayload(storage, payload, activePhysical, 2, `${payload.manifest.generation}@a81aafbdef0d`);
    const before = await storage.inspect();
    expect(before).toMatchObject({ activeGeneration: activePhysical, retainedGeneration: `${payload.manifest.generation}@a81aafbdef0d`, transitionCount: 2 });
    storage.close();

    await expect(bootstrapRuntime({ online: false, origin, storageFactory })).rejects.toMatchObject({ code: "MANIFEST_UNSUPPORTED" });
    const afterOffline = await openSongsStorage();
    connections.push(afterOffline);
    expect(await afterOffline.inspect()).toMatchObject({ activeGeneration: activePhysical, retainedGeneration: `${payload.manifest.generation}@a81aafbdef0d`, transitionCount: 2 });
    afterOffline.close();

    const calls = { value: 0 };
    const online = await bootstrapRuntime({ online: true, origin, fetchImpl: fixtureFetch(calls), storageFactory });
    expect(online.status).toMatchObject({ source: "network", update: "memory-only", activeGeneration: null, activeStorageGeneration: activePhysical, retainedGeneration: first.snapshot.manifest.generation, retainedStorageGeneration: `${payload.manifest.generation}@a81aafbdef0d`, transitions: 2 });
    expect(calls.value).toBe(13);
    const afterOnline = await openSongsStorage();
    connections.push(afterOnline);
    expect(await afterOnline.inspect()).toMatchObject({ activeGeneration: activePhysical, retainedGeneration: `${payload.manifest.generation}@a81aafbdef0d`, transitionCount: 2 });
  }, 20_000);

  it("uses physical and transition CAS guards for retained recovery", async () => {
    await bootstrapRuntime({ online: true, origin, fetchImpl: fixtureFetch(), storageFactory });
    const storage = await openSongsStorage();
    connections.push(storage);
    const payload = await fetchReviewedManifest({ fetchImpl: fixtureFetch(), origin });
    const secondPhysical = `${payload.manifest.generation}@second-accepted`;
    await stagePayload(storage, payload, secondPhysical, 1, `${payload.manifest.generation}@a81aafbdef0d`);
    await corruptChunk(secondPhysical);
    const inspectionBefore = await storage.inspect();
    const recoveryCalls: RecoveryOptions[] = [];
    const repository = storage as unknown as BootstrapStorageRepository & { recoverRetained: BootstrapStorageRepository["recoverRetained"] };
    repository.recoverRetained = async (_generation, options) => {
      recoveryCalls.push(options ?? {});
      throw new SongsStorageError("CAS_STALE", "test concurrent pointer change");
    };
    const result = await bootstrapRuntime({ online: false, origin, storageRepository: repository });
    expect(result.status).toMatchObject({ source: "indexeddb", update: "failed-retained", activeGeneration: null, retainedGeneration: payload.manifest.generation, activeStorageGeneration: secondPhysical, retainedStorageGeneration: `${payload.manifest.generation}@a81aafbdef0d`, transitions: inspectionBefore.transitionCount });
    expect(recoveryCalls).toEqual([{ expectedActiveGeneration: secondPhysical, expectedTransitionCount: inspectionBefore.transitionCount }]);
    const afterStorage = await openSongsStorage();
    connections.push(afterStorage);
    const after = await afterStorage.inspect();
    expect(after).toMatchObject({ activeGeneration: secondPhysical, retainedGeneration: `${payload.manifest.generation}@a81aafbdef0d`, transitionCount: inspectionBefore.transitionCount });
  }, 20_000);
  it("updates an accepted predecessor to the preferred generation and retains it", async () => {
    const predecessor = makeSecondReviewedFixture();
    const acceptedTrusts = Object.freeze([PREFERRED_BOOTSTRAP_TRUST, predecessor.trust]);
    const storage = await openSongsStorage();
    connections.push(storage);
    const physicalA = `${predecessor.trust.generation}@${predecessor.trust.manifestSha256.slice(0, 12)}`;
    await stageRawArtifacts(storage, predecessor.manifestRaw, predecessor.chunks, physicalA, 1, null, acceptedTrusts);
    storage.close();

    const calls = { value: 0 };
    const result = await bootstrapRuntime({ online: true, origin, acceptedTrusts, fetchImpl: fixtureFetch(calls), storageFactory });
    expect(calls.value).toBe(13);
    expect(result.snapshot.manifest.generation).toBe(PREFERRED_BOOTSTRAP_TRUST.generation);
    expect(result.status).toMatchObject({
      source: "indexeddb",
      update: "activated",
      activeGeneration: PREFERRED_BOOTSTRAP_TRUST.generation,
      retainedGeneration: predecessor.trust.generation,
      retainedStorageGeneration: physicalA,
      transitions: 2,
      offlineReady: true,
    });
  }, 30_000);

  it("keeps an accepted active predecessor visible when its preferred update fails", async () => {
    const predecessor = makeSecondReviewedFixture();
    const acceptedTrusts = Object.freeze([PREFERRED_BOOTSTRAP_TRUST, predecessor.trust]);
    const storage = await openSongsStorage();
    connections.push(storage);
    const physicalA = `${predecessor.trust.generation}@${predecessor.trust.manifestSha256.slice(0, 12)}`;
    await stageRawArtifacts(storage, predecessor.manifestRaw, predecessor.chunks, physicalA, 1, null, acceptedTrusts);
    storage.close();

    let calls = 0;
    const unavailable = (async () => { calls += 1; throw new TypeError("network unavailable"); }) as typeof fetch;
    const result = await bootstrapRuntime({ online: true, origin, acceptedTrusts, fetchImpl: unavailable, storageFactory });
    expect(calls).toBe(1);
    expect(result.snapshot.manifest.generation).toBe(predecessor.trust.generation);
    expect(result.status).toMatchObject({ source: "indexeddb", update: "failed-retained", activeGeneration: predecessor.trust.generation, activeStorageGeneration: physicalA, transitions: 1, offlineReady: true });
  }, 30_000);

  it("keeps an accepted active predecessor visible when a preferred chunk update fails", async () => {
    const predecessor = makeSecondReviewedFixture();
    const acceptedTrusts = Object.freeze([PREFERRED_BOOTSTRAP_TRUST, predecessor.trust]);
    const storage = await openSongsStorage();
    connections.push(storage);
    const physicalA = `${predecessor.trust.generation}@${predecessor.trust.manifestSha256.slice(0, 12)}`;
    await stageRawArtifacts(storage, predecessor.manifestRaw, predecessor.chunks, physicalA, 1, null, acceptedTrusts);
    storage.close();

    const base = fixtureFetch();
    let calls = 0;
    const interrupted = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (String(input).includes("chunk-004.json")) throw new TypeError("chunk transport interrupted");
      return base(input, init);
    }) as typeof fetch;
    const result = await bootstrapRuntime({ online: true, origin, acceptedTrusts, fetchImpl: interrupted, storageFactory });
    expect(calls).toBe(6);
    expect(result.snapshot.manifest.generation).toBe(predecessor.trust.generation);
    expect(result.status).toMatchObject({ source: "indexeddb", update: "failed-retained", activeGeneration: predecessor.trust.generation, activeStorageGeneration: physicalA, transitions: 1, offlineReady: true });
  }, 30_000);

  it("recovers an accepted predecessor across two physical manifests without fetching", async () => {
    const predecessor = makeSecondReviewedFixture();
    const current = currentFixtureArtifacts();
    const acceptedTrusts = Object.freeze([PREFERRED_BOOTSTRAP_TRUST, predecessor.trust]);
    const storage = await openSongsStorage();
    connections.push(storage);
    const physicalA = `${predecessor.trust.generation}@${predecessor.trust.manifestSha256.slice(0, 12)}`;
    const physicalB = `${current.manifest.generation}@${fixtureSha256(current.manifestRaw).slice(0, 12)}`;
    await stageRawArtifacts(storage, predecessor.manifestRaw, predecessor.chunks, physicalA, 1, null, acceptedTrusts);
    await stageRawArtifacts(storage, current.manifestRaw, current.chunks, physicalB, 1, physicalA, acceptedTrusts);
    await corruptChunk(physicalB);
    storage.close();

    const fetchCalls = { value: 0 };
    const noFetch = (async () => {
      fetchCalls.value += 1;
      throw new Error("retained recovery must not fetch");
    }) as typeof fetch;
    const result = await bootstrapRuntime({ online: false, origin, acceptedTrusts, fetchImpl: noFetch, storageFactory });
    expect(fetchCalls.value).toBe(0);
    expect(result.snapshot.manifest.generation).toBe(predecessor.trust.generation);
    expect(result.status).toMatchObject({
      source: "indexeddb",
      update: "recovered",
      activeGeneration: predecessor.trust.generation,
      activeStorageGeneration: physicalA,
      retainedGeneration: null,
      retainedStorageGeneration: null,
      manifestSha256: predecessor.trust.manifestSha256,
      transitions: 3,
      offlineReady: true,
    });

    const reopened = await openSongsStorage();
    connections.push(reopened);
    const inspection = await reopened.inspect();
    expect(inspection).toMatchObject({ activeGeneration: physicalA, retainedGeneration: null, transitionCount: 3 });
    expect(inspection.snapshots).toEqual([expect.objectContaining({ generation: physicalA, state: "active" })]);
    expect(await reopened.readGeneration(physicalB)).toBeNull();
  }, 30_000);
  it("never authorizes a verified snapshot with a later cross-tab pointer epoch", async () => {
    const storage = await openSongsStorage();
    connections.push(storage);
    const repository = storage as BootstrapStorageRepository & {
      activate: BootstrapStorageRepository["activate"];
      inspect: BootstrapStorageRepository["inspect"];
    };
    const activate = storage.activate.bind(storage);
    const inspect = storage.inspect.bind(storage);
    let driftAfterActivation = false;
    repository.activate = async (generation, options) => {
      const result = await activate(generation, options);
      driftAfterActivation = true;
      return result;
    };
    repository.inspect = async () => {
      const result = await inspect();
      return driftAfterActivation
        ? { ...result, activeGeneration: "phase1-cross-tab@later", transitionCount: result.transitionCount + 1 }
        : result;
    };

    const result = await bootstrapRuntime({ online: true, origin, fetchImpl: fixtureFetch(), storageRepository: repository });
    expect(result.status).toMatchObject({ source: "memory", update: "memory-only", offlineReady: false });
    expect(result.status.warning).toContain("active pointer changed after snapshot verification");
    expect(result.status.activeStorageGeneration).not.toBe("phase1-cross-tab@later");
  }, 20_000);

  it("fails closed when a local active snapshot changes after asynchronous verification", async () => {
    await bootstrapRuntime({ online: true, origin, fetchImpl: fixtureFetch(), storageFactory });
    for (const connection of connections.splice(0)) connection.close();
    const storage = await openSongsStorage();
    connections.push(storage);
    const repository = storage as BootstrapStorageRepository & { inspect: BootstrapStorageRepository["inspect"] };
    const inspect = storage.inspect.bind(storage);
    let inspections = 0;
    repository.inspect = async () => {
      const result = await inspect();
      inspections += 1;
      return inspections === 1
        ? result
        : { ...result, activeGeneration: "phase1-cross-tab@later", transitionCount: result.transitionCount + 1 };
    };

    await expect(bootstrapRuntime({ online: false, origin, storageRepository: repository })).rejects.toMatchObject({ code: "NETWORK_OFFLINE" });
  }, 30_000);

  it("falls back to a memory-only verified result when staging hits a quota-like failure", async () => {
    const failingFactory = async (options?: { readonly indexedDB?: IDBFactory }): Promise<BootstrapStorageRepository> => {
      const storage = await openSongsStorage(options === undefined ? {} : options);
      connections.push(storage);
      const repository = storage as unknown as BootstrapStorageRepository & { putVerifiedChunkAndArtifacts: BootstrapStorageRepository["putVerifiedChunkAndArtifacts"] };
      repository.putVerifiedChunkAndArtifacts = async () => { throw new DOMException("quota", "QuotaExceededError"); };
      return repository;
    };
    const result = await bootstrapRuntime({ online: true, origin, fetchImpl: fixtureFetch(), storageFactory: failingFactory });
    expect(result.snapshot.documents).toHaveLength(373);
    expect(result.status).toMatchObject({ source: "memory", database: "available", update: "memory-only", offlineReady: false });
    const inspectionStorage = await openSongsStorage();
    connections.push(inspectionStorage);
    const inspection = await inspectionStorage.inspect();
    expect(inspection?.activeGeneration).toBeNull();
  }, 20_000);

  it("reports persistence and origin-wide quota state defensively", async () => {
    const calls = { persisted: 0, persist: 0, estimate: 0 };
    const result = await bootstrapRuntime({
      online: true,
      origin,
      fetchImpl: fixtureFetch(),
      storage: null,
      storageManager: {
        persisted: () => { calls.persisted += 1; return false; },
        persist: () => { calls.persist += 1; return false; },
        estimate: async () => { calls.estimate += 1; return { usage: 10, quota: 100 }; },
      },
    });
    expect(result.status).toMatchObject({ source: "network", database: "unavailable", persistence: "denied", usage: 10, quota: 100, headroom: 90 });
    expect(calls).toEqual({ persisted: 1, persist: 1, estimate: 1 });
  }, 20_000);

  it("preserves typed IndexedDB open failures in the runtime warning", async () => {
    const result = await bootstrapRuntime({
      online: true,
      origin,
      fetchImpl: fixtureFetch(),
      storageFactory: async () => { throw new SongsStorageError("SCHEMA_NEWER", "database belongs to a newer shell"); },
    });
    expect(result.status).toMatchObject({ source: "network", database: "unavailable", update: "memory-only", offlineReady: false });
    expect(result.status.warning).toContain("SCHEMA_NEWER: database belongs to a newer shell");
  }, 20_000);

  it("returns a typed offline error when no verified local snapshot exists", async () => {
    await expect(bootstrapRuntime({ online: false, origin, storage: null })).rejects.toBeInstanceOf(BootstrapClientError);
    await expect(bootstrapRuntime({ online: false, origin, storage: null })).rejects.toMatchObject({ code: "NETWORK_OFFLINE" });
  });
});
