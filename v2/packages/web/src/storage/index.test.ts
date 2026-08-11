import "fake-indexeddb/auto";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SONGS_STORAGE_NAME,
  SONGS_STORAGE_STORES,
  SongsStorage,
  openSongsStorage,
} from "./index";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const openConnections: SongsStorage[] = [];

function bytes(value: string): ArrayBuffer {
  const source = encoder.encode(value);
  return source.slice().buffer;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function eraseDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(SONGS_STORAGE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("test left songs-v2 open"));
  });
}

async function rawOpen(version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SONGS_STORAGE_NAME, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const V2_STORE_KEY_PATHS: Readonly<Record<string, string | readonly string[]>> = {
  snapshots: "generation",
  documents: ["generation", "path"],
  chunks: ["generation", "index"],
  meta: "key",
  outbox: "id",
  drafts: "id",
  conflicts: "id",
};

async function seedV2Schema(options: { readonly omit?: readonly string[]; readonly keyPathOverrides?: Readonly<Record<string, string | readonly string[]>> } = {}): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(SONGS_STORAGE_NAME, 2);
    request.onupgradeneeded = () => {
      for (const [store, expectedKeyPath] of Object.entries(V2_STORE_KEY_PATHS)) {
        if (options.omit?.includes(store)) continue;
        const keyPath = options.keyPathOverrides?.[store] ?? expectedKeyPath;
        request.result.createObjectStore(store, { keyPath: typeof keyPath === "string" ? keyPath : [...keyPath] });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
}

async function openStorage(): Promise<SongsStorage> {
  const storage = await openSongsStorage();
  openConnections.push(storage);
  return storage;
}

async function seedV1(): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(SONGS_STORAGE_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("snapshots", { keyPath: "generation" });
      db.createObjectStore("documents", { keyPath: ["generation", "path"] });
      db.createObjectStore("chunks", { keyPath: ["generation", "index"] });
      db.createObjectStore("meta", { keyPath: "key" });
      db.createObjectStore("outbox", { keyPath: "id" });
      db.createObjectStore("drafts", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = database.transaction(["snapshots", "documents", "meta", "outbox", "drafts"], "readwrite");
  transaction.objectStore("snapshots").put({ generation: "legacy", state: "active", schema: 1 });
  transaction.objectStore("documents").put({ generation: "legacy", path: "legacy.md", content_base64: "bGVnYWN5" });
  transaction.objectStore("meta").put({ key: "active-generation", value: "legacy" });
  transaction.objectStore("meta").put({ key: "pointer-transitions", value: 0 });
  transaction.objectStore("outbox").put({ id: "pending-outbox", body: "do not lose" });
  transaction.objectStore("drafts").put({ id: "pending-draft", body: "do not lose" });
  await transactionDone(transaction);
  database.close();
}

async function putPending(store: "outbox" | "drafts" | "conflicts", record: object): Promise<void> {
  const database = await rawOpen(2);
  const transaction = database.transaction(store, "readwrite");
  transaction.objectStore(store).put(record);
  await transactionDone(transaction);
  database.close();
}

async function stageAndVerify(storage: SongsStorage, generation: string, stageIdentity = `reviewed:${generation}`): Promise<void> {
  await storage.beginStage({ generation, catalog: { manifest: generation }, expectedChunks: 1, expectedArtifacts: 1, stageIdentity });
  await storage.putVerifiedChunkAndArtifacts(
    generation,
    { index: 0, bytes: bytes(`chunk:${generation}`), catalog: { index: 0 } },
    [{ path: `${generation}.json`, bytes: bytes(`artifact:${generation}`), catalog: { path: `${generation}.json` } }],
  );
  await storage.markVerified(generation);
}

afterEach(async () => {
  for (const connection of openConnections.splice(0)) connection.close();
  await eraseDatabase();
});

describe("songs-v2 TASK-012 storage", () => {
  it("upgrades v1 additively and preserves pending records", async () => {
    await seedV1();
    const storage = await openStorage();
    await putPending("conflicts", { id: "pending-conflict", body: "do not lose" });

    const inspection = await storage.inspect();
    expect(inspection.version).toBe(2);
    expect(inspection.activeGeneration).toBe("legacy");
    expect(inspection.pending).toEqual({ outbox: 1, drafts: 1, conflicts: 1 });

    const raw = await rawOpen(2);
    expect([...raw.objectStoreNames].sort()).toEqual([...SONGS_STORAGE_STORES].sort());
    const transaction = raw.transaction(["outbox", "drafts", "conflicts"], "readonly");
    await expect(requestResult(transaction.objectStore("outbox").get("pending-outbox"))).resolves.toMatchObject({ body: "do not lose" });
    await expect(requestResult(transaction.objectStore("drafts").get("pending-draft"))).resolves.toMatchObject({ body: "do not lose" });
    await expect(requestResult(transaction.objectStore("conflicts").get("pending-conflict"))).resolves.toMatchObject({ body: "do not lose" });
    await transactionDone(transaction);
    raw.close();
  });

  it("keeps interrupted stages invisible and clones ArrayBuffers at the boundary", async () => {
    const storage = await openStorage();
    const chunk = bytes("immutable chunk");
    const artifact = bytes("immutable artifact");
    await storage.beginStage({ generation: "interrupted", catalog: { manifest: "interrupted" }, expectedChunks: 2, expectedArtifacts: 1 });
    await storage.putVerifiedChunkAndArtifacts("interrupted", { index: 0, bytes: chunk }, [{ path: "song.md", bytes: artifact }]);

    new Uint8Array(chunk)[0] = 0;
    new Uint8Array(artifact)[0] = 0;
    expect(await storage.readActiveGeneration()).toBeNull();
    expect((await storage.inspect()).activeGeneration).toBeNull();
    const staged = await storage.readGeneration<{ manifest: string }>("interrupted");
    expect(staged?.snapshot.state).toBe("staging");
    expect(decoder.decode(staged?.chunks[0]?.bytes)).toBe("immutable chunk");
    expect(decoder.decode(staged?.artifacts[0]?.bytes)).toBe("immutable artifact");

    // No activation has succeeded, so cleanup must leave a retryable stage alone.
    await expect(storage.cleanupUnreachable()).resolves.toEqual({ removed: [], hasMore: false });
    expect((await storage.readGeneration("interrupted"))?.chunks).toHaveLength(1);
  });

  it("requires an exact stage identity when a stage is resumed", async () => {
    const storage = await openStorage();
    const options = {
      generation: "resume",
      catalog: { manifest: "resume" },
      expectedChunks: 1,
      expectedArtifacts: 1,
      stageIdentity: "manifest-sha-1",
    } as const;
    expect(await storage.beginStage(options)).toMatchObject({ state: "staging", stageIdentity: "manifest-sha-1" });
    expect(await storage.beginStage(options)).toMatchObject({ state: "staging", stageIdentity: "manifest-sha-1" });
    await expect(storage.beginStage({ ...options, stageIdentity: "manifest-sha-2" })).rejects.toMatchObject({ code: "STAGE_STATE" });
    await expect(storage.beginStage({
      generation: options.generation,
      catalog: options.catalog,
      expectedChunks: options.expectedChunks,
      expectedArtifacts: options.expectedArtifacts,
    })).rejects.toMatchObject({ code: "STAGE_STATE" });
    expect((await storage.readGeneration("resume"))?.snapshot.stageIdentity).toBe("manifest-sha-1");
  });

  it("activates one pointer exactly once and retains the immediate prior snapshot", async () => {
    const storage = await openStorage();
    await stageAndVerify(storage, "generation-a");
    expect(await storage.activate("generation-a")).toMatchObject({ activated: true, previousGeneration: null, transitionCount: 1 });

    await stageAndVerify(storage, "generation-b");
    expect(await storage.activate("generation-b")).toMatchObject({ activated: true, previousGeneration: "generation-a", transitionCount: 2 });
    expect(await storage.activate("generation-b")).toMatchObject({ activated: false, idempotent: true, transitionCount: 2 });

    const inspection = await storage.inspect();
    expect(inspection.activeGeneration).toBe("generation-b");
    expect(inspection.retainedGeneration).toBe("generation-a");
    expect(inspection.transitionCount).toBe(2);
    expect(inspection.snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({ generation: "generation-a", state: "retained" }),
      expect.objectContaining({ generation: "generation-b", state: "active" }),
    ]));
    expect((await storage.readActiveGeneration())?.snapshot.generation).toBe("generation-b");
  });

  it("rejects ABA activation when the active generation returns with a newer transition count", async () => {
    const storage = await openStorage();
    await putPending("drafts", { id: "aba-draft", body: "preserve" });
    await stageAndVerify(storage, "generation-a");
    await storage.activate("generation-a", { expectedActiveGeneration: null, expectedTransitionCount: 0 });

    await stageAndVerify(storage, "generation-x");
    expect((await storage.readGeneration("generation-x"))?.snapshot).toMatchObject({
      baseGeneration: "generation-a",
      baseTransitionCount: 1,
      state: "verified",
    });
    await stageAndVerify(storage, "generation-b");
    await storage.activate("generation-b", { expectedActiveGeneration: "generation-a", expectedTransitionCount: 1 });
    await storage.recoverRetained("generation-a", { expectedActiveGeneration: "generation-b", expectedTransitionCount: 2 });

    await expect(storage.activate("generation-x", { expectedActiveGeneration: "generation-a", expectedTransitionCount: 3 })).rejects.toMatchObject({ code: "CAS_STALE" });
    await expect(storage.cleanupUnreachable({ maxGenerations: 10 })).resolves.toEqual({ removed: ["generation-b", "generation-x"], hasMore: false });
    const inspection = await storage.inspect();
    expect(inspection).toMatchObject({ activeGeneration: "generation-a", transitionCount: 3, pending: { outbox: 0, drafts: 1, conflicts: 0 } });
    expect(inspection.snapshots).toEqual([expect.objectContaining({ generation: "generation-a", state: "active" })]);
  });

  it("reads and atomically recovers only the retained generation after external verification", async () => {
    const storage = await openStorage();
    await putPending("outbox", { id: "outbox-recovery" });
    await stageAndVerify(storage, "generation-a");
    await storage.activate("generation-a");
    await stageAndVerify(storage, "generation-b");
    await storage.activate("generation-b");

    expect((await storage.readRetainedGeneration())?.snapshot).toMatchObject({ generation: "generation-a", state: "retained" });
    expect((await storage.readActiveGeneration())?.snapshot.generation).toBe("generation-b");
    const recoveryPrecondition = { expectedActiveGeneration: "generation-b", expectedTransitionCount: 2 } as const;
    expect(await storage.recoverRetained("generation-a", recoveryPrecondition)).toEqual({
      generation: "generation-a",
      recovered: true,
      idempotent: false,
      replacedGeneration: "generation-b",
      transitionCount: 3,
    });
    await expect(storage.recoverRetained("generation-a", recoveryPrecondition)).rejects.toMatchObject({ code: "CAS_STALE" });
    expect(await storage.recoverRetained("generation-a", { expectedActiveGeneration: "generation-a", expectedTransitionCount: 3 })).toEqual({
      generation: "generation-a",
      recovered: false,
      idempotent: true,
      replacedGeneration: null,
      transitionCount: 3,
    });

    const inspection = await storage.inspect();
    expect(inspection.activeGeneration).toBe("generation-a");
    expect(inspection.retainedGeneration).toBeNull();
    expect(inspection.transitionCount).toBe(3);
    expect(inspection.pending.outbox).toBe(1);
    expect(inspection.snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({ generation: "generation-a", state: "active" }),
      expect.objectContaining({ generation: "generation-b", state: "obsolete" }),
    ]));
    expect(await storage.readRetainedGeneration()).toBeNull();
  });

  it("rejects stale retained recovery before it can demote content activated meanwhile", async () => {
    const storage = await openStorage();
    await stageAndVerify(storage, "generation-a");
    await storage.activate("generation-a");
    await stageAndVerify(storage, "generation-b");
    await storage.activate("generation-b");
    const staleRecovery = { expectedActiveGeneration: "generation-b", expectedTransitionCount: 2 } as const;

    await stageAndVerify(storage, "generation-c");
    await storage.activate("generation-c");
    await expect(storage.recoverRetained("generation-a", staleRecovery)).rejects.toMatchObject({ code: "CAS_STALE" });

    const inspection = await storage.inspect();
    expect(inspection.activeGeneration).toBe("generation-c");
    expect(inspection.retainedGeneration).toBe("generation-b");
    expect(inspection.transitionCount).toBe(3);
    expect(inspection.snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({ generation: "generation-a", state: "obsolete" }),
      expect.objectContaining({ generation: "generation-b", state: "retained" }),
      expect.objectContaining({ generation: "generation-c", state: "active" }),
    ]));
  });

  it("fails closed when a fully verified stage was built against a stale active generation", async () => {
    const storage = await openStorage();
    await stageAndVerify(storage, "generation-a");
    await storage.activate("generation-a");

    await stageAndVerify(storage, "stale");
    await stageAndVerify(storage, "winner");
    await storage.activate("winner");

    await expect(storage.activate("stale")).rejects.toMatchObject({ code: "CAS_STALE" });
    const inspection = await storage.inspect();
    expect(inspection.activeGeneration).toBe("winner");
    expect(inspection.transitionCount).toBe(2);
    expect(inspection.snapshots).toEqual(expect.arrayContaining([expect.objectContaining({ generation: "stale", state: "verified" })]));
  });

  it("cleans only unreachable content after activation and never touches pending stores", async () => {
    const storage = await openStorage();
    await putPending("outbox", { id: "outbox-1" });
    await putPending("drafts", { id: "draft-1" });
    await putPending("conflicts", { id: "conflict-1" });

    await stageAndVerify(storage, "generation-a");
    await storage.activate("generation-a");
    await storage.beginStage({ generation: "orphan", catalog: { manifest: "orphan" }, expectedChunks: 1, expectedArtifacts: 1 });
    await storage.putVerifiedChunkAndArtifacts("orphan", { index: 0, bytes: bytes("orphan") }, [{ path: "orphan.md", bytes: bytes("orphan") }]);
    await stageAndVerify(storage, "generation-b");
    await storage.activate("generation-b");

    await expect(storage.cleanupUnreachable()).resolves.toEqual({ removed: ["orphan"], hasMore: false });
    const inspection = await storage.inspect();
    expect(inspection.pending).toEqual({ outbox: 1, drafts: 1, conflicts: 1 });
    expect(inspection.snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({ generation: "generation-a", state: "retained" }),
      expect.objectContaining({ generation: "generation-b", state: "active" }),
    ]));
    expect(inspection.snapshots.find((snapshot) => snapshot.generation === "orphan")).toBeUndefined();
  });

  it("atomically discards partial content but refuses active and retained generations", async () => {
    const storage = await openStorage();
    await putPending("drafts", { id: "draft-discard" });
    await storage.beginStage({ generation: "partial", catalog: { manifest: "partial" }, expectedChunks: 2, expectedArtifacts: 1, stageIdentity: "partial-v1" });
    await storage.putVerifiedChunkAndArtifacts("partial", { index: 0, bytes: bytes("partial") }, [{ path: "partial.md", bytes: bytes("partial") }]);
    await expect(storage.discardUnreachableGeneration("partial")).resolves.toEqual({ generation: "partial", discarded: true });
    expect(await storage.readGeneration("partial")).toBeNull();
    // A discard resets the generation name for a clean retry with its identity.
    expect(await storage.beginStage({ generation: "partial", catalog: { manifest: "partial" }, expectedChunks: 1, expectedArtifacts: 0, stageIdentity: "partial-v2" })).toMatchObject({ stageIdentity: "partial-v2" });

    await stageAndVerify(storage, "generation-a");
    await storage.activate("generation-a");
    await stageAndVerify(storage, "generation-b");
    await storage.activate("generation-b");
    await expect(storage.discardUnreachableGeneration("generation-a")).rejects.toMatchObject({ code: "STAGE_STATE" });
    await expect(storage.discardUnreachableGeneration("generation-b")).rejects.toMatchObject({ code: "STAGE_STATE" });
    expect((await storage.inspect()).pending.drafts).toBe(1);
  });

  it("maps quota-like transaction aborts to a typed storage error without a partial stage", async () => {
    const storage = await openStorage();
    const originalPut = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("quota exhausted", "QuotaExceededError");
    });
    try {
      await expect(storage.beginStage({ generation: "quota", catalog: {}, expectedChunks: 0, expectedArtifacts: 0 })).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
    } finally {
      put.mockRestore();
      expect(IDBObjectStore.prototype.put).toBe(originalPut);
    }
    expect((await storage.inspect()).snapshots).toEqual([]);
  });

  it("fails closed on same-version malformed schemas without repairing or deleting them", async () => {
    await seedV2Schema({ omit: ["conflicts"] });
    await expect(openSongsStorage()).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    const missingStore = await rawOpen(2);
    expect(missingStore.objectStoreNames.contains("conflicts")).toBe(false);
    missingStore.close();

    await eraseDatabase();
    await seedV2Schema({ keyPathOverrides: { documents: "wrongKey" } });
    await expect(openSongsStorage()).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    const wrongKeyPath = await rawOpen(2);
    const transaction = wrongKeyPath.transaction("documents", "readonly");
    const documentsKeyPath = transaction.objectStore("documents").keyPath;
    await transactionDone(transaction);
    expect(documentsKeyPath).toBe("wrongKey");
    wrongKeyPath.close();
  });

  it("fails typed on a newer schema, a blocked upgrade, and a versionchange close", async () => {
    const newer = await rawOpen(3);
    newer.close();
    await expect(openSongsStorage()).rejects.toMatchObject({ code: "SCHEMA_NEWER" });
    await eraseDatabase();

    await seedV1();
    const v1Connection = await rawOpen(1);
    await expect(openSongsStorage()).rejects.toMatchObject({ code: "OPEN_BLOCKED" });
    v1Connection.close();
    // The blocked request is permitted to finish its upgrade after the test
    // connection closes; delete it before opening the versionchange scenario.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await eraseDatabase();

    const storage = await openStorage();
    const upgrading = indexedDB.open(SONGS_STORAGE_NAME, 3);
    await new Promise<void>((resolve, reject) => {
      upgrading.onupgradeneeded = () => undefined;
      upgrading.onsuccess = () => {
        upgrading.result.close();
        resolve();
      };
      upgrading.onerror = () => reject(upgrading.error);
      upgrading.onblocked = () => reject(new Error("storage did not close on versionchange"));
    });
    await expect(storage.inspect()).rejects.toMatchObject({ code: "VERSION_CHANGE" });
  });
});
