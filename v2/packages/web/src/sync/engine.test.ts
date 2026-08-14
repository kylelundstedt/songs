import "fake-indexeddb/auto";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTHORED_CONFLICT_SCHEMA_VERSION,
  AUTHORED_REVISION_SCHEMA_VERSION,
  AUTHORED_SYNC_SCHEMA_VERSION,
  AUTHORED_SYNC_STATE_ID,
  SONGS_STORAGE_NAME,
  type AuthoredConflictRecord,
  type AuthoredMutation,
  type AuthoredResolutionOutboxRecord,
  type AuthoredServerRevisionRecord,
  type AuthoredSyncStateRecord,
  buildConflictResolutionOutbox,
  buildAuthoredMutation,
  openSongsStorage,
} from "../storage";
import { createSetList, executeSetListCommand } from "../setlists";
import { runForegroundSync } from "./engine";

const at1 = "2026-08-14T12:00:00.000Z";
const currentRevisionId = "rev-111111111111111111111111";
const candidateRevisionId = "rev-222222222222222222222222";
const resolutionRevisionId = "rev-333333333333333333333333";
const refreshedRevisionId = "rev-444444444444444444444444";
const conflictId = "conf-aaaaaaaaaaaaaaaaaaaaaaaa";
const deviceId = "device-browser-one";

async function eraseDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(SONGS_STORAGE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("test left songs-v2 open"));
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function syncState(cursor: number, current = currentRevisionId): AuthoredSyncStateRecord {
  return {
    id: AUTHORED_SYNC_STATE_ID, schemaVersion: AUTHORED_SYNC_SCHEMA_VERSION, deviceId,
    cursor, acknowledgedCursor: Math.max(0, cursor - 1),
    documents: [{ documentId: "set-conflict-gig", currentServerRevisionId: current, publishedRevisionId: "" }],
    updatedAt: at1,
  };
}

function conflict(status: "open" | "resolved" = "open", resolutionRevision = ""): AuthoredConflictRecord {
  return {
    id: conflictId, schemaVersion: AUTHORED_CONFLICT_SCHEMA_VERSION, documentId: "set-conflict-gig",
    currentRevisionId, candidateRevisionId, resolutionRevisionId: resolutionRevision, status, updatedAt: at1,
  };
}

async function authoredMutation(baseRevisionId = "", cursor = 0): Promise<AuthoredMutation> {
  const document = createSetList({
    id: "set-conflict-gig", path: "sets/Conflict-Gig.md", title: "Conflict Gig", sections: [{
      id: "section-main", heading: "Set One", entries: [{
        id: "entry-one", leadSheetId: "song-one", targetPath: "songs/One.md", label: "One",
      }],
    }],
  });
  const revision = executeSetListCommand(null, { kind: "create-set-list", document }, { revisionId: "revision-local-one", operationId: "operation-local-one" });
  return buildAuthoredMutation(revision, { deviceId, baseServerRevisionId: baseRevisionId, clientCursor: cursor, createdAt: at1 });
}

function serverRevision(authored: AuthoredMutation, id: string, operationId: string, baseRevisionId: string): AuthoredServerRevisionRecord {
  return {
    id, schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION, origin: "server", documentId: authored.draft.documentId,
    deviceId, operationId, baseRevisionId, title: authored.outbox.envelope.title,
    payload: authored.outbox.envelope.payload, contentHash: authored.outbox.envelope.payload_sha256, receivedAt: "1970-01-01T00:00:00.000Z",
  };
}

function wireRevision(revision: AuthoredServerRevisionRecord) {
  return {
    revision_id: revision.id, document_id: revision.documentId, device_id: revision.deviceId,
    operation_id: revision.operationId, base_revision_id: revision.baseRevisionId, title: revision.title,
    payload: revision.payload, content_hash: revision.contentHash,
  };
}

async function seedConflictResolution(): Promise<AuthoredResolutionOutboxRecord> {
  const authored = await authoredMutation();
  const current = serverRevision(authored, currentRevisionId, "server-current", "");
  const candidate = serverRevision(authored, candidateRevisionId, "server-candidate", currentRevisionId);
  const storage = await openSongsStorage();
  await storage.commitAuthoredSync({ expectedCursor: 0, sync: syncState(3), revisions: [current, candidate], conflicts: [conflict()] });
  const record = await buildConflictResolutionOutbox(conflict(), {
    deviceId, operationId: "operation-resolve-one", mode: "keep-local", currentRevision: current, candidateRevision: candidate,
    clientCursor: 3, createdAt: at1,
  });
  await storage.queueConflictResolution(record);
  storage.close();
  return record;
}

