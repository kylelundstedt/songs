import { openSongsStorage, type SongsStorage } from "../storage";
import {
  AUTHORED_CONFLICT_SCHEMA_VERSION, AUTHORED_REVISION_SCHEMA_VERSION, AUTHORED_SYNC_SCHEMA_VERSION, AUTHORED_SYNC_STATE_ID,
  buildResolvedDraftProjection, buildLeadSheetWorkspaceRecord,
  isAuthoredApplyOutboxRecord, isAuthoredResolutionOutboxRecord,
  type AnyAuthoredApplyOutboxRecord, type AnyAuthoredDraftRecord, type AnyAuthoredLocalRevisionRecord, type AnyAuthoredOutboxRecord,
  type AnyAuthoredServerRevisionRecord, type AuthoredConflictRecord, type AuthoredDocumentSyncState,
  type AuthoredResolutionOutboxRecord, type AuthoredSyncStateRecord, type LeadSheetWorkspaceRecord,
} from "../storage/authored";
import {
  acknowledge, applyOperation, pull, registerDevice, resolveConflict, snapshot, SyncHTTPError,
  type DeviceCredential, type SyncConflict, type SyncRevision, type SyncSnapshot,
} from "./client";
import { randomStableId } from "../setlists/model";

const DEVICE_KEY = "songs-v2-device-id";
const SERVER_RECEIVED_AT = "1970-01-01T00:00:00.000Z";
function now(): string { return new Date().toISOString(); }
function newDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_KEY);
  if (existing !== null) return existing;
  return randomStableId("set").replace(/^set-/, "browser-");
}
function serverRevision(revision: SyncRevision): AnyAuthoredServerRevisionRecord | null {
  const payload = revision.payload as { kind?: unknown };
  if (payload === null || typeof payload !== "object" || (payload.kind !== "set-list" && payload.kind !== "lead-sheet")) return null;
  return { id: revision.revision_id, schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION, origin: "server", documentId: revision.document_id, deviceId: revision.device_id, operationId: revision.operation_id, baseRevisionId: revision.base_revision_id, title: revision.title, payload: revision.payload as AnyAuthoredServerRevisionRecord["payload"], contentHash: revision.content_hash, receivedAt: SERVER_RECEIVED_AT } as AnyAuthoredServerRevisionRecord;
}
function conflictRecord(conflict: SyncConflict): AuthoredConflictRecord {
  return { id: conflict.conflict_id, schemaVersion: AUTHORED_CONFLICT_SCHEMA_VERSION, documentId: conflict.document_id, currentRevisionId: conflict.current_revision_id, candidateRevisionId: conflict.candidate_revision_id, resolutionRevisionId: conflict.resolution_revision_id ?? "", status: conflict.status, updatedAt: now() };
}
function mergeDocuments(current: readonly AuthoredDocumentSyncState[], changes: ReadonlyMap<string, Partial<AuthoredDocumentSyncState>>): readonly AuthoredDocumentSyncState[] {
  const records = new Map(current.map((item) => [item.documentId, { ...item }]));
  for (const [id, change] of changes) records.set(id, { documentId: id, currentServerRevisionId: "", publishedRevisionId: "", ...records.get(id), ...change });
  return [...records.values()].sort((a, b) => a.documentId.localeCompare(b.documentId));
}
function rebaseOutbox(record: AnyAuthoredApplyOutboxRecord, baseRevisionId: string, clientCursor: number): AnyAuthoredApplyOutboxRecord {
  return { ...record, envelope: { ...record.envelope, base_revision_id: baseRevisionId, client_cursor: clientCursor } } as AnyAuthoredApplyOutboxRecord;
}
function syncState(device: string, cursor: number, acknowledged: number, documents: readonly AuthoredDocumentSyncState[]): AuthoredSyncStateRecord {
  return { id: AUTHORED_SYNC_STATE_ID, schemaVersion: AUTHORED_SYNC_SCHEMA_VERSION, deviceId: device, cursor, acknowledgedCursor: acknowledged, documents, updatedAt: now() };
}
function snapshotProjection(remote: SyncSnapshot): { readonly revisions: readonly AnyAuthoredServerRevisionRecord[]; readonly documents: readonly AuthoredDocumentSyncState[] } {
  const revisions = remote.revisions.map(serverRevision).filter((item): item is AnyAuthoredServerRevisionRecord => item !== null);
  const revisionIDs = new Set(revisions.map((item) => item.id));
  const publications = new Map((remote.publications ?? []).map((item) => [item.document_id, item.revision_id]));
  const documents = (remote.documents ?? [])
    .filter((item) => revisionIDs.has(item.current_revision_id))
    .map((item) => ({
      documentId: item.document_id,
      currentServerRevisionId: item.current_revision_id,
      publishedRevisionId: revisionIDs.has(publications.get(item.document_id) ?? "") ? publications.get(item.document_id)! : "",
    }))
    .sort((a, b) => a.documentId.localeCompare(b.documentId));
  return { revisions, documents };
}

