import type { LeadSheetDocument } from "../bootstrap/types";
import type { SongsStorage } from "../storage";
import {
  buildAuthoredMutation,
  buildLeadSheetValidationReceipt,
  buildLeadSheetWorkspaceRecord,
  isLeadSheetAuthoredLocalRevision,
  type AuthoredLeadSheetLocalRevisionRecord,
  type AuthoredLeadSheetServerRevisionRecord,
  type LeadSheetValidationResponse,
} from "../storage/authored";
import { sha256Hex } from "../setlists/codec";
import { randomStableId } from "../setlists/model";
import { executeLeadSheetCommand, undoLeadSheetRevision, type LeadSheetRevision } from "./commands";
import { readLeadSheetMetadata, validateLeadSheetLocally, type LocalLeadSheetValidation } from "./codec";
import { createLeadSheet, type LeadSheet } from "./model";

const DEVICE_KEY = "songs-v2-device-id";
function browserDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_KEY);
  if (existing !== null) return existing;
  const created = randomStableId("set").replace(/^set-/, "browser-");
  localStorage.setItem(DEVICE_KEY, created);
  return created;
}

export function leadSheetFromBootstrap(document: LeadSheetDocument): LeadSheet {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(document.source.content_base64), (character) => character.charCodeAt(0)));
  return createLeadSheet({ id: document.id, path: document.path, source });
}

function asRevision(record: AuthoredLeadSheetLocalRevisionRecord): LeadSheetRevision {
  return Object.freeze({
    schemaVersion: "songs-v2-lead-sheet-revision-1", id: record.id as LeadSheetRevision["id"], documentId: record.documentId as LeadSheetRevision["documentId"],
    parentRevisionId: record.parentRevisionId as LeadSheetRevision["parentRevisionId"], operationId: record.operationId as LeadSheetRevision["operationId"],
    operationKind: record.operationKind, command: record.command, inverse: record.inverse, document: record.document,
  });
}

export interface EditableLeadSheetState {
  readonly documentId: string; readonly path: string; readonly source: string; readonly workspaceSourceSha256: string | null;
  readonly revision: LeadSheetRevision | null; readonly baseline: LeadSheet; readonly validation: LocalLeadSheetValidation;
  readonly queued: number; readonly baseServerRevisionId: string; readonly publishedRevisionId: string; readonly conflicts: number;
  readonly serverValidation: LeadSheetValidationResponse | null;
}

function matchingServerBaseline(
  revisions: readonly Awaited<ReturnType<SongsStorage["listAuthoredRevisions"]>>[number][],
  currentRevisionId: string | undefined,
  baseline: LeadSheet,
): AuthoredLeadSheetServerRevisionRecord | undefined {
  const servers = new Map(revisions.filter((record): record is AuthoredLeadSheetServerRevisionRecord => record.origin === "server" && record.payload.kind === "lead-sheet").map((record) => [record.id, record]));
  const visited = new Set<string>();
  let id = currentRevisionId ?? "";
  while (id !== "" && !visited.has(id)) {
    visited.add(id);
    const revision = servers.get(id);
    if (revision === undefined) break;
    if (revision.payload.path === baseline.path && revision.payload.source === baseline.source) return revision;
    id = revision.baseRevisionId;
  }
  return undefined;
}

export async function loadEditableLeadSheet(storage: SongsStorage, baseline: LeadSheet): Promise<EditableLeadSheetState> {
  const [workspace, draft, outbox, sync, authored] = await Promise.all([
    storage.readLeadSheetWorkspace(baseline.id), storage.readLeadSheetDraft(baseline.id), storage.listLeadSheetOutbox(), storage.readAuthoredSyncState(), storage.readAuthoredState(),
  ]);
  const revisions = await storage.listAuthoredRevisions(baseline.id);
  const head = draft === null ? undefined : revisions.find((record): record is AuthoredLeadSheetLocalRevisionRecord => record.origin === "local" && record.id === draft.localRevisionId && isLeadSheetAuthoredLocalRevision(record));
  if (draft !== null && head === undefined) throw new Error("The durable lead-sheet draft head is missing");
  const documentSync = sync?.documents.find((item) => item.documentId === baseline.id);
  const serverHead = revisions.find((record) => record.origin === "server" && record.id === documentSync?.currentServerRevisionId && record.payload.kind === "lead-sheet");
  const serverBaseline = matchingServerBaseline(revisions, documentSync?.currentServerRevisionId, baseline);
  const effectiveBaseline = draft === null && workspace === null && serverHead !== undefined && serverHead.origin === "server"
    ? createLeadSheet({ id: baseline.id, path: serverHead.payload.path, source: serverHead.payload.source })
    : baseline;
  const source = workspace?.source ?? draft?.source ?? effectiveBaseline.source;
  let validation: LocalLeadSheetValidation;
  try { validation = validateLeadSheetLocally(createLeadSheet({ id: baseline.id, path: baseline.path, source })); }
  catch (error) { validation = Object.freeze({ authority: "local-only", valid: false, requiresServerValidation: true, requiresApexValidation: true, issues: Object.freeze([{ severity: "error" as const, code: "INVALID_SOURCE", message: error instanceof Error ? error.message : "Lead-sheet source is invalid" }]) }); }
  const sourceSha = await sha256Hex(source);
  const receipt = await storage.readLeadSheetValidationReceipt(baseline.id, sourceSha);
  const baseServerRevisionId = workspace !== null ? workspace.baseServerRevisionId ?? serverBaseline?.id ?? "" : draft?.baseServerRevisionId ?? documentSync?.currentServerRevisionId ?? "";
  return Object.freeze({
    documentId: baseline.id, path: effectiveBaseline.path, source, workspaceSourceSha256: workspace?.sourceSha256 ?? null,
    revision: head === undefined ? null : asRevision(head), baseline: effectiveBaseline, validation,
    queued: outbox.filter((item) => item.documentId === baseline.id).length,
    baseServerRevisionId,
    publishedRevisionId: documentSync?.publishedRevisionId ?? "",
    conflicts: authored.conflicts.filter((item) => item.documentId === baseline.id && item.status === "open").length,
    serverValidation: receipt?.response ?? null,
  });
}

