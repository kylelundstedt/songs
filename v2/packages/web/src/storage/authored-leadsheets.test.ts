import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";
import {
  AUTHORED_REVISION_SCHEMA_VERSION,
  AUTHORED_SYNC_SCHEMA_VERSION,
  AUTHORED_SYNC_STATE_ID,
  SONGS_STORAGE_NAME,
  type AuthoredLeadSheetServerRevisionRecord,
  type AuthoredSyncStateRecord,
  type SongsStorage,
  buildAuthoredMutation,
  buildLeadSheetValidationReceipt,
  buildLeadSheetWorkspaceRecord,
  openSongsStorage,
} from "./index";
import {
  createCanonicalLeadSheet,
  executeLeadSheetCommand,
  type LeadSheetRevision,
} from "../leadsheets";

const at1 = "2026-08-14T13:00:00.000Z";
const at2 = "2026-08-14T13:01:00.000Z";
const at3 = "2026-08-14T13:02:00.000Z";
const at4 = "2026-08-14T13:03:00.000Z";
const serverRevision = "rev-333333333333333333333333";
const openConnections: SongsStorage[] = [];

async function eraseDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(SONGS_STORAGE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("test left songs-v2 open"));
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

function initialLeadSheetRevision(): LeadSheetRevision {
  const document = createCanonicalLeadSheet({
    id: "song-storage-one",
    path: "songs/Storage-One.md",
    title: "Storage One",
    artist: "The Band",
    performanceKey: "D",
    body: "### Verse 1\nLine one  \nLine two",
  });
  return executeLeadSheetCommand(null, { kind: "create-lead-sheet", document }, {
    revisionId: "revision-lead-one",
    operationId: "operation-lead-one",
  });
}

function syncState(): AuthoredSyncStateRecord {
  return {
    id: AUTHORED_SYNC_STATE_ID,
    schemaVersion: AUTHORED_SYNC_SCHEMA_VERSION,
    deviceId: "device-browser-one",
    cursor: 1,
    acknowledgedCursor: 0,
    documents: [{ documentId: "song-storage-one", currentServerRevisionId: serverRevision, publishedRevisionId: "" }],
    updatedAt: at3,
  };
}

afterEach(async () => {
  for (const connection of openConnections.splice(0)) connection.close();
  await eraseDatabase();
});

