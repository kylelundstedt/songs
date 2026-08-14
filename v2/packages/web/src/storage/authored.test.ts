import "fake-indexeddb/auto";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTHORED_CONFLICT_SCHEMA_VERSION,
  AUTHORED_OUTBOX_SCHEMA_VERSION,
  AUTHORED_REVISION_SCHEMA_VERSION,
  AUTHORED_SYNC_SCHEMA_VERSION,
  AUTHORED_SYNC_STATE_ID,
  SONGS_STORAGE_NAME,
  SONGS_STORAGE_VERSION,
  type AuthoredConflictRecord,
  type AuthoredDraftRecord,
  type AuthoredMutation,
  type AuthoredResolutionOutboxRecord,
  type AuthoredServerRevisionRecord,
  type AuthoredSyncStateRecord,
  type SongsStorage,
  buildConflictResolutionOutbox,
  buildResolvedDraftProjection,
  buildAuthoredMutation,
  openSongsStorage,
  validateOutboxRecord,
} from "./index";
import { createSetList, executeSetListCommand, undoSetListRevision, type SetListRevision } from "../setlists";

const openConnections: SongsStorage[] = [];
const at1 = "2026-08-14T12:00:00.000Z";
const at2 = "2026-08-14T12:01:00.000Z";
const at3 = "2026-08-14T12:02:00.000Z";
const serverRevisionOne = "rev-111111111111111111111111";
const serverRevisionTwo = "rev-222222222222222222222222";

async function eraseDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(SONGS_STORAGE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("test left songs-v2 open"));
  });
}

async function rawDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SONGS_STORAGE_NAME, SONGS_STORAGE_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

async function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function openStorage(): Promise<SongsStorage> {
  const storage = await openSongsStorage();
  openConnections.push(storage);
  return storage;
}

function forget(storage: SongsStorage): void {
  storage.close();
  const index = openConnections.indexOf(storage);
  if (index >= 0) openConnections.splice(index, 1);
}

function initialRevision(): SetListRevision {
  const document = createSetList({
    id: "set-offline-gig",
    path: "sets/Offline-Gig.md",
    title: "Offline Gig",
    date: "2026-08-14",
    location: "The Room",
    band: "The Band",
    sections: [{
      id: "section-main",
      heading: "Set One",
      entries: [
        { id: "entry-shine-one", leadSheetId: "song-shine", targetPath: "songs/Shine.md", label: "Shine", note: "First occurrence" },
        { id: "entry-shine-two", leadSheetId: "song-shine", targetPath: "songs/Shine.md", label: "Shine", note: "Encore occurrence" },
      ],
    }],
  });
  return executeSetListCommand(null, { kind: "create-set-list", document }, { revisionId: "revision-local-one", operationId: "operation-local-one" });
}

async function mutation(revision: SetListRevision, createdAt: string, baseServerRevisionId = "", clientCursor = 0): Promise<AuthoredMutation> {
  return buildAuthoredMutation(revision, { deviceId: "device-browser-one", baseServerRevisionId, clientCursor, createdAt });
}

function nextRevision(base: SetListRevision, note = "Edited offline"): SetListRevision {
  return executeSetListCommand(base, {
    kind: "update-entry-note",
    entryId: base.document.sections[0]!.entries[0]!.id,
    note,
  }, { revisionId: "revision-local-two", operationId: "operation-local-two" });
}

function syncState(cursor: number, currentServerRevisionId = "", publishedRevisionId = ""): AuthoredSyncStateRecord {
  return {
    id: AUTHORED_SYNC_STATE_ID,
    schemaVersion: AUTHORED_SYNC_SCHEMA_VERSION,
    deviceId: "device-browser-one",
    cursor,
    acknowledgedCursor: Math.max(0, cursor - 1),
    documents: [{ documentId: "set-offline-gig", currentServerRevisionId, publishedRevisionId }],
    updatedAt: at3,
  };
}

function conflict(status: "open" | "resolved" = "open"): AuthoredConflictRecord {
  return {
    id: "conf-aaaaaaaaaaaaaaaaaaaaaaaa",
    schemaVersion: AUTHORED_CONFLICT_SCHEMA_VERSION,
    documentId: "set-offline-gig",
    currentRevisionId: serverRevisionOne,
    candidateRevisionId: serverRevisionTwo,
    resolutionRevisionId: "",
    status,
    updatedAt: at3,
  };
}