export async function saveLeadSheetWorkspace(storage: SongsStorage, state: EditableLeadSheetState, source: string): Promise<EditableLeadSheetState> {
  const workspace = await buildLeadSheetWorkspaceRecord({ id: state.documentId, path: state.path, source }, { updatedAt: new Date().toISOString(), baseServerRevisionId: state.baseServerRevisionId });
  await storage.saveLeadSheetWorkspace(workspace, { expectedSourceSha256: state.workspaceSourceSha256 });
  return loadEditableLeadSheet(storage, state.baseline);
}

async function persistRevision(storage: SongsStorage, revision: LeadSheetRevision, baseServerRevisionId: string): Promise<void> {
  const sync = await storage.readAuthoredSyncState();
  const mutation = await buildAuthoredMutation(revision, { deviceId: sync?.deviceId ?? browserDeviceId(), baseServerRevisionId, clientCursor: sync?.cursor ?? 0, createdAt: new Date().toISOString() });
  await storage.commitAuthoredMutation(mutation, { expectedLocalRevisionId: revision.parentRevisionId });
}

export async function promoteLeadSheetWorkspace(storage: SongsStorage, state: EditableLeadSheetState): Promise<EditableLeadSheetState> {
  const document = createLeadSheet({ id: state.documentId, path: state.path, source: state.source });
  const validation = validateLeadSheetLocally(document);
  if (!validation.valid) throw new Error("Local validation errors prevent this workspace from entering sync");
  let base = state.revision;
  if (base === null) {
    base = executeLeadSheetCommand(null, { kind: "create-lead-sheet", document: state.baseline }, { revisionId: randomStableId("revision"), operationId: randomStableId("operation") });
    await persistRevision(storage, base, state.baseServerRevisionId);
    if (state.baseline.source === document.source) return loadEditableLeadSheet(storage, state.baseline);
  }
  const revision = executeLeadSheetCommand(base, { kind: "replace-source", source: document.source }, { revisionId: randomStableId("revision"), operationId: randomStableId("operation") });
  await persistRevision(storage, revision, state.baseServerRevisionId);
  return loadEditableLeadSheet(storage, state.baseline);
}

export async function initializeNewLeadSheet(storage: SongsStorage, document: LeadSheet): Promise<EditableLeadSheetState> {
  const existing = await storage.readLeadSheetWorkspace(document.id);
  if (existing === null) {
    const workspace = await buildLeadSheetWorkspaceRecord({ id: document.id, path: document.path, source: document.source }, { updatedAt: new Date().toISOString() });
    await storage.saveLeadSheetWorkspace(workspace, { expectedSourceSha256: null });
  }
  return loadEditableLeadSheet(storage, document);
}

export async function undoEditableLeadSheet(storage: SongsStorage, state: EditableLeadSheetState): Promise<EditableLeadSheetState> {
  if (state.revision === null) throw new Error("No committed lead-sheet revision is available to undo");
  const revision = undoLeadSheetRevision(state.revision, { revisionId: randomStableId("revision"), operationId: randomStableId("operation") });
  await persistRevision(storage, revision, state.baseServerRevisionId);
  const loaded = await loadEditableLeadSheet(storage, state.baseline);
  if (loaded.source !== revision.document.source) return saveLeadSheetWorkspace(storage, loaded, revision.document.source);
  return loaded;
}

export async function persistServerValidation(storage: SongsStorage, state: EditableLeadSheetState, response: LeadSheetValidationResponse): Promise<EditableLeadSheetState> {
  const receipt = await buildLeadSheetValidationReceipt(response, { source: state.source, receivedAt: new Date().toISOString() });
  if (state.workspaceSourceSha256 === null) await storage.saveLeadSheetValidationReceipt(receipt);
  else await storage.saveLeadSheetValidationReceipt(receipt, { expectedWorkspaceSourceSha256: state.workspaceSourceSha256 });
  return loadEditableLeadSheet(storage, state.baseline);
}

export function leadSheetMetadata(state: EditableLeadSheetState) { return readLeadSheetMetadata(state.source); }
