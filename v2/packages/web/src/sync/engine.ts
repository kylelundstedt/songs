import { openSongsStorage } from "../storage";
import {
  AUTHORED_CONFLICT_SCHEMA_VERSION, AUTHORED_REVISION_SCHEMA_VERSION, AUTHORED_SYNC_SCHEMA_VERSION, AUTHORED_SYNC_STATE_ID,
  type AuthoredConflictRecord, type AuthoredDocumentSyncState, type AuthoredDraftRecord, type AuthoredServerRevisionRecord, type AuthoredSyncStateRecord,
} from "../storage/authored";
import { acknowledge, applyOperation, pull, registerDevice, snapshot, SyncHTTPError, type DeviceCredential, type SyncConflict, type SyncRevision } from "./client";
import { randomStableId } from "../setlists/model";

const DEVICE_KEY = "songs-v2-device-id";
const SERVER_RECEIVED_AT = "1970-01-01T00:00:00.000Z";
function now(): string { return new Date().toISOString(); }
function newDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_KEY);
  if (existing !== null) return existing;
  return randomStableId("set").replace(/^set-/, "browser-");
}
function serverRevision(revision: SyncRevision): AuthoredServerRevisionRecord | null {
  const payload = revision.payload as { kind?: unknown };
  if (payload === null || typeof payload !== "object" || payload.kind !== "set-list") return null;
  return { id: revision.revision_id, schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION, origin: "server", documentId: revision.document_id, deviceId: revision.device_id, operationId: revision.operation_id, baseRevisionId: revision.base_revision_id, title: revision.title, payload: revision.payload as AuthoredServerRevisionRecord["payload"], contentHash: revision.content_hash, receivedAt: SERVER_RECEIVED_AT };
}
function conflictRecord(conflict: SyncConflict): AuthoredConflictRecord {
  return { id: conflict.conflict_id, schemaVersion: AUTHORED_CONFLICT_SCHEMA_VERSION, documentId: conflict.document_id, currentRevisionId: conflict.current_revision_id, candidateRevisionId: conflict.candidate_revision_id, resolutionRevisionId: conflict.resolution_revision_id ?? "", status: conflict.status, updatedAt: now() };
}
function mergeDocuments(current: readonly AuthoredDocumentSyncState[], changes: ReadonlyMap<string, Partial<AuthoredDocumentSyncState>>): readonly AuthoredDocumentSyncState[] {
  const records = new Map(current.map((item) => [item.documentId, { ...item }]));
  for (const [id, change] of changes) records.set(id, { documentId: id, currentServerRevisionId: "", publishedRevisionId: "", ...records.get(id), ...change });
  return [...records.values()].sort((a, b) => a.documentId.localeCompare(b.documentId));
}
function syncState(device: string, cursor: number, acknowledged: number, documents: readonly AuthoredDocumentSyncState[]): AuthoredSyncStateRecord {
  return { id: AUTHORED_SYNC_STATE_ID, schemaVersion: AUTHORED_SYNC_SCHEMA_VERSION, deviceId: device, cursor, acknowledgedCursor: acknowledged, documents, updatedAt: now() };
}

export interface ForegroundSyncResult { readonly applied: number; readonly conflicts: number; readonly cursor: number; readonly pending: number }