function serverRevisions(authored: AuthoredMutation): readonly AuthoredServerRevisionRecord[] {
  return [
    {
      id: serverRevisionOne,
      schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION,
      origin: "server",
      documentId: authored.draft.documentId,
      deviceId: authored.outbox.envelope.device_id,
      operationId: authored.outbox.envelope.operation_id,
      baseRevisionId: "",
      title: authored.draft.document.title,
      payload: authored.outbox.envelope.payload,
      contentHash: authored.outbox.envelope.payload_sha256,
      receivedAt: at2,
    },
    {
      id: serverRevisionTwo,
      schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION,
      origin: "server",
      documentId: authored.draft.documentId,
      deviceId: authored.outbox.envelope.device_id,
      operationId: "server-operation-two",
      baseRevisionId: serverRevisionOne,
      title: authored.draft.document.title,
      payload: authored.outbox.envelope.payload,
      contentHash: authored.outbox.envelope.payload_sha256,
      receivedAt: at3,
    },
  ];
}

async function seedConflict(storage: SongsStorage): Promise<{ readonly authored: AuthoredMutation; readonly revisions: readonly AuthoredServerRevisionRecord[] }> {
  const authored = await mutation(initialRevision(), at1);
  const revisions = serverRevisions(authored);
  await storage.commitAuthoredSync({
    expectedCursor: 0,
    sync: syncState(3, serverRevisionOne),
    revisions,
    conflicts: [conflict()],
  });
  return { authored, revisions };
}

async function resolutionRecord(
  storage: SongsStorage,
  mode: "keep-local" | "keep-server" | "manual" = "keep-local",
  operationId = "operation-resolve-one",
): Promise<AuthoredResolutionOutboxRecord> {
  const state = await storage.readAuthoredState();
  const current = state.revisions.find((record): record is AuthoredServerRevisionRecord => record.origin === "server" && record.id === serverRevisionOne)!;
  const candidate = state.revisions.find((record): record is AuthoredServerRevisionRecord => record.origin === "server" && record.id === serverRevisionTwo)!;
  const manualMutation = await mutation(nextRevision(initialRevision(), "Manually merged"), at3, serverRevisionOne, 3);
  return buildConflictResolutionOutbox(conflict(), {
    deviceId: "device-browser-one", operationId, mode, currentRevision: current, candidateRevision: candidate,
    ...(mode === "manual" ? { manual: { title: "Manual merge", payload: manualMutation.outbox.envelope.payload } } : {}),
    clientCursor: 3, createdAt: at3,
  });
}

async function resolutionServerRevision(record: AuthoredResolutionOutboxRecord, id = "rev-333333333333333333333333"): Promise<AuthoredServerRevisionRecord> {
  return {
    id, schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION, origin: "server", documentId: record.documentId,
    deviceId: record.envelope.device_id, operationId: record.envelope.operation_id,
    baseRevisionId: record.envelope.base_revision_id, title: record.envelope.title,
    payload: record.envelope.payload as AuthoredServerRevisionRecord["payload"], contentHash: record.envelope.payload_sha256, receivedAt: at3,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const connection of openConnections.splice(0)) connection.close();
  await eraseDatabase();
});