describe("generic authored lead-sheet storage", () => {
  it("builds, replays, claims, syncs, and reopens exact lead-sheet authored records", async () => {
    const storage = await openStorage();
    const first = initialLeadSheetRevision();
    const firstMutation = await buildAuthoredMutation(first, {
      deviceId: "device-browser-one", baseServerRevisionId: "", clientCursor: 0, createdAt: at1,
    });
    expect(firstMutation.draft).toMatchObject({ kind: "lead-sheet", documentId: "song-storage-one" });
    expect(firstMutation.outbox.envelope).toMatchObject({
      operation_kind: "create-lead-sheet",
      title: "Storage One",
      payload: { kind: "lead-sheet", path: "songs/Storage-One.md", source: first.document.source },
    });
    await storage.commitAuthoredMutation(firstMutation);

    const second = executeLeadSheetCommand(first, { kind: "update-metadata", patch: { performanceKey: "E" } }, {
      revisionId: "revision-lead-two",
      operationId: "operation-lead-two",
    });
    const secondMutation = await buildAuthoredMutation(second, {
      deviceId: "device-browser-one", baseServerRevisionId: "", clientCursor: 0, createdAt: at2,
    });
    await expect(storage.commitAuthoredMutation(secondMutation)).resolves.toMatchObject({
      coalescedOperationIds: ["operation-lead-one"],
    });
    expect((await storage.readLeadSheetDraft("song-storage-one"))?.document.source).toContain('performance_key: "E"');
    expect(await storage.readAuthoredDraft("song-storage-one")).toBeNull();
    expect((await storage.listLeadSheetDrafts()).map((record) => record.id)).toEqual(["song-storage-one"]);
    expect((await storage.listAllAuthoredDrafts()).map((record) => record.kind)).toEqual(["lead-sheet"]);
    expect((await storage.listAuthoredRevisions("song-storage-one")).map((record) => record.id)).toEqual([
      "revision-lead-one", "revision-lead-two",
    ]);
    expect(await storage.listAuthoredOutbox()).toEqual([]);
    expect((await storage.listLeadSheetOutbox()).map((record) => record.envelope.operation_id)).toEqual(["operation-lead-two"]);

    const claimed = await storage.claimNextAuthoredOutbox({ kind: "lead-sheet", attemptedAt: at3 });
    expect(claimed).toMatchObject({ state: "sending", envelope: { payload: { kind: "lead-sheet" } } });
    const accepted: AuthoredLeadSheetServerRevisionRecord = {
      id: serverRevision,
      schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION,
      origin: "server",
      documentId: second.document.id,
      deviceId: "device-browser-one",
      operationId: second.operationId,
      baseRevisionId: "",
      title: "Storage One",
      payload: secondMutation.outbox.envelope.payload,
      contentHash: secondMutation.outbox.envelope.payload_sha256,
      receivedAt: at3,
    };
    await storage.commitAuthoredSync({
      expectedCursor: 0,
      sync: syncState(),
      revisions: [accepted],
      drafts: [{
        expectedLocalRevisionId: second.id,
        draft: { ...secondMutation.draft, baseServerRevisionId: serverRevision, updatedAt: at3 },
      }],
      removeOutboxIds: [secondMutation.outbox.id],
    });
    expect(await storage.listLeadSheetOutbox()).toEqual([]);
    expect((await storage.readAuthoredState()).revisions.find((record) => record.id === serverRevision)).toEqual(accepted);
    forget(storage);

    const reopened = await openStorage();
    expect((await reopened.readLeadSheetDraft("song-storage-one"))?.source).toBe(second.document.source);
    expect((await reopened.readAuthoredSyncState())?.documents).toEqual(syncState().documents);
  });

  it("CAS-saves invalid intermediate workspace source and round-trips workspace/receipt opaquely through the TASK-019 export", async () => {
    const source = await openStorage();
    const invalidIntermediate = "---\ntitle: \"Unfinished\"\n";
    const first = await buildLeadSheetWorkspaceRecord({
      id: "song-workspace-one", path: "songs/Workspace-One.md", source: invalidIntermediate,
    }, { updatedAt: at1 });
    await expect(source.saveLeadSheetWorkspace(first, { expectedSourceSha256: null })).resolves.toMatchObject({ idempotent: false });
    await expect(source.saveLeadSheetWorkspace(first, { expectedSourceSha256: null })).resolves.toMatchObject({ idempotent: true });
    forget(source);

    const reopened = await openStorage();
    expect((await reopened.readLeadSheetWorkspace("song-workspace-one"))?.source).toBe(invalidIntermediate);
    const newer = await buildLeadSheetWorkspaceRecord({
      id: "song-workspace-one", path: "songs/Workspace-One.md", source: `${invalidIntermediate}artist: \"Draft\"\n`,
    }, { updatedAt: at2 });
    await expect(reopened.saveLeadSheetWorkspace(newer, { expectedSourceSha256: null })).rejects.toMatchObject({ code: "CAS_STALE" });
    await reopened.saveLeadSheetWorkspace(newer, { expectedSourceSha256: first.sourceSha256 });

    const receipt = await buildLeadSheetValidationReceipt({
      schema_version: "1",
      authority: "server-apex",
      document_id: "song-workspace-one",
      path: "songs/Workspace-One.md",
      title: "Unfinished",
      source_sha256: newer.sourceSha256,
      valid: false,
      issues: [{ code: "FRONT_MATTER_INVALID", message: "front matter is unfinished", line: 1 }],
    }, { source: newer.source, receivedAt: at3 });
    await reopened.saveLeadSheetValidationReceipt(receipt, { expectedWorkspaceSourceSha256: newer.sourceSha256 });
    await expect(reopened.saveLeadSheetValidationReceipt(receipt, { expectedWorkspaceSourceSha256: first.sourceSha256 })).rejects.toMatchObject({ code: "CAS_STALE" });

    const archive = await reopened.exportAuthoredState(at4);
    expect(archive.records).toEqual({ drafts: [], revisions: [], outbox: [], conflicts: [], sync: null });
    expect(archive.legacy.map((record) => record.store)).toEqual(["drafts", "drafts"]);
    forget(reopened);
    await eraseDatabase();

    const restored = await openStorage();
    await expect(restored.restoreAuthoredState(archive)).resolves.toMatchObject({ legacy: 2 });
    expect(await restored.readLeadSheetWorkspace("song-workspace-one")).toEqual(newer);
    expect(await restored.readLeadSheetValidationReceipt("song-workspace-one", newer.sourceSha256)).toEqual(receipt);
  });

  it("atomically projects a resolution into an unchanged lead-sheet workspace and preserves a newer workspace by CAS", async () => {
    const storage = await openStorage();
    const original = await buildLeadSheetWorkspaceRecord({ id: "song-workspace-resolution", path: "songs/Workspace-Resolution.md", source: "---\ntitle: \"Local\"\n---\n\n# Local\n" }, { updatedAt: at1 });
    const resolved = await buildLeadSheetWorkspaceRecord({ id: "song-workspace-resolution", path: original.path, source: "---\ntitle: \"Server\"\n---\n\n# Server\n" }, { updatedAt: at2 });
    await storage.saveLeadSheetWorkspace(original, { expectedSourceSha256: null });
    const emptySync: AuthoredSyncStateRecord = { id: AUTHORED_SYNC_STATE_ID, schemaVersion: AUTHORED_SYNC_SCHEMA_VERSION, deviceId: "device-browser-one", cursor: 0, acknowledgedCursor: 0, documents: [], updatedAt: at2 };
    await storage.commitAuthoredSync({ expectedCursor: 0, sync: emptySync, workspaces: [{ expectedSourceSha256: original.sourceSha256, workspace: resolved }] });
    expect(await storage.readLeadSheetWorkspace(original.documentId)).toEqual(resolved);
    const newer = await buildLeadSheetWorkspaceRecord({ id: original.documentId, path: original.path, source: `${resolved.source}\n### New local work\n` }, { updatedAt: at3 });
    await storage.saveLeadSheetWorkspace(newer, { expectedSourceSha256: resolved.sourceSha256 });
    await expect(storage.commitAuthoredSync({ expectedCursor: 0, sync: emptySync, workspaces: [{ expectedSourceSha256: resolved.sourceSha256, workspace: original }] })).rejects.toMatchObject({ code: "CAS_STALE" });
    expect(await storage.readLeadSheetWorkspace(original.documentId)).toEqual(newer);
  });

  it("builds a syncable envelope for an exact source near the one-MiB domain limit", async () => {
    const prefix = "---\ntitle: \"Large\"\nartist: \"Band\"\n---\n\n# Large\n\n### Verse 1\n";
    const source = prefix + "\\".repeat((1 << 20) - new TextEncoder().encode(prefix).byteLength);
    const document = createCanonicalLeadSheet({ id: "song-large-one", path: "songs/Large-One.md", title: "Large", artist: "Band" });
    const exact = { ...document, source };
    const revision = executeLeadSheetCommand(null, { kind: "create-lead-sheet", document: exact }, { revisionId: "revision-large-one", operationId: "operation-large-one" });
    const mutation = await buildAuthoredMutation(revision, { deviceId: "device-browser-one", baseServerRevisionId: "", clientCursor: 0, createdAt: at1 });
    expect(new TextEncoder().encode(mutation.outbox.envelope.payload.source).byteLength).toBe(1 << 20);
    expect(new TextEncoder().encode(JSON.stringify(mutation.outbox.envelope)).byteLength).toBeLessThan(8 << 20);
  });

  it("replace restore overwrites typed TASK-020 workspace and validation receipt records", async () => {
    const source = await openStorage();
    const archived = await buildLeadSheetWorkspaceRecord({ id: "song-replace-one", path: "songs/Replace-One.md", source: "---\ntitle: \"Archived\"\n" }, { updatedAt: at1 });
    await source.saveLeadSheetWorkspace(archived, { expectedSourceSha256: null });
    const archive = await source.exportAuthoredState(at2);
    forget(source);

    const current = await openStorage();
    const changed = await buildLeadSheetWorkspaceRecord({ id: "song-replace-one", path: "songs/Replace-One.md", source: "---\ntitle: \"Changed\"\n" }, { updatedAt: at3 });
    await current.saveLeadSheetWorkspace(changed, { expectedSourceSha256: archived.sourceSha256 });
    await expect(current.restoreAuthoredState(archive, { mode: "merge" })).rejects.toMatchObject({ code: "RESTORE_CONFLICT" });
    await expect(current.restoreAuthoredState(archive, { mode: "replace" })).resolves.toMatchObject({ legacy: 1 });
    expect(await current.readLeadSheetWorkspace("song-replace-one")).toEqual(archived);
  });
});