async function reconcileResolutionOutbox(storage: SongsStorage): Promise<void> {
  let state = await storage.readAuthoredState();
  if (state.sync === null) return;
  for (const record of state.outbox.filter(isAuthoredResolutionOutboxRecord)) {
    if (record.state === "failed" && record.lastError?.startsWith("SUPERSEDED:")) continue;
    const conflict = state.conflicts.find((item) => item.id === record.conflictId);
    if (conflict?.status !== "resolved" || conflict.resolutionRevisionId === "") continue;
    const accepted = state.revisions.find((revision): revision is AnyAuthoredServerRevisionRecord => revision.origin === "server"
      && revision.id === conflict.resolutionRevisionId
      && revision.deviceId === record.envelope.device_id
      && revision.operationId === record.envelope.operation_id
      && revision.documentId === record.documentId
      && revision.baseRevisionId === record.envelope.base_revision_id
      && revision.title === record.envelope.title
      && revision.contentHash === record.envelope.payload_sha256);
    if (accepted !== undefined) {
      const projection = await resolutionDraftProjection(storage, accepted, record.reviewedLocalRevisionId);
      await storage.commitAuthoredSync({
        expectedCursor: state.sync.cursor, sync: state.sync,
        revisions: projection.revisions, drafts: projection.drafts, workspaces: projection.workspaces, removeOutboxIds: [record.id],
      });
    } else {
      const winner = state.revisions.find((revision): revision is AnyAuthoredServerRevisionRecord => revision.origin === "server" && revision.id === conflict.resolutionRevisionId);
      if (winner === undefined) throw new Error("Resolved conflict is missing its winning server revision");
      const projection = await resolutionDraftProjection(storage, winner, record.reviewedLocalRevisionId);
      if (projection.revisions.length > 0 || projection.drafts.length > 0 || projection.workspaces.length > 0) {
        await storage.commitAuthoredSync({ expectedCursor: state.sync.cursor, sync: state.sync, revisions: projection.revisions, drafts: projection.drafts, workspaces: projection.workspaces });
      }
      await storage.markConflictResolutionSuperseded(record.id, conflict.resolutionRevisionId, now());
    }
    state = await storage.readAuthoredState();
    if (state.sync === null) return;
  }
}