export async function runForegroundSync(): Promise<ForegroundSyncResult> {
  const storage = await openSongsStorage();
  let applied = 0, conflictCount = 0;
  try {
    let state = await storage.readAuthoredSyncState();
    const existingOutbox = await storage.listAuthoredOutbox();
    const id = state?.deviceId ?? existingOutbox[0]?.envelope.device_id ?? newDeviceId();
    if (existingOutbox.some((item) => item.envelope.device_id !== id)) throw new Error("Recovered outbox contains more than one device identity");
    localStorage.setItem(DEVICE_KEY, id);
    const registration = await registerDevice({ deviceId: id, registrationId: id, name: "V2 browser" });
    const credential: DeviceCredential = { deviceId: id, token: registration.token };
    if (state === null) {
      const remote = await snapshot(credential);
      const revisions = remote.revisions.map(serverRevision).filter((item): item is AuthoredServerRevisionRecord => item !== null);
      const publications = new Map((remote.publications ?? []).map((item) => [item.document_id, item.revision_id]));
      const revisionIDs = new Set(revisions.map((item) => item.id));
      const documents = (remote.documents ?? []).filter((item) => revisionIDs.has(item.current_revision_id)).map((item) => ({ documentId: item.document_id, currentServerRevisionId: item.current_revision_id, publishedRevisionId: revisionIDs.has(publications.get(item.document_id) ?? "") ? publications.get(item.document_id)! : "" })).sort((a, b) => a.documentId.localeCompare(b.documentId));
      const documentMap = new Map(documents.map((item) => [item.documentId, item]));
      const [pending, drafts] = await Promise.all([storage.listAuthoredOutbox(), storage.listAuthoredDrafts()]);
      const replacements = pending.filter((item) => item.attempts === 0 && item.state === "pending" && item.envelope.base_revision_id === "" && documentMap.has(item.documentId)).map((item) => ({ ...item, envelope: { ...item.envelope, base_revision_id: documentMap.get(item.documentId)!.currentServerRevisionId, client_cursor: remote.cursor } }));
      const draftUpdates = drafts.filter((draft) => draft.baseServerRevisionId === "" && documentMap.has(draft.documentId)).map((draft) => ({ expectedLocalRevisionId: draft.localRevisionId, draft: { ...draft, baseServerRevisionId: documentMap.get(draft.documentId)!.currentServerRevisionId, updatedAt: now() } }));
      await storage.commitAuthoredSync({ expectedCursor: 0, sync: syncState(id, remote.cursor, 0, documents), revisions, conflicts: remote.conflicts.map(conflictRecord), replaceOutbox: replacements, drafts: draftUpdates });
      state = await storage.readAuthoredSyncState();
    }
    if (state === null) throw new Error("Unable to initialize durable sync state");
    for (;;) {
      const record = await storage.claimNextAuthoredOutbox({ attemptedAt: now(), reclaimSendingBefore: new Date(Date.now() - 60_000).toISOString() });
      if (record === null) break;
      try {
        const outcome = await applyOperation(record.envelope, credential);
        const revision: AuthoredServerRevisionRecord = { id: outcome.revision_id, schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION, origin: "server", documentId: record.documentId, deviceId: id, operationId: record.envelope.operation_id, baseRevisionId: record.envelope.base_revision_id, title: record.envelope.title, payload: record.envelope.payload, contentHash: record.envelope.payload_sha256, receivedAt: SERVER_RECEIVED_AT };
        const current = await storage.readAuthoredSyncState(); if (current === null) throw new Error("Sync state disappeared");
        const changes = new Map<string, Partial<AuthoredDocumentSyncState>>();
        if (outcome.status === "applied") changes.set(record.documentId, { currentServerRevisionId: outcome.revision_id });
        const draft = await storage.readAuthoredDraft(record.documentId);
        const queued = await storage.listAuthoredOutbox();
        const replacements = outcome.status === "applied" ? queued.filter((item) => item.documentId === record.documentId && item.id !== record.id && item.state === "pending" && item.attempts === 0).map((item) => ({ ...item, envelope: { ...item.envelope, base_revision_id: outcome.revision_id, client_cursor: outcome.sequence } })) : [];
        const draftUpdate: { expectedLocalRevisionId: string; draft: AuthoredDraftRecord }[] = [];
        if (outcome.status === "applied" && draft !== null) draftUpdate.push({ expectedLocalRevisionId: draft.localRevisionId, draft: { ...draft, baseServerRevisionId: outcome.revision_id, updatedAt: now() } });
        await storage.commitAuthoredSync({ expectedCursor: current.cursor, sync: syncState(id, current.cursor, current.acknowledgedCursor, mergeDocuments(current.documents, changes)), revisions: [revision], drafts: draftUpdate, removeOutboxIds: [record.id], replaceOutbox: replacements });
        if (outcome.status === "conflict") conflictCount++; else applied++;
        state = await storage.readAuthoredSyncState();
      } catch (error) {
        await storage.failAuthoredOutbox(record.id, { failedAt: now(), message: error instanceof Error ? error.message : "Sync failed" });
        if (error instanceof SyncHTTPError && error.code === "PUBLICATION_RESERVED") break;
        throw error;
      }
    }
    state = await storage.readAuthoredSyncState(); if (state === null) throw new Error("Sync state disappeared");
    const pulled = await pull(state.cursor, credential);
    const revisions = pulled.revisions.map(serverRevision).filter((item): item is AuthoredServerRevisionRecord => item !== null);
    const changes = new Map<string, Partial<AuthoredDocumentSyncState>>();
    for (const event of pulled.events) {
      if (event.kind === "applied" || event.kind === "resolved") changes.set(event.document_id, { currentServerRevisionId: event.revision_id });
      if (event.kind === "published") changes.set(event.document_id, { publishedRevisionId: event.revision_id });
    }
    await storage.commitAuthoredSync({ expectedCursor: state.cursor, sync: syncState(id, pulled.cursor, state.acknowledgedCursor, mergeDocuments(state.documents, changes)), revisions, conflicts: pulled.conflicts.map(conflictRecord) });
    await acknowledge(pulled.cursor, credential);
    const durable = await storage.readAuthoredSyncState();
    if (durable !== null && durable.acknowledgedCursor !== pulled.cursor) await storage.commitAuthoredSync({ expectedCursor: durable.cursor, sync: syncState(id, durable.cursor, pulled.cursor, durable.documents) });
    window.dispatchEvent(new Event("songs-v2-authored-change"));
    return { applied, conflicts: conflictCount + pulled.conflicts.filter((item) => item.status === "open").length, cursor: pulled.cursor, pending: (await storage.listAuthoredOutbox()).length };
  } finally { storage.close(); }
}