function registration() {
  return { protocol_version: "1", owner_id: "owner-one", device_id: deviceId, registration_id: deviceId, name: "V2 browser", status: "active", token: "token-one" };
}

function requestURL(input: RequestInfo | URL): string { return typeof input === "string" ? input : input.toString(); }

afterEach(async () => {
  vi.unstubAllGlobals();
  localStorage.clear();
  await eraseDatabase();
});

describe("durable foreground conflict resolution", () => {
  it("resolves through the conflict endpoint and atomically stores revision/conflict before deleting outbox", async () => {
    const record = await seedConflictResolution();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestURL(input);
      if (url.endsWith("/devices/register")) return json(registration());
      if (url.endsWith(`/conflicts/${conflictId}/resolve`)) {
        expect(init?.body).toBe(JSON.stringify(record.envelope));
        return json({ operation_id: record.envelope.operation_id, status: "resolved", revision_id: resolutionRevisionId, conflict_id: conflictId, sequence: 4 });
      }
      if (url.endsWith("/pull?after=3")) return json({ events: [], revisions: [], conflicts: [], cursor: 4, compaction_floor: 0 });
      if (url.endsWith("/ack")) return json({ protocol_version: "1", cursor: 4, status: "acknowledged" });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(runForegroundSync()).resolves.toEqual({ applied: 1, conflicts: 0, cursor: 4, pending: 0 });
    const storage = await openSongsStorage();
    const state = await storage.readAuthoredState();
    expect(state.outbox).toEqual([]);
    expect(state.conflicts).toEqual([expect.objectContaining({ id: conflictId, status: "resolved", resolutionRevisionId })]);
    expect(state.revisions).toContainEqual(expect.objectContaining({
      id: resolutionRevisionId, operationId: record.envelope.operation_id, baseRevisionId: currentRevisionId,
      contentHash: record.envelope.payload_sha256,
    }));
    expect(state.sync?.documents[0]?.currentServerRevisionId).toBe(resolutionRevisionId);
    expect(state.sync?.acknowledgedCursor).toBe(4);
    storage.close();
  });

  it("keeps a failed CAS resolution and both immutable conflict sides through a required resnapshot", async () => {
    const record = await seedConflictResolution();
    const seeded = await openSongsStorage();
    const revisions = (await seeded.listAuthoredRevisions()).filter((item): item is AuthoredServerRevisionRecord => item.origin === "server");
    const latest: AuthoredServerRevisionRecord = { ...revisions[0]!, id: refreshedRevisionId, operationId: "server-refreshed", baseRevisionId: currentRevisionId, title: "Latest head" };
    seeded.close();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestURL(input);
      if (url.endsWith("/devices/register")) return json(registration());
      if (url.endsWith(`/conflicts/${conflictId}/resolve`)) return json({ error: { code: "CONFLICT_CAS_FAILED", message: "head advanced" } }, 409);
      if (url.endsWith("/pull?after=3")) return json({ error: { code: "RESNAPSHOT_REQUIRED", message: "cursor compacted" } }, 409);
      if (url.endsWith("/snapshot")) return json({
        protocol_version: "1", cursor: 5, compaction_floor: 4, revisions: [...revisions, latest].map(wireRevision),
        conflicts: [{ conflict_id: conflictId, document_id: "set-conflict-gig", current_revision_id: currentRevisionId, candidate_revision_id: candidateRevisionId, status: "open" }],
        documents: [{ document_id: "set-conflict-gig", current_revision_id: refreshedRevisionId, title: "Latest head" }], publications: [],
      });
      if (url.endsWith("/ack")) return json({ protocol_version: "1", cursor: 5, status: "acknowledged" });
      throw new Error(`unexpected fetch ${url}`);
    }));

    await expect(runForegroundSync()).resolves.toMatchObject({ applied: 0, cursor: 5, pending: 1 });
    const storage = await openSongsStorage();
    const failed = (await storage.listAuthoredResolutionOutbox())[0]!;
    expect(failed).toMatchObject({
      state: "failed", attempts: 1, lastError: "CONFLICT_CAS_FAILED: head advanced", conflictId,
      currentRevisionId, candidateRevisionId,
    });
    expect(failed.envelope).toEqual(record.envelope);
    const durableState = await storage.readAuthoredState();
    expect(durableState.conflicts).toEqual([expect.objectContaining({
      id: conflictId, status: "open", currentRevisionId, candidateRevisionId, resolutionRevisionId: "",
    })]);
    expect(durableState.sync?.documents[0]?.currentServerRevisionId).toBe(refreshedRevisionId);
    expect((await storage.exportAuthoredState(at1)).records.outbox).toEqual([failed]);
    await storage.discardFailedConflictResolution(failed.id);
    const renewed = await buildConflictResolutionOutbox(durableState.conflicts[0]!, {
      deviceId, operationId: "operation-resolve-renewed", mode: "keep-server",
      currentRevision: revisions.find((item) => item.id === currentRevisionId)!,
      candidateRevision: revisions.find((item) => item.id === candidateRevisionId)!, baseRevision: latest,
      clientCursor: 5, createdAt: at1,
    });
    await storage.queueConflictResolution(renewed);
    expect((await storage.listAuthoredResolutionOutbox())[0]).toMatchObject({ state: "pending", envelope: { base_revision_id: refreshedRevisionId, title: "Latest head" } });
    storage.close();
  });

  it("reconciles a lost local resolution response from pull and removes only the exact accepted operation", async () => {
    const record = await seedConflictResolution();
    const storage = await openSongsStorage();
    await storage.claimNextAuthoredOutbox({ outboxId: record.id, recordType: "resolution", kind: "set-list", attemptedAt: at1 });
    await storage.failAuthoredOutbox(record.id, { failedAt: at1, message: "network response lost" });
    storage.close();
    const accepted: AuthoredServerRevisionRecord = {
      id: resolutionRevisionId, schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION, origin: "server", documentId: record.documentId,
      deviceId, operationId: record.envelope.operation_id, baseRevisionId: record.envelope.base_revision_id,
      title: record.envelope.title, payload: record.envelope.payload as AuthoredServerRevisionRecord["payload"],
      contentHash: record.envelope.payload_sha256, receivedAt: "1970-01-01T00:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestURL(input);
      if (url.endsWith("/devices/register")) return json(registration());
      if (url.endsWith("/pull?after=3")) return json({
        events: [{ sequence: 4, kind: "resolved", operation_id: record.envelope.operation_id, document_id: record.documentId, revision_id: accepted.id, conflict_id: conflictId }],
        revisions: [wireRevision(accepted)], conflicts: [{ conflict_id: conflictId, document_id: record.documentId, current_revision_id: currentRevisionId, candidate_revision_id: candidateRevisionId, resolution_revision_id: accepted.id, status: "resolved" }],
        cursor: 4, compaction_floor: 0,
      });
      if (url.endsWith("/ack")) return json({ protocol_version: "1", cursor: 4, status: "acknowledged" });
      throw new Error(`unexpected fetch ${url}`);
    }));
    await expect(runForegroundSync({ setListWrites: false, leadSheetWrites: false })).resolves.toEqual({ applied: 0, conflicts: 0, cursor: 4, pending: 0 });
    const reopened = await openSongsStorage();
    expect(await reopened.listAuthoredResolutionOutbox()).toEqual([]);
    expect((await reopened.readAuthoredState()).conflicts[0]).toMatchObject({ status: "resolved", resolutionRevisionId });
    reopened.close();
  });

  it("marks a losing local resolution superseded when another device resolves first", async () => {
    const record = await seedConflictResolution();
    const other: AuthoredServerRevisionRecord = {
      id: resolutionRevisionId, schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION, origin: "server", documentId: record.documentId,
      deviceId: "device-browser-two", operationId: "operation-other-resolution", baseRevisionId: record.envelope.base_revision_id,
      title: "Other resolution", payload: record.envelope.payload as AuthoredServerRevisionRecord["payload"],
      contentHash: record.envelope.payload_sha256, receivedAt: "1970-01-01T00:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestURL(input);
      if (url.endsWith("/devices/register")) return json(registration());
      if (url.endsWith(`/conflicts/${conflictId}/resolve`)) return json({ error: { code: "CONFLICT_CAS_FAILED", message: "resolved elsewhere" } }, 409);
      if (url.endsWith("/pull?after=3")) return json({
        events: [{ sequence: 4, kind: "resolved", operation_id: other.operationId, document_id: record.documentId, revision_id: other.id, conflict_id: conflictId }],
        revisions: [wireRevision(other)], conflicts: [{ conflict_id: conflictId, document_id: record.documentId, current_revision_id: currentRevisionId, candidate_revision_id: candidateRevisionId, resolution_revision_id: other.id, status: "resolved" }],
        cursor: 4, compaction_floor: 0,
      });
      if (url.endsWith("/ack")) return json({ protocol_version: "1", cursor: 4, status: "acknowledged" });
      throw new Error(`unexpected fetch ${url}`);
    }));
    await expect(runForegroundSync()).resolves.toEqual({ applied: 0, conflicts: 0, cursor: 4, pending: 1 });
    const reopened = await openSongsStorage();
    const superseded = (await reopened.listAuthoredResolutionOutbox())[0]!;
    expect(superseded).toMatchObject({ state: "failed", lastError: `SUPERSEDED: conflict resolved by ${resolutionRevisionId}` });
    await reopened.discardFailedConflictResolution(superseded.id);
    expect(await reopened.listAuthoredResolutionOutbox()).toEqual([]);
    reopened.close();
  });

  it("rejects a mismatched server operation outcome without deleting durable resolution work", async () => {
    const record = await seedConflictResolution();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestURL(input);
      if (url.endsWith("/devices/register")) return json(registration());
      if (url.endsWith(`/conflicts/${conflictId}/resolve`)) return json({
        operation_id: "operation-other", status: "resolved", revision_id: resolutionRevisionId, conflict_id: conflictId, sequence: 4,
      });
      throw new Error(`unexpected fetch ${url}`);
    }));

    await expect(runForegroundSync()).rejects.toThrow(/operation identity/);
    const storage = await openSongsStorage();
    expect(await storage.listAuthoredResolutionOutbox()).toEqual([expect.objectContaining({
      id: record.id, state: "failed", attempts: 1, currentRevisionId, candidateRevisionId,
    })]);
    expect((await storage.listAuthoredRevisions()).map((item) => item.id)).not.toContain(resolutionRevisionId);
    expect((await storage.readAuthoredState()).conflicts[0]?.status).toBe("open");
    storage.close();
  });

  it("merges current and published mappings when one pull batch contains both events for a document", async () => {
    const authored = await authoredMutation();
    const current = serverRevision(authored, currentRevisionId, "server-current", "");
    const refreshed = serverRevision(authored, refreshedRevisionId, "server-refreshed", currentRevisionId);
    const storage = await openSongsStorage();
    await storage.commitAuthoredSync({ expectedCursor: 0, sync: syncState(1), revisions: [current] });
    storage.close();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestURL(input);
      if (url.endsWith("/devices/register")) return json(registration());
      if (url.endsWith("/pull?after=1")) return json({
        events: [
          { sequence: 2, kind: "applied", operation_id: refreshed.operationId, document_id: refreshed.documentId, revision_id: refreshed.id },
          { sequence: 3, kind: "published", operation_id: "publish-current", document_id: current.documentId, revision_id: current.id },
        ], revisions: [wireRevision(refreshed)], conflicts: [], cursor: 3, compaction_floor: 0,
      });
      if (url.endsWith("/ack")) return json({ protocol_version: "1", cursor: 3, status: "acknowledged" });
      throw new Error(`unexpected fetch ${url}`);
    }));
    await runForegroundSync({ setListWrites: false, leadSheetWrites: false });
    const reopened = await openSongsStorage();
    expect((await reopened.readAuthoredSyncState())?.documents[0]).toEqual({ documentId: current.documentId, currentServerRevisionId: refreshed.id, publishedRevisionId: current.id });
    reopened.close();
  });

  it("binds edit-before-first-sync only to an exact matching server baseline revision", async () => {
    const baseline = createSetList({
      id: "set-conflict-gig", path: "sets/Conflict-Gig.md", title: "Reviewed baseline",
      sections: [{ id: "section-main", heading: "Set One", entries: [] }],
    });
    const root = executeSetListCommand(null, { kind: "create-set-list", document: baseline }, { revisionId: "revision-root", operationId: "operation-root" });
    const edited = executeSetListCommand(root, { kind: "update-details", title: "Edited offline before first sync" }, { revisionId: "revision-edited", operationId: "operation-edited" });
    const rootMutation = await buildAuthoredMutation(root, { deviceId, baseServerRevisionId: "", clientCursor: 0, createdAt: at1 });
    const editedMutation = await buildAuthoredMutation(edited, { deviceId, baseServerRevisionId: "", clientCursor: 0, createdAt: at1 });
    const serverBaseline = serverRevision(rootMutation, currentRevisionId, "server-bootstrap", "");
    const storage = await openSongsStorage();
    await storage.commitAuthoredMutation(rootMutation);
    await storage.commitAuthoredMutation(editedMutation);
    storage.close();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestURL(input);
      if (url.endsWith("/devices/register")) return json(registration());
      if (url.endsWith("/snapshot")) return json({
        protocol_version: "1", cursor: 1, compaction_floor: 0, revisions: [wireRevision(serverBaseline)], conflicts: [],
        documents: [{ document_id: baseline.id, current_revision_id: serverBaseline.id, title: baseline.title }], publications: [],
      });
      if (url.endsWith("/pull?after=1")) return json({ events: [], revisions: [], conflicts: [], cursor: 1, compaction_floor: 0 });
      if (url.endsWith("/ack")) return json({ protocol_version: "1", cursor: 1, status: "acknowledged" });
      throw new Error(`unexpected fetch ${url}`);
    }));
    await expect(runForegroundSync({ setListWrites: false, leadSheetWrites: false })).resolves.toEqual({ applied: 0, conflicts: 0, cursor: 1, pending: 1 });
    const reopened = await openSongsStorage();
    const pending = (await reopened.listAuthoredOutbox())[0]!;
    expect(pending.envelope).toMatchObject({ operation_id: "operation-edited", base_revision_id: currentRevisionId, client_cursor: 1 });
    expect(pending.envelope.payload.source).toContain("Edited offline before first sync");
    expect((await reopened.readAuthoredDraft(baseline.id))?.baseServerRevisionId).toBe(currentRevisionId);
    reopened.close();
  });

  it("refreshes a compacted cursor snapshot without rebasing never-attempted local edits onto an unseen head", async () => {
    const authored = await authoredMutation(currentRevisionId, 1);
    const current = serverRevision(authored, currentRevisionId, "server-current", "");
    const refreshed = serverRevision(authored, refreshedRevisionId, "server-refreshed", currentRevisionId);
    const storage = await openSongsStorage();
    await storage.commitAuthoredSync({ expectedCursor: 0, sync: syncState(1), revisions: [current] });
    await storage.commitAuthoredMutation(authored);
    storage.close();
    const beforeEnvelope = authored.outbox.envelope;

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestURL(input);
      if (url.endsWith("/devices/register")) return json(registration());
      if (url.endsWith("/pull?after=1")) return json({ error: { code: "RESNAPSHOT_REQUIRED", message: "cursor requires a fresh snapshot" } }, 409);
      if (url.endsWith("/snapshot")) return json({
        protocol_version: "1", cursor: 5, compaction_floor: 4,
        revisions: [wireRevision(current), wireRevision(refreshed)], conflicts: [],
        documents: [{ document_id: "set-conflict-gig", current_revision_id: refreshedRevisionId, title: "Conflict Gig" }],
        publications: [],
      });
      if (url.endsWith("/ack")) return json({ protocol_version: "1", cursor: 5, status: "acknowledged" });
      throw new Error(`unexpected fetch ${url}`);
    }));

    await expect(runForegroundSync({ setListWrites: false, leadSheetWrites: false })).resolves.toEqual({ applied: 0, conflicts: 0, cursor: 5, pending: 1 });
    const reopened = await openSongsStorage();
    const pending = (await reopened.listAuthoredOutbox())[0]!;
    expect(pending).toMatchObject({ state: "pending", attempts: 0 });
    expect(pending.envelope).toEqual(beforeEnvelope);
    expect(pending.canonicalPayload).toBe(authored.outbox.canonicalPayload);
    expect(pending.envelope.payload_sha256).toBe(beforeEnvelope.payload_sha256);
    expect((await reopened.readAuthoredDraft("set-conflict-gig"))?.baseServerRevisionId).toBe(currentRevisionId);
    expect((await reopened.readAuthoredSyncState())?.acknowledgedCursor).toBe(5);
    reopened.close();
  });
});