/** Persist an authoritative snapshot while retaining all retry/CAS evidence. */
async function persistSnapshot(
  storage: SongsStorage,
  deviceId: string,
  previous: AuthoredSyncStateRecord | null,
  remote: SyncSnapshot,
): Promise<AuthoredSyncStateRecord> {
  const { revisions, documents } = snapshotProjection(remote);
  const authored = await storage.readAuthoredState();
  const outbox = await storage.listAllAuthoredOutbox();
  const replacements: AnyAuthoredApplyOutboxRecord[] = [];
  const draftUpdates: { expectedLocalRevisionId: string; draft: AnyAuthoredDraftRecord }[] = [];
  if (previous === null) {
    const localRoots = new Map(authored.revisions
      .filter((item): item is AnyAuthoredLocalRevisionRecord => item.origin === "local" && item.parentRevisionId === null)
      .map((item) => [item.documentId, item]));
    const baselineByDocument = new Map<string, AnyAuthoredServerRevisionRecord>();
    for (const [documentId, root] of localRoots) {
      const match = revisions.find((revision) => revision.documentId === documentId
        && revision.payload.kind === (root.document.schemaVersion === "songs-v2-lead-sheet-1" ? "lead-sheet" : "set-list")
        && revision.payload.path === root.document.path && revision.payload.source === root.source);
      if (match !== undefined) baselineByDocument.set(documentId, match);
    }
    for (const record of outbox.filter(isAuthoredApplyOutboxRecord)) {
      if (record.state !== "pending" || record.attempts !== 0) continue;
      const baseline = record.envelope.base_revision_id === "" ? baselineByDocument.get(record.documentId)?.id ?? "" : record.envelope.base_revision_id;
      const replacement = rebaseOutbox(record, baseline, remote.cursor);
      if (replacement.envelope.base_revision_id !== record.envelope.base_revision_id || replacement.envelope.client_cursor !== record.envelope.client_cursor) replacements.push(replacement);
    }
    for (const draft of authored.drafts) {
      const baseline = draft.baseServerRevisionId === "" ? baselineByDocument.get(draft.documentId)?.id ?? "" : draft.baseServerRevisionId;
      if (baseline !== draft.baseServerRevisionId) draftUpdates.push({
        expectedLocalRevisionId: draft.localRevisionId,
        draft: { ...draft, baseServerRevisionId: baseline, updatedAt: now() } as AnyAuthoredDraftRecord,
      });
    }
  }
  const remoteConflicts = remote.conflicts.map(conflictRecord);
  const remoteConflictIDs = new Set(remoteConflicts.map((item) => item.id));
  const retainedConflictIDs = new Set(outbox.filter(isAuthoredResolutionOutboxRecord).map((item) => item.conflictId));
  const removeConflictIds = authored.conflicts.filter((item) => !remoteConflictIDs.has(item.id) && !retainedConflictIDs.has(item.id)).map((item) => item.id);
  await storage.commitAuthoredSync({
    expectedCursor: previous?.cursor ?? 0,
    sync: syncState(deviceId, remote.cursor, Math.min(previous?.acknowledgedCursor ?? 0, remote.cursor), documents),
    revisions, conflicts: remoteConflicts, removeConflictIds, replaceOutbox: replacements, drafts: draftUpdates,
  });
  await reconcileResolutionOutbox(storage);
  const durable = await storage.readAuthoredSyncState();
  if (durable === null) throw new Error("Snapshot refresh did not produce durable sync state");
  return durable;
}

async function acknowledgeDurably(storage: SongsStorage, state: AuthoredSyncStateRecord, credential: DeviceCredential): Promise<AuthoredSyncStateRecord> {
  await acknowledge(state.cursor, credential);
  if (state.acknowledgedCursor === state.cursor) return state;
  await storage.commitAuthoredSync({
    expectedCursor: state.cursor,
    sync: syncState(state.deviceId, state.cursor, state.cursor, state.documents),
  });
  const durable = await storage.readAuthoredSyncState();
  if (durable === null) throw new Error("Sync state disappeared after acknowledgement");
  return durable;
}

function durableOutcomeRevision(record: AnyAuthoredOutboxRecord, revisionId: string, deviceId: string): AnyAuthoredServerRevisionRecord {
  return {
    id: revisionId, schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION, origin: "server", documentId: record.documentId,
    deviceId, operationId: record.envelope.operation_id, baseRevisionId: record.envelope.base_revision_id,
    title: record.envelope.title, payload: record.envelope.payload, contentHash: record.envelope.payload_sha256,
    receivedAt: SERVER_RECEIVED_AT,
  } as AnyAuthoredServerRevisionRecord;
}

async function resolutionDraftProjection(storage: SongsStorage, server: AnyAuthoredServerRevisionRecord, reviewedLocalRevisionId: string): Promise<{
  readonly revisions: readonly AnyAuthoredLocalRevisionRecord[];
  readonly drafts: readonly { readonly expectedLocalRevisionId: string; readonly draft: AnyAuthoredDraftRecord }[];
  readonly workspaces: readonly { readonly expectedSourceSha256: string; readonly workspace: LeadSheetWorkspaceRecord }[];
}> {
  const state = await storage.readAuthoredState();
  const draft = state.drafts.find((item) => item.documentId === server.documentId);
  if (draft === undefined || reviewedLocalRevisionId === "" || draft.localRevisionId !== reviewedLocalRevisionId) return { revisions: [], drafts: [], workspaces: [] };
  const projectionRevisionId = `revision-resolution-${server.id.slice("rev-".length)}`;
  if (draft.baseServerRevisionId === server.id || state.revisions.some((item) => item.origin === "local" && item.id === projectionRevisionId)) {
    return { revisions: [], drafts: [], workspaces: [] };
  }
  const current = state.revisions.find((item): item is AnyAuthoredLocalRevisionRecord => item.origin === "local" && item.id === draft.localRevisionId);
  if (current === undefined) throw new Error("Resolved document draft is missing its local revision");
  const workspace = draft.kind === "lead-sheet" ? await storage.readLeadSheetWorkspace(draft.documentId) : null;
  const projected = await buildResolvedDraftProjection(draft, current, server, now());
  const workspaces = workspace !== null && workspace.sourceSha256 === draft.sourceSha256 && projected.draft.kind === "lead-sheet"
    ? [{
      expectedSourceSha256: workspace.sourceSha256,
      workspace: await buildLeadSheetWorkspaceRecord({ id: workspace.documentId, path: workspace.path, source: projected.draft.source }, { updatedAt: now(), baseServerRevisionId: server.id }),
    }]
    : [];
  return {
    revisions: projected.revision === undefined ? [] : [projected.revision],
    drafts: [{ expectedLocalRevisionId: draft.localRevisionId, draft: projected.draft }],
    workspaces,
  };
}
export interface ForegroundSyncResult { readonly applied: number; readonly conflicts: number; readonly cursor: number; readonly pending: number }
export interface ForegroundSyncOptions { readonly setListWrites: boolean; readonly leadSheetWrites: boolean }

