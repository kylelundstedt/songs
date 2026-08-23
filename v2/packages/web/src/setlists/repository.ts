import type { SongsStorage } from "../storage";
import { buildAuthoredMutation, type AuthoredLocalRevisionRecord, type AuthoredServerRevisionRecord } from "../storage/authored";
import { decodeCanonicalSetListSource } from "./codec";
import { executeSetListCommand, undoSetListRevision, type SetListCommand, type SetListRevision } from "./commands";
import { randomStableId, type SetList } from "./model";

function asRevision(record: AuthoredLocalRevisionRecord): SetListRevision {
  return Object.freeze({
    schemaVersion: "songs-v2-set-list-revision-1",
    id: record.id as SetListRevision["id"], documentId: record.documentId as SetListRevision["documentId"],
    parentRevisionId: record.parentRevisionId as SetListRevision["parentRevisionId"], operationId: record.operationId as SetListRevision["operationId"],
    operationKind: record.operationKind, command: record.command, inverse: record.inverse, document: record.document,
  });
}

function isReviewedBootstrapRoot(serverHead: AuthoredServerRevisionRecord, baseline: SetList): boolean {
  return serverHead.operationId === "baseline-bootstrap"
    && serverHead.baseRevisionId === ""
    && serverHead.documentId === baseline.id
    && serverHead.payload.kind === "set-list"
    && serverHead.payload.path === baseline.path
    && serverHead.title === baseline.title;
}

function editableServerDocument(serverHead: AuthoredServerRevisionRecord | undefined, baseline: SetList): SetList {
  if (serverHead === undefined || serverHead.origin !== "server" || isReviewedBootstrapRoot(serverHead, baseline)) return baseline;
  return decodeCanonicalSetListSource(serverHead.payload.source, serverHead.payload.path);
}

export interface EditableSetListState { readonly document: SetList; readonly revision: SetListRevision | null; readonly queued: number; readonly baseServerRevisionId: string; readonly publishedRevisionId: string; readonly conflicts: number }

export async function loadEditableSetList(storage: SongsStorage, baseline: SetList): Promise<EditableSetListState> {
  const [draft, outbox, sync, authored, revisions] = await Promise.all([storage.readAuthoredDraft(baseline.id), storage.listAuthoredOutbox(), storage.readAuthoredSyncState(), storage.readAuthoredState(), storage.listAuthoredRevisions(baseline.id)]);
  const documentSync = sync?.documents.find((item) => item.documentId === baseline.id);
  const serverHead = revisions.find((item): item is AuthoredServerRevisionRecord => item.origin === "server" && item.id === documentSync?.currentServerRevisionId && item.payload.kind === "set-list");
  const common = { queued: outbox.filter((item) => item.documentId === baseline.id).length, baseServerRevisionId: documentSync?.currentServerRevisionId ?? "", publishedRevisionId: documentSync?.publishedRevisionId ?? "", conflicts: authored.conflicts.filter((item) => item.documentId === baseline.id && item.status === "open").length };
  if (draft === null) return { document: editableServerDocument(serverHead, baseline), revision: null, ...common };
  const current = revisions.find((item): item is AuthoredLocalRevisionRecord => item.origin === "local" && item.id === draft.localRevisionId);
  if (current === undefined) throw new Error("The durable Set List draft head is missing");
  return { document: draft.document, revision: asRevision(current), ...common, baseServerRevisionId: draft.baseServerRevisionId };
}

const DEVICE_KEY = "songs-v2-device-id";
function browserDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_KEY);
  if (existing !== null) return existing;
  const created = randomStableId("set").replace(/^set-/, "browser-");
  localStorage.setItem(DEVICE_KEY, created);
  return created;
}

async function persist(storage: SongsStorage, revision: SetListRevision, baseServerRevisionId: string): Promise<void> {
  const sync = await storage.readAuthoredSyncState();
  const mutation = await buildAuthoredMutation(revision, {
    deviceId: sync?.deviceId ?? browserDeviceId(),
    baseServerRevisionId,
    clientCursor: sync?.cursor ?? 0,
    createdAt: new Date().toISOString(),
  });
  await storage.commitAuthoredMutation(mutation, { expectedLocalRevisionId: revision.parentRevisionId });
}

async function ensureRevision(storage: SongsStorage, state: EditableSetListState): Promise<SetListRevision> {
  if (state.revision !== null) return state.revision;
  const initial = executeSetListCommand(null, { kind: "create-set-list", document: state.document }, {
    revisionId: randomStableId("revision"), operationId: randomStableId("operation"),
  });
  await persist(storage, initial, state.baseServerRevisionId);
  return initial;
}

export async function initializeEditableSetList(storage: SongsStorage, document: SetList, command: "create" | { readonly sourceDocumentId: string } = "create"): Promise<EditableSetListState> {
	const existing = await storage.readAuthoredDraft(document.id);
	if (existing !== null) return loadEditableSetList(storage, document);
	const revision = executeSetListCommand(null, command === "create" ? { kind: "create-set-list", document } : { kind: "duplicate-set-list", sourceDocumentId: command.sourceDocumentId as SetList["id"], document }, {
		revisionId: randomStableId("revision"), operationId: randomStableId("operation"),
	});
	const sync = await storage.readAuthoredSyncState();
	await persist(storage, revision, sync?.documents.find((item) => item.documentId === document.id)?.currentServerRevisionId ?? "");
	return loadEditableSetList(storage, document);
}

export async function commitSetListCommand(storage: SongsStorage, state: EditableSetListState, command: SetListCommand): Promise<EditableSetListState> {
  const base = await ensureRevision(storage, state);
  const revision = executeSetListCommand(base, command, { revisionId: randomStableId("revision"), operationId: randomStableId("operation") });
  await persist(storage, revision, state.baseServerRevisionId);
  return loadEditableSetList(storage, revision.document);
}

export async function undoEditableSetList(storage: SongsStorage, state: EditableSetListState): Promise<EditableSetListState> {
  const base = await ensureRevision(storage, state);
  const revision = undoSetListRevision(base, { revisionId: randomStableId("revision"), operationId: randomStableId("operation") });
  await persist(storage, revision, state.baseServerRevisionId);
  return loadEditableSetList(storage, revision.document);
}