describe("IndexedDB v3 authored Set List repository", () => {
  it("atomically saves a draft, local revision, and immutable outbox across close/reopen", async () => {
    const storage = await openStorage();
    const revision = initialRevision();
    const authored = await mutation(revision, at1);
    await expect(storage.commitAuthoredMutation(authored)).resolves.toEqual({
      documentId: "set-offline-gig",
      localRevisionId: "revision-local-one",
      operationId: "operation-local-one",
      outboxId: "device-browser-one:operation-local-one",
      idempotent: false,
      coalescedOperationIds: [],
    });
    await expect(storage.commitAuthoredMutation(authored)).resolves.toMatchObject({ idempotent: true });
    forget(storage);

    const reopened = await openStorage();
    const draft = await reopened.readAuthoredDraft("set-offline-gig");
    expect(draft?.document.sections[0]?.entries.map((entry) => [entry.id, entry.leadSheetId, entry.note])).toEqual([
      ["entry-shine-one", "song-shine", "First occurrence"],
      ["entry-shine-two", "song-shine", "Encore occurrence"],
    ]);
    expect(await reopened.listAuthoredRevisions()).toHaveLength(1);
    const outbox = await reopened.listAuthoredOutbox();
    expect(outbox).toHaveLength(1);
    expect(JSON.parse(outbox[0]!.canonicalPayload)).toEqual(outbox[0]!.envelope.payload);
    expect(outbox[0]?.canonicalPayload).toContain("\\u003c!-- songs-v2-entry");
    expect(outbox[0]?.envelope.payload.source).toContain('id="entry-shine-one" lead-sheet-id="song-shine"');
  });

  it("coalesces only unsent full-document updates and retains every local revision", async () => {
    const storage = await openStorage();
    const first = initialRevision();
    await storage.commitAuthoredMutation(await mutation(first, at1));
    const second = nextRevision(first);
    await expect(storage.commitAuthoredMutation(await mutation(second, at2))).resolves.toMatchObject({
      coalescedOperationIds: ["operation-local-one"],
    });
    expect((await storage.listAuthoredRevisions()).map((record) => record.id)).toEqual(["revision-local-one", "revision-local-two"]);
    const outbox = await storage.listAuthoredOutbox();
    expect(outbox.map((record) => record.envelope.operation_id)).toEqual(["operation-local-two"]);
    expect(outbox[0]?.envelope.payload.source).toContain("— note: Edited offline");
    expect((await storage.inspect()).pending).toEqual({ outbox: 1, drafts: 1, conflicts: 0 });
  });

  it("uses local revision CAS so concurrent-tab writes cannot partially overwrite each other", async () => {
    const storage = await openStorage();
    const first = initialRevision();
    await storage.commitAuthoredMutation(await mutation(first, at1));
    const winner = nextRevision(first, "Winner");
    await storage.commitAuthoredMutation(await mutation(winner, at2));
    const stale = executeSetListCommand(first, { kind: "update-details", location: "Stale Room" }, { revisionId: "revision-local-stale", operationId: "operation-local-stale" });

    await expect(storage.commitAuthoredMutation(await mutation(stale, at3))).rejects.toMatchObject({ code: "LOCAL_REVISION_STALE" });
    expect((await storage.readAuthoredDraft("set-offline-gig"))?.document.location).toBe("The Room");
    expect((await storage.listAuthoredRevisions()).map((record) => record.id)).not.toContain("revision-local-stale");
    expect((await storage.listAuthoredOutbox()).map((record) => record.envelope.operation_id)).toEqual(["operation-local-two"]);
  });

  it("never rebinds an immutable device-operation identity to different revision bytes", async () => {
    const storage = await openStorage();
    const first = initialRevision();
    await storage.commitAuthoredMutation(await mutation(first, at1));
    const reused = executeSetListCommand(first, { kind: "update-details", location: "Different Room" }, { revisionId: "revision-local-reused", operationId: "operation-local-one" });
    await expect(storage.commitAuthoredMutation(await mutation(reused, at2))).rejects.toMatchObject({ code: "INTEGRITY" });
    expect((await storage.readAuthoredDraft("set-offline-gig"))?.localRevisionId).toBe("revision-local-one");
  });

  it("persists undo as another forward revision and outbox operation", async () => {
    const storage = await openStorage();
    const first = initialRevision();
    const second = nextRevision(first);
    const undone = undoSetListRevision(second, { revisionId: "revision-local-three", operationId: "operation-local-three" });
    await storage.commitAuthoredMutation(await mutation(first, at1));
    await storage.commitAuthoredMutation(await mutation(second, at2));
    await storage.commitAuthoredMutation(await mutation(undone, at3));

    expect((await storage.listAuthoredRevisions()).map((record) => record.id)).toEqual(["revision-local-one", "revision-local-three", "revision-local-two"]);
    expect((await storage.readAuthoredDraft("set-offline-gig"))?.document).toEqual(first.document);
    expect((await storage.listAuthoredOutbox()).map((record) => record.envelope.operation_id)).toEqual(["operation-local-three"]);
  });

  it("claims and fails retries durably without changing envelope bytes or payload hash", async () => {
    const storage = await openStorage();
    await storage.commitAuthoredMutation(await mutation(initialRevision(), at1));
    const before = (await storage.listAuthoredOutbox())[0]!;
    const claimed = await storage.claimNextAuthoredOutbox({ attemptedAt: at2 });
    expect(claimed).toMatchObject({ state: "sending", attempts: 1, lastAttemptAt: at2 });
    expect(claimed?.envelope).toEqual(before.envelope);
    expect(claimed?.canonicalPayload).toBe(before.canonicalPayload);

    const failed = await storage.failAuthoredOutbox(before.id, { failedAt: at3, message: "NETWORK_OFFLINE" });
    expect(failed).toMatchObject({ state: "failed", attempts: 1, lastError: "NETWORK_OFFLINE" });
    expect(failed.envelope).toEqual(before.envelope);
    const second = nextRevision(initialRevision());
    await storage.commitAuthoredMutation(await mutation(second, "2026-08-14T12:03:00.000Z"));
    expect((await storage.listAuthoredOutbox()).map((record) => [record.envelope.operation_id, record.state])).toEqual([
      ["operation-local-one", "failed"],
      ["operation-local-two", "pending"],
    ]);
    forget(storage);
    const reopened = await openStorage();
    await expect(reopened.claimNextAuthoredOutbox({ attemptedAt: "2026-08-14T12:04:00.000Z" })).resolves.toMatchObject({ state: "sending", attempts: 2, envelope: { operation_id: "operation-local-one" } });
    await expect(reopened.claimNextAuthoredOutbox({ attemptedAt: "2026-08-14T12:05:00.000Z" })).resolves.toBeNull();
    await expect(reopened.claimNextAuthoredOutbox({ attemptedAt: "2026-08-14T12:06:00.000Z", reclaimSendingBefore: "2026-08-14T12:04:00.000Z" })).resolves.toMatchObject({ state: "sending", attempts: 3, envelope: { operation_id: "operation-local-one" } });
  });

  it("uses explicit lease cutoffs so forward or backward wall-clock skew cannot silently steal sending work", async () => {
    const storage = await openStorage();
    await storage.commitAuthoredMutation(await mutation(initialRevision(), at1));
    const first = await storage.claimNextAuthoredOutbox({ attemptedAt: "2099-01-01T00:00:00.000Z" });
    expect(first).toMatchObject({ state: "sending", attempts: 1 });
    await expect(storage.claimNextAuthoredOutbox({ attemptedAt: "2020-01-01T00:00:00.000Z", reclaimSendingBefore: "2098-12-31T23:59:59.999Z" })).resolves.toBeNull();
    const reclaimed = await storage.claimNextAuthoredOutbox({ attemptedAt: "2100-01-01T00:00:00.000Z", reclaimSendingBefore: "2099-01-01T00:00:00.000Z" });
    expect(reclaimed).toMatchObject({ state: "sending", attempts: 2, lastAttemptAt: "2100-01-01T00:00:00.000Z" });
    expect(reclaimed?.envelope).toEqual(first?.envelope);
  });

  it("builds typed keep-local, keep-server, and manual resolution envelopes with immutable conflict sides", async () => {
    const storage = await openStorage();
    await seedConflict(storage);
    const local = await resolutionRecord(storage, "keep-local", "operation-resolve-local");
    const server = await resolutionRecord(storage, "keep-server", "operation-resolve-server");
    const manual = await resolutionRecord(storage, "manual", "operation-resolve-manual");

    for (const record of [local, server, manual]) {
      expect(record).toMatchObject({
        recordType: "resolution", conflictId: conflict().id, documentId: "set-offline-gig",
        currentRevisionId: serverRevisionOne, candidateRevisionId: serverRevisionTwo,
        state: "pending", attempts: 0,
        envelope: { operation_kind: "resolve-conflict", base_revision_id: serverRevisionOne, client_cursor: 3 },
      });
      expect(await validateOutboxRecord(record)).toEqual(record);
      expect(JSON.parse(record.canonicalPayload)).toEqual(record.envelope.payload);
    }
    const candidateRevision = (await storage.listAuthoredRevisions()).find((record) => record.id === serverRevisionTwo);
    const currentRevision = (await storage.listAuthoredRevisions()).find((record) => record.id === serverRevisionOne);
    expect(candidateRevision?.origin).toBe("server");
    expect(currentRevision?.origin).toBe("server");
    expect(local.envelope.payload).toEqual((candidateRevision as AuthoredServerRevisionRecord).payload);
    expect(server.envelope.payload).toEqual((currentRevision as AuthoredServerRevisionRecord).payload);
    expect(manual.envelope.title).toBe("Manual merge");
    expect(manual.envelope.payload.source).toContain("Manually merged");

    await expect(validateOutboxRecord({ ...local, currentRevisionId: serverRevisionTwo })).rejects.toThrow(/current\/candidate identities/);
    await expect(validateOutboxRecord({ ...local, envelope: { ...local.envelope, operation_kind: "set-list-put" } })).rejects.toThrow(/operation kind/);
  });

  it("projects keep-server or manual resolution bytes into a new local revision without queueing another operation", async () => {
    const local = await mutation(initialRevision(), at1);
    const targetMutation = await mutation(nextRevision(initialRevision(), "Server-selected note"), at2);
    const accepted: AuthoredServerRevisionRecord = {
      id: "rev-444444444444444444444444", schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION, origin: "server",
      documentId: local.draft.documentId, deviceId: "device-browser-two", operationId: "operation-resolution-winner",
      baseRevisionId: serverRevisionOne, title: targetMutation.outbox.envelope.title,
      payload: targetMutation.outbox.envelope.payload, contentHash: targetMutation.outbox.envelope.payload_sha256, receivedAt: at3,
    };
    const projected = await buildResolvedDraftProjection(local.draft, local.revision, accepted, at3);
    expect(projected.draft).toMatchObject({ baseServerRevisionId: accepted.id, source: accepted.payload.source });
    expect(projected.revision).toMatchObject({ parentRevisionId: local.revision.id, operationKind: "restore-set-list", source: accepted.payload.source });
    expect(projected.draft.localRevisionId).toBe(projected.revision?.id);
    expect(projected.revision?.operationId).toMatch(/^resolution-projection-/);
  });

  it("re-queues a reviewed resolution against a newer server head after a failed immutable CAS intent", async () => {
    const storage = await openStorage();
    const seeded = await seedConflict(storage);
    const newest: AuthoredServerRevisionRecord = {
      ...seeded.revisions[0]!, id: "rev-333333333333333333333333", operationId: "server-operation-three",
      baseRevisionId: serverRevisionOne, title: "Newest server head", receivedAt: "2026-08-14T12:03:00.000Z",
    };
    await storage.commitAuthoredSync({ expectedCursor: 3, sync: syncState(4, newest.id), revisions: [newest] });
    const renewed = await buildConflictResolutionOutbox(conflict(), {
      deviceId: "device-browser-one", operationId: "operation-resolve-renewed", mode: "keep-server",
      currentRevision: seeded.revisions[0]!, candidateRevision: seeded.revisions[1]!, baseRevision: newest,
      clientCursor: 4, createdAt: "2026-08-14T12:04:00.000Z",
    });
    expect(renewed.envelope.base_revision_id).toBe(newest.id);
    expect(renewed.envelope.title).toBe("Newest server head");
    await storage.queueConflictResolution(renewed);
    await storage.claimNextAuthoredOutbox({ recordType: "resolution", kind: "set-list", attemptedAt: "2026-08-14T12:05:00.000Z" });
    await storage.failAuthoredOutbox(renewed.id, { failedAt: "2026-08-14T12:06:00.000Z", message: "CONFLICT_CAS_FAILED: head advanced" });
    await storage.discardFailedConflictResolution(renewed.id);
    expect(await storage.listAuthoredResolutionOutbox()).toEqual([]);
    expect((await storage.readAuthoredState()).conflicts[0]).toMatchObject({ id: conflict().id, status: "open", currentRevisionId: serverRevisionOne, candidateRevisionId: serverRevisionTwo });
  });

  it("enqueues, claims, fails, exports, and restores resolution work without exposing it through TASK-019 apply lists", async () => {
    const storage = await openStorage();
    await seedConflict(storage);
    const record = await resolutionRecord(storage);
    await expect(storage.queueConflictResolution(record)).resolves.toMatchObject({ idempotent: false, conflictId: conflict().id });
    await expect(storage.queueConflictResolution(record)).resolves.toMatchObject({ idempotent: true });
    await expect(storage.queueConflictResolution(await resolutionRecord(storage, "keep-server", "operation-resolve-two"))).rejects.toMatchObject({ code: "CAS_STALE" });
    await expect(storage.commitAuthoredSync({
      expectedCursor: 3, sync: syncState(3, serverRevisionOne), removeConflictIds: [conflict().id],
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await storage.listAuthoredOutbox()).toEqual([]);
    expect(await storage.listLeadSheetOutbox()).toEqual([]);
    expect(await storage.listAuthoredResolutionOutbox()).toEqual([record]);

    const claimed = await storage.claimNextAuthoredOutbox({ recordType: "resolution", kind: "set-list", attemptedAt: at2 });
    expect(claimed).toMatchObject({ recordType: "resolution", state: "sending", attempts: 1 });
    expect(claimed?.envelope).toEqual(record.envelope);
    const failed = await storage.failAuthoredOutbox(record.id, { failedAt: at3, message: "NETWORK_OFFLINE" });
    expect(failed).toMatchObject({ recordType: "resolution", state: "failed", attempts: 1, lastError: "NETWORK_OFFLINE" });
    await expect(storage.discardFailedConflictResolution(record.id)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(failed.envelope).toEqual(record.envelope);
    await expect(storage.queueConflictResolution(record)).resolves.toMatchObject({ idempotent: true });
    expect(await storage.listAuthoredResolutionOutbox()).toEqual([failed]);

    const archive = await storage.exportAuthoredState(at3);
    expect(archive.records.outbox).toEqual([failed]);
    forget(storage);
    await eraseDatabase();
    const restored = await openStorage();
    await expect(restored.restoreAuthoredState(archive)).resolves.toMatchObject({ outbox: 1, conflicts: 1 });
    expect(await restored.listAuthoredResolutionOutbox()).toEqual([failed]);
    expect((await restored.readAuthoredState()).conflicts).toEqual([conflict()]);
  });

  it("requires the resolution revision and resolved conflict to become durable before deleting resolution outbox", async () => {
    const storage = await openStorage();
    await seedConflict(storage);
    const record = await resolutionRecord(storage);
    await storage.queueConflictResolution(record);
    await storage.claimNextAuthoredOutbox({ recordType: "resolution", kind: "set-list", attemptedAt: at2 });
    const revision = await resolutionServerRevision(record);
    const resolved: AuthoredConflictRecord = { ...conflict(), status: "resolved", resolutionRevisionId: revision.id };
    const resolvedState = syncState(3, revision.id);

    await expect(storage.commitAuthoredSync({
      expectedCursor: 3, sync: resolvedState, revisions: [revision], removeOutboxIds: [record.id],
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await storage.listAuthoredResolutionOutbox()).toHaveLength(1);
    expect((await storage.listAuthoredRevisions()).map((item) => item.id)).not.toContain(revision.id);
    expect((await storage.readAuthoredState()).conflicts[0]?.status).toBe("open");

    await storage.commitAuthoredSync({
      expectedCursor: 3, sync: resolvedState, revisions: [revision], conflicts: [resolved], removeOutboxIds: [record.id],
    });
    expect(await storage.listAuthoredResolutionOutbox()).toEqual([]);
    expect((await storage.listAuthoredRevisions()).map((item) => item.id)).toContain(revision.id);
    expect((await storage.readAuthoredState()).conflicts).toEqual([resolved]);
    expect((await storage.readAuthoredSyncState())?.documents[0]?.currentServerRevisionId).toBe(revision.id);
  });

  it("atomically persists sync cursor/conflicts and removes only acknowledged outbox work", async () => {
    const storage = await openStorage();
    const authored = await mutation(initialRevision(), at1);
    await storage.commitAuthoredMutation(authored);
    await storage.claimNextAuthoredOutbox({ attemptedAt: at2 });
    const updatedDraft: AuthoredDraftRecord = { ...authored.draft, baseServerRevisionId: serverRevisionOne, updatedAt: at3 };
    await expect(storage.commitAuthoredSync({
      expectedCursor: 0,
      sync: syncState(1),
      removeOutboxIds: [authored.outbox.id],
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await storage.listAuthoredOutbox()).toHaveLength(1);
    expect(await storage.readAuthoredSyncState()).toBeNull();
    await storage.commitAuthoredSync({
      expectedCursor: 0,
      sync: syncState(1, serverRevisionOne),
      revisions: serverRevisions(authored),
      drafts: [{ expectedLocalRevisionId: authored.draft.localRevisionId, draft: updatedDraft }],
      conflicts: [conflict()],
      removeOutboxIds: [authored.outbox.id],
    });
    expect(await storage.readAuthoredSyncState()).toEqual(syncState(1, serverRevisionOne));
    expect(await storage.listAuthoredOutbox()).toEqual([]);
    expect((await storage.readAuthoredState()).conflicts).toEqual([conflict()]);
    expect((await storage.readAuthoredDraft("set-offline-gig"))?.baseServerRevisionId).toBe(serverRevisionOne);
    const foreignDeviceMutation = await buildAuthoredMutation(nextRevision(initialRevision()), {
      deviceId: "device-browser-two", baseServerRevisionId: serverRevisionOne, clientCursor: 1, createdAt: "2026-08-14T12:03:00.000Z",
    });
    await expect(storage.commitAuthoredMutation(foreignDeviceMutation)).rejects.toMatchObject({ code: "CAS_STALE" });

    await expect(storage.commitAuthoredSync({
      expectedCursor: 0,
      sync: syncState(2, serverRevisionTwo),
      removeConflictIds: [conflict().id],
    })).rejects.toMatchObject({ code: "CAS_STALE" });
    expect((await storage.readAuthoredState()).conflicts).toHaveLength(1);
    expect((await storage.readAuthoredSyncState())?.cursor).toBe(1);
  });

  it("exports all authored stores with a hash and restores by safe merge or atomic replace", async () => {
    const source = await openStorage();
    const first = initialRevision();
    const authored = await mutation(first, at1);
    await source.commitAuthoredMutation(authored);
    await source.commitAuthoredSync({ expectedCursor: 0, sync: syncState(1), revisions: serverRevisions(authored), conflicts: [conflict()] });
    const archive = await source.exportAuthoredState(at3);
    expect(archive.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(archive.records.drafts.map((record) => record.id)).toEqual(["set-offline-gig"]);
    expect(archive.records.revisions.map((record) => record.id)).toEqual([serverRevisionOne, serverRevisionTwo, "revision-local-one"]);
    expect(archive.records.outbox.map((record) => record.id)).toEqual(["device-browser-one:operation-local-one"]);
    expect(archive.records.conflicts.map((record) => record.id)).toEqual([conflict().id]);
    expect(archive.records.sync?.cursor).toBe(1);
    forget(source);
    await eraseDatabase();

    const restored = await openStorage();
    await expect(restored.restoreAuthoredState(archive)).resolves.toEqual({ mode: "merge", drafts: 1, revisions: 3, outbox: 1, conflicts: 1, legacy: 0, sync: true });
    await expect(restored.restoreAuthoredState(archive)).resolves.toMatchObject({ mode: "merge" });
    expect(await restored.readAuthoredState()).toEqual(archive.records);

    const tampered: any = structuredClone(archive);
    tampered.records.drafts[0]!.document.sections[0]!.entries[0]!.note = "tampered";
    await expect(restored.restoreAuthoredState(tampered, { mode: "replace" })).rejects.toMatchObject({ code: "EXPORT_INVALID" });
    expect((await restored.readAuthoredDraft("set-offline-gig"))?.document.sections[0]?.entries[0]?.note).toBe("First occurrence");

    const second = nextRevision(first, "Newer local work");
    await restored.commitAuthoredMutation(await mutation(second, "2026-08-14T12:04:00.000Z"));
    await expect(restored.restoreAuthoredState(archive)).rejects.toMatchObject({ code: "RESTORE_CONFLICT" });
    expect((await restored.readAuthoredDraft("set-offline-gig"))?.localRevisionId).toBe("revision-local-two");
    await expect(restored.restoreAuthoredState(archive, { mode: "replace" })).resolves.toMatchObject({ mode: "replace" });
    expect((await restored.readAuthoredDraft("set-offline-gig"))?.localRevisionId).toBe("revision-local-one");
    expect((await restored.listAuthoredRevisions()).map((record) => record.id)).toEqual([serverRevisionOne, serverRevisionTwo, "revision-local-one"]);
  });

  it("hashes and restores opaque v1/v2 pending records without interpreting them", async () => {
    const source = await openStorage();
    const raw = await rawDatabase();
    const write = raw.transaction(["drafts", "outbox", "conflicts"], "readwrite");
    const draftPut = write.objectStore("drafts").put({ id: "legacy-draft", body: [0, 1, 254, 255] });
    const outboxPut = write.objectStore("outbox").put({ id: "legacy-outbox", when: at1, values: [1, 513] });
    const conflictPut = write.objectStore("conflicts").put({ id: "legacy-conflict", metadata: { reason: "preserve", tags: ["offline"] } });
    await Promise.all([request(draftPut), request(outboxPut), request(conflictPut)]);
    await transactionDone(write);
    raw.close();
    const archive = await source.exportAuthoredState(at3);
    expect(archive.legacy).toHaveLength(3);
    expect(archive.sha256).toMatch(/^[a-f0-9]{64}$/);
    forget(source);
    await eraseDatabase();

    const restored = await openStorage();
    await expect(restored.restoreAuthoredState(archive)).resolves.toMatchObject({ legacy: 3 });
    expect(await restored.readAuthoredState()).toEqual({ drafts: [], revisions: [], outbox: [], conflicts: [], sync: null });
    const restoredRaw = await rawDatabase();
    const read = restoredRaw.transaction(["drafts", "outbox", "conflicts"], "readonly");
    const draft = await request(read.objectStore("drafts").get("legacy-draft")) as { body: number[] };
    const outbox = await request(read.objectStore("outbox").get("legacy-outbox")) as { when: string; values: number[] };
    const conflictValue = await request(read.objectStore("conflicts").get("legacy-conflict")) as { metadata: { reason: string; tags: string[] } };
    expect(draft.body).toEqual([0, 1, 254, 255]);
    expect(outbox.when).toBe(at1);
    expect(outbox.values).toEqual([1, 513]);
    expect(conflictValue.metadata.reason).toBe("preserve");
    expect([...conflictValue.metadata.tags]).toEqual(["offline"]);
    await transactionDone(read);
    restoredRaw.close();
  });

  it("fails closed without rewriting a malformed current-schema pending record", async () => {
    const storage = await openStorage();
    const raw = await rawDatabase();
    const write = raw.transaction("outbox", "readwrite");
    const malformed = { id: "malformed-outbox", schemaVersion: AUTHORED_OUTBOX_SCHEMA_VERSION, state: "pending", body: "preserve exactly" };
    write.objectStore("outbox").put(malformed);
    await transactionDone(write);

    await expect(storage.claimNextAuthoredOutbox({ attemptedAt: at1 })).rejects.toMatchObject({ code: "INTEGRITY" });
    const read = raw.transaction("outbox", "readonly");
    await expect(request(read.objectStore("outbox").get("malformed-outbox"))).resolves.toEqual(malformed);
    await transactionDone(read);
    raw.close();
  });

  it("maps quota aborts and leaves no partial draft, revision, or outbox", async () => {
    const storage = await openStorage();
    const authored = await mutation(initialRevision(), at1);
    const originalPut = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "outbox") throw new DOMException("quota exhausted", "QuotaExceededError");
      return originalPut.apply(this, args);
    });
    try {
      await expect(storage.commitAuthoredMutation(authored)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    } finally {
      put.mockRestore();
    }
    expect(await storage.readAuthoredDraft("set-offline-gig")).toBeNull();
    expect(await storage.listAuthoredRevisions()).toEqual([]);
    expect(await storage.listAuthoredOutbox()).toEqual([]);
  });
});