function permittedKind(kind: "set-list" | "lead-sheet", options: ForegroundSyncOptions): boolean {
  return kind === "set-list" ? options.setListWrites : options.leadSheetWrites;
}

export async function runForegroundSync(options: ForegroundSyncOptions = { setListWrites: true, leadSheetWrites: true }): Promise<ForegroundSyncResult> {
  const storage = await openSongsStorage();
  let applied = 0, conflictCount = 0;
  try {
    let state = await storage.readAuthoredSyncState();
    const existingOutbox = await storage.listAllAuthoredOutbox();
    const id = state?.deviceId ?? existingOutbox[0]?.envelope.device_id ?? newDeviceId();
    if (existingOutbox.some((item) => item.envelope.device_id !== id)) throw new Error("Recovered outbox contains more than one device identity");
    localStorage.setItem(DEVICE_KEY, id);
    const registration = await registerDevice({ deviceId: id, registrationId: id, name: "V2 browser" });
    const credential: DeviceCredential = { deviceId: id, token: registration.token };
    if (state === null) state = await persistSnapshot(storage, id, null, await snapshot(credential));

    for (;;) {
      const queue = await storage.listAllAuthoredOutbox();
      const openConflictIDs = new Set((await storage.readAuthoredState()).conflicts.filter((item) => item.status === "open").map((item) => item.id));
      const next = queue.find((item) => permittedKind(item.envelope.payload.kind, options) && (
        !isAuthoredResolutionOutboxRecord(item)
        || openConflictIDs.has(item.conflictId) && !(item.state === "failed" && (item.lastError?.startsWith("CONFLICT_CAS_FAILED:") || item.lastError?.startsWith("SUPERSEDED:")))
      ));
      if (next === undefined) break;
      const claimOptions = {
        outboxId: next.id,
        kind: next.envelope.payload.kind,
        recordType: isAuthoredResolutionOutboxRecord(next) ? "resolution" as const : "apply" as const,
        attemptedAt: now(),
        reclaimSendingBefore: new Date(Date.now() - 60_000).toISOString(),
      };
      const record = await storage.claimNextAuthoredOutbox(claimOptions);
      if (record === null) break;
      try {
        const outcome = isAuthoredResolutionOutboxRecord(record)
          ? await resolveConflict(record.conflictId, record.envelope, credential)
          : await applyOperation(record.envelope, credential);
        if (outcome.operation_id !== record.envelope.operation_id) throw new Error("Sync outcome operation identity does not match the durable outbox record");
        if (isAuthoredResolutionOutboxRecord(record) && (outcome.status !== "resolved" || outcome.conflict_id !== record.conflictId)) {
          throw new Error("Conflict resolution returned a mismatched outcome");
        }
        if (isAuthoredApplyOutboxRecord(record) && outcome.status !== "applied" && outcome.status !== "conflict") {
          throw new Error("Apply operation returned a mismatched outcome");
        }
        const serverRevisionRecord = durableOutcomeRevision(record, outcome.revision_id, id);
        const current = await storage.readAuthoredSyncState();
        if (current === null) throw new Error("Sync state disappeared");
        const changes = new Map<string, Partial<AuthoredDocumentSyncState>>();
        if (outcome.status === "applied" || outcome.status === "resolved") changes.set(record.documentId, { currentServerRevisionId: outcome.revision_id });
        const draft = await storage.readAuthoredDraft(record.documentId, record.envelope.payload.kind);
        const resolutionProjection = outcome.status === "resolved" ? await resolutionDraftProjection(storage, serverRevisionRecord, isAuthoredResolutionOutboxRecord(record) ? record.reviewedLocalRevisionId : "") : { revisions: [], drafts: [], workspaces: [] };
        const queued = await storage.listAllAuthoredOutbox();
        const replacements = outcome.status === "applied"
          ? queued.filter(isAuthoredApplyOutboxRecord)
            .filter((item) => item.documentId === record.documentId && item.id !== record.id && item.state === "pending" && item.attempts === 0)
            .map((item) => rebaseOutbox(item, outcome.revision_id, outcome.sequence))
          : [];
        const draftUpdates: { expectedLocalRevisionId: string; draft: AnyAuthoredDraftRecord }[] = [...resolutionProjection.drafts];
        if (
          outcome.status === "applied" && draft !== null
          && draft.source === record.envelope.payload.source && draft.document.path === record.envelope.payload.path
        ) draftUpdates.push({ expectedLocalRevisionId: draft.localRevisionId, draft: { ...draft, baseServerRevisionId: outcome.revision_id, updatedAt: now() } });
        const resolvedConflict = isAuthoredResolutionOutboxRecord(record)
          ? [{
            id: record.conflictId, schemaVersion: AUTHORED_CONFLICT_SCHEMA_VERSION, documentId: record.documentId,
            currentRevisionId: record.currentRevisionId, candidateRevisionId: record.candidateRevisionId,
            resolutionRevisionId: outcome.revision_id, status: "resolved" as const, updatedAt: now(),
          }]
          : [];
        await storage.commitAuthoredSync({
          expectedCursor: current.cursor,
          sync: syncState(id, current.cursor, current.acknowledgedCursor, mergeDocuments(current.documents, changes)),
          revisions: [serverRevisionRecord, ...resolutionProjection.revisions], drafts: draftUpdates, workspaces: resolutionProjection.workspaces, conflicts: resolvedConflict,
          removeOutboxIds: [record.id], replaceOutbox: replacements,
        });
        if (outcome.status === "conflict") conflictCount++; else applied++;
        state = await storage.readAuthoredSyncState();
        if (state === null) throw new Error("Sync state disappeared");
      } catch (error) {
        const failureMessage = error instanceof SyncHTTPError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "Sync failed";
        await storage.failAuthoredOutbox(record.id, { failedAt: now(), message: failureMessage });
        if (error instanceof SyncHTTPError && error.code === "RESNAPSHOT_REQUIRED") {
          state = await persistSnapshot(storage, id, await storage.readAuthoredSyncState(), await snapshot(credential));
          break;
        }
        if (error instanceof SyncHTTPError && (error.code === "PUBLICATION_RESERVED" || error.code === "CONFLICT_CAS_FAILED")) break;
        throw error;
      }
    }

    state = await storage.readAuthoredSyncState();
    if (state === null) throw new Error("Sync state disappeared");
    try {
      const pulled = await pull(state.cursor, credential);
      const revisions = pulled.revisions.map(serverRevision).filter((item): item is AnyAuthoredServerRevisionRecord => item !== null);
      const changes = new Map<string, Partial<AuthoredDocumentSyncState>>();
      for (const event of pulled.events) {
        if (event.kind === "applied" || event.kind === "resolved") changes.set(event.document_id, { ...changes.get(event.document_id), currentServerRevisionId: event.revision_id });
        if (event.kind === "published") changes.set(event.document_id, { ...changes.get(event.document_id), publishedRevisionId: event.revision_id });
      }
      await storage.commitAuthoredSync({
        expectedCursor: state.cursor,
        sync: syncState(id, pulled.cursor, state.acknowledgedCursor, mergeDocuments(state.documents, changes)),
        revisions, conflicts: pulled.conflicts.map(conflictRecord),
      });
      await reconcileResolutionOutbox(storage);
      state = await storage.readAuthoredSyncState();
      if (state === null) throw new Error("Sync state disappeared");
    } catch (error) {
      if (!(error instanceof SyncHTTPError) || error.code !== "RESNAPSHOT_REQUIRED") throw error;
      state = await persistSnapshot(storage, id, state, await snapshot(credential));
    }
    state = await acknowledgeDurably(storage, state, credential);
    window.dispatchEvent(new Event("songs-v2-authored-change"));
    return {
      applied,
      conflicts: conflictCount + (await storage.readAuthoredState()).conflicts.filter((item) => item.status === "open").length,
      cursor: state.cursor,
      pending: (await storage.listAllAuthoredOutbox()).length,
    };
  } finally { storage.close(); }
}
