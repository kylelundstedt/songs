import {
  buildLeadSheetPublicationPayload,
  validateLeadSheetLocally,
  type LeadSheetPublicationPayload,
} from "../leadsheets/codec";
import {
  LEAD_SHEET_REVISION_SCHEMA_VERSION,
  executeLeadSheetCommand,
  validateLeadSheetCommand,
  type LeadSheetCommand,
  type LeadSheetRevision,
} from "../leadsheets/commands";
import {
  LEAD_SHEET_SCHEMA_VERSION,
  MAX_LEAD_SHEET_SOURCE_BYTES,
  requireLeadSheetPath,
  validateLeadSheet,
  type LeadSheet,
} from "../leadsheets/model";
import {
  buildSetListPublicationPayload,
  canonicalJson,
  decodeCanonicalSetListSource,
  encodeCanonicalSetListSource,
  sha256Hex,
  type SetListPublicationPayload,
} from "../setlists/codec";
import {
  SET_LIST_REVISION_SCHEMA_VERSION,
  executeSetListCommand,
  setListOperationKind,
  validateSetListCommand,
  type SetListRevision,
} from "../setlists/commands";
import {
  SET_LIST_SCHEMA_VERSION,
  type SetList,
  isStableId,
  validateSetList,
} from "../setlists/model";

export const AUTHORED_DRAFT_SCHEMA_VERSION = "songs-v2-authored-draft-1" as const;
export const AUTHORED_REVISION_SCHEMA_VERSION = "songs-v2-authored-revision-1" as const;
export const AUTHORED_OUTBOX_SCHEMA_VERSION = "songs-v2-authored-outbox-1" as const;
export const AUTHORED_CONFLICT_SCHEMA_VERSION = "songs-v2-authored-conflict-1" as const;
export const AUTHORED_SYNC_SCHEMA_VERSION = "songs-v2-authored-sync-1" as const;
export const AUTHORED_EXPORT_SCHEMA_VERSION = "songs-v2-authored-export-1" as const;
export const LEAD_SHEET_WORKSPACE_SCHEMA_VERSION = "songs-v2-lead-sheet-workspace-1" as const;
export const LEAD_SHEET_VALIDATION_RECEIPT_SCHEMA_VERSION = "songs-v2-lead-sheet-validation-receipt-1" as const;
export const AUTHORED_SYNC_STATE_ID = "primary" as const;

export type OutboxState = "pending" | "sending" | "failed";
export type AuthoredConflictStatus = "open" | "resolved";
export type AuthoredDocumentKind = "set-list" | "lead-sheet";
export type AuthoredDocument = SetList | LeadSheet;
export type AuthoredPublicationPayload = SetListPublicationPayload | LeadSheetPublicationPayload;

type AuthoredKindFor<Document extends AuthoredDocument> = Document extends LeadSheet ? "lead-sheet" : "set-list";
type AuthoredRevision = SetListRevision | LeadSheetRevision;
type AuthoredPayloadFor<Revision extends AuthoredRevision> = Revision extends LeadSheetRevision ? LeadSheetPublicationPayload : SetListPublicationPayload;

/** Defaults preserve TASK-019's Set List source-level API. */
export interface AuthoredDraftRecord<Document extends AuthoredDocument = SetList> {
  readonly id: string;
  readonly schemaVersion: typeof AUTHORED_DRAFT_SCHEMA_VERSION;
  readonly kind: AuthoredKindFor<Document>;
  readonly documentId: string;
  readonly localRevisionId: string;
  readonly baseServerRevisionId: string;
  readonly document: Document;
  readonly source: string;
  readonly sourceSha256: string;
  readonly updatedAt: string;
}

export type AuthoredLeadSheetDraftRecord = AuthoredDraftRecord<LeadSheet>;
export type AnyAuthoredDraftRecord = AuthoredDraftRecord | AuthoredLeadSheetDraftRecord;

/** Defaults preserve TASK-019's Set List source-level API. */
export interface AuthoredLocalRevisionRecord<Revision extends AuthoredRevision = SetListRevision> {
  readonly id: string;
  readonly schemaVersion: typeof AUTHORED_REVISION_SCHEMA_VERSION;
  readonly origin: "local";
  readonly documentId: string;
  readonly parentRevisionId: string | null;
  readonly deviceId: string;
  readonly operationId: string;
  readonly operationKind: string;
  readonly command: Revision["command"];
  readonly inverse: Revision["inverse"];
  readonly document: Revision["document"];
  readonly source: string;
  readonly sourceSha256: string;
  readonly createdAt: string;
}

export type AuthoredLeadSheetLocalRevisionRecord = AuthoredLocalRevisionRecord<LeadSheetRevision>;
export type AnyAuthoredLocalRevisionRecord = AuthoredLocalRevisionRecord | AuthoredLeadSheetLocalRevisionRecord;

/** Defaults preserve TASK-019's Set List source-level API. */
export interface AuthoredServerRevisionRecord<Payload extends AuthoredPublicationPayload = SetListPublicationPayload> {
  readonly id: string;
  readonly schemaVersion: typeof AUTHORED_REVISION_SCHEMA_VERSION;
  readonly origin: "server";
  readonly documentId: string;
  readonly deviceId: string;
  readonly operationId: string;
  readonly baseRevisionId: string;
  readonly title: string;
  readonly payload: Payload;
  readonly contentHash: string;
  readonly receivedAt: string;
}

export type AuthoredLeadSheetServerRevisionRecord = AuthoredServerRevisionRecord<LeadSheetPublicationPayload>;
export type AnyAuthoredServerRevisionRecord = AuthoredServerRevisionRecord | AuthoredLeadSheetServerRevisionRecord;
export type AuthoredRevisionRecord = AnyAuthoredLocalRevisionRecord | AnyAuthoredServerRevisionRecord;

/** Defaults preserve TASK-019's Set List source-level API. */
export interface AuthoredApplyEnvelope<Payload extends AuthoredPublicationPayload = SetListPublicationPayload> {
  readonly protocol_version: "1";
  readonly device_id: string;
  readonly operation_id: string;
  readonly operation_kind: string;
  readonly document_id: string;
  readonly base_revision_id: string;
  readonly title: string;
  readonly payload: Payload;
  readonly payload_sha256: string;
  readonly client_cursor: number;
}

export type AuthoredLeadSheetApplyEnvelope = AuthoredApplyEnvelope<LeadSheetPublicationPayload>;
export type AnyAuthoredApplyEnvelope = AuthoredApplyEnvelope | AuthoredLeadSheetApplyEnvelope;

/** Defaults preserve TASK-019's Set List source-level API. */
export interface AuthoredOutboxRecord<Payload extends AuthoredPublicationPayload = SetListPublicationPayload> {
  readonly id: string;
  readonly schemaVersion: typeof AUTHORED_OUTBOX_SCHEMA_VERSION;
  readonly documentId: string;
  readonly localRevisionId: string;
  readonly state: OutboxState;
  readonly envelope: AuthoredApplyEnvelope<Payload>;
  readonly canonicalPayload: string;
  readonly attempts: number;
  readonly lastAttemptAt?: string;
  readonly lastError?: string;
  readonly createdAt: string;
}

export type AuthoredLeadSheetOutboxRecord = AuthoredOutboxRecord<LeadSheetPublicationPayload>;
export type AnyAuthoredOutboxRecord = AuthoredOutboxRecord | AuthoredLeadSheetOutboxRecord;

export interface AuthoredConflictRecord {
  readonly id: string;
  readonly schemaVersion: typeof AUTHORED_CONFLICT_SCHEMA_VERSION;
  readonly documentId: string;
  readonly currentRevisionId: string;
  readonly candidateRevisionId: string;
  readonly resolutionRevisionId: string;
  readonly status: AuthoredConflictStatus;
  readonly updatedAt: string;
}

export interface AuthoredDocumentSyncState {
  readonly documentId: string;
  readonly currentServerRevisionId: string;
  readonly publishedRevisionId: string;
}

export interface AuthoredSyncStateRecord {
  readonly id: typeof AUTHORED_SYNC_STATE_ID;
  readonly schemaVersion: typeof AUTHORED_SYNC_SCHEMA_VERSION;
  readonly deviceId: string;
  readonly cursor: number;
  readonly acknowledgedCursor: number;
  readonly documents: readonly AuthoredDocumentSyncState[];
  readonly updatedAt: string;
}

export interface AuthoredMutation<Revision extends AuthoredRevision = SetListRevision> {
  readonly draft: AuthoredDraftRecord<Revision["document"]>;
  readonly revision: AuthoredLocalRevisionRecord<Revision>;
  readonly outbox: AuthoredOutboxRecord<AuthoredPayloadFor<Revision>>;
}

export type AuthoredLeadSheetMutation = AuthoredMutation<LeadSheetRevision>;
export type AnyAuthoredMutation = AuthoredMutation | AuthoredLeadSheetMutation;

export interface StoredAuthoredState {
  readonly drafts: readonly AnyAuthoredDraftRecord[];
  readonly revisions: readonly AuthoredRevisionRecord[];
  readonly outbox: readonly AnyAuthoredOutboxRecord[];
  readonly conflicts: readonly AuthoredConflictRecord[];
  readonly sync: AuthoredSyncStateRecord | null;
}

/** Volatile editor source kept separately from a validated authored draft/outbox. */
export interface LeadSheetWorkspaceRecord {
  readonly id: string;
  readonly schemaVersion: typeof LEAD_SHEET_WORKSPACE_SCHEMA_VERSION;
  readonly kind: "lead-sheet-workspace";
  readonly documentId: string;
  readonly path: string;
  readonly source: string;
  readonly sourceSha256: string;
  readonly updatedAt: string;
}

export interface BuildLeadSheetWorkspaceOptions {
  readonly updatedAt: string;
}

export interface LeadSheetValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly line?: number;
}

export interface LeadSheetValidationResponse {
  readonly schema_version: "1";
  readonly authority: "server-apex";
  readonly document_id: string;
  readonly path: string;
  readonly title: string;
  readonly source_sha256: string;
  readonly valid: boolean;
  readonly html?: string;
  readonly issues: readonly LeadSheetValidationIssue[];
}

/** Immutable hash-addressed evidence for one exact server/Apex validation. */
export interface LeadSheetValidationReceiptRecord {
  readonly id: string;
  readonly schemaVersion: typeof LEAD_SHEET_VALIDATION_RECEIPT_SCHEMA_VERSION;
  readonly kind: "lead-sheet-validation-receipt";
  readonly documentId: string;
  readonly sourceSha256: string;
  readonly response: LeadSheetValidationResponse;
  readonly receivedAt: string;
}

export interface BuildLeadSheetValidationReceiptOptions {
  readonly source: string;
  readonly receivedAt: string;
}

export interface OpaqueStructuredClone {
  readonly tag: string;
  readonly value?: string | boolean;
  readonly entries?: readonly (readonly [string | OpaqueStructuredClone, OpaqueStructuredClone])[];
  readonly items?: readonly OpaqueStructuredClone[];
  readonly name?: string;
}

export interface OpaquePendingRecord {
  readonly store: "drafts" | "outbox" | "conflicts";
  readonly key: OpaqueStructuredClone;
  readonly value: OpaqueStructuredClone;
}

export interface AuthoredStateExportBody {
  readonly schemaVersion: typeof AUTHORED_EXPORT_SCHEMA_VERSION;
  readonly database: "songs-v2";
  readonly storageVersion: 3;
  readonly exportedAt: string;
  readonly records: StoredAuthoredState;
  readonly legacy: readonly OpaquePendingRecord[];
}

export interface AuthoredStateExport extends AuthoredStateExportBody {
  readonly sha256: string;
}

export interface BuildAuthoredMutationOptions {
  readonly deviceId: string;
  readonly baseServerRevisionId: string;
  readonly clientCursor: number;
  readonly createdAt: string;
}

/** IndexedDB identity mirrors the server's `(device ID, operation ID)` key. */
export function authoredOutboxId(deviceId: string, operationId: string): string {
  return `${deviceId}:${operationId}`;
}

export function leadSheetWorkspaceId(documentId: string): string {
  return `workspace:${documentId}`;
}

export function leadSheetValidationReceiptId(documentId: string, sourceSha256: string): string {
  return `validation:${documentId}:${sourceSha256}`;
}

function authoredError(message: string, detail?: unknown): Error {
  return Object.assign(new Error(message), { name: "AuthoredDataError", detail });
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw authoredError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw authoredError(`${label} has unknown or missing fields`, { actual, expected });
  }
}

function requireString(value: unknown, label: string, options: { readonly empty?: boolean; readonly maximum?: number } = {}): string {
  const maximum = options.maximum ?? 4096;
  if (typeof value !== "string" || value.length > maximum || value.includes("\0") || (!options.empty && value === "")) throw authoredError(`${label} is invalid`);
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (new Date(text).toISOString() !== text) throw authoredError(`${label} must be an exact ISO-8601 timestamp`, { value });
  return text;
}

function requireCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw authoredError(`${label} must be a non-negative safe integer`);
  return value as number;
}

function requireSha256(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (!/^[a-f0-9]{64}$/.test(text)) throw authoredError(`${label} must be a lowercase SHA-256`);
  return text;
}

function requireRevisionId(value: unknown, label: string, options: { readonly empty?: boolean } = {}): string {
  const text = requireString(value, label, { ...(options.empty === undefined ? {} : { empty: options.empty }), maximum: 63 });
  if (text !== "" && !/^rev-[a-f0-9]{24}$/.test(text)) throw authoredError(`${label} must be a server revision ID`);
  return text;
}

function requireStable(value: unknown, label: string): string {
  const text = requireString(value, label, { maximum: 63 });
  if (!isStableId(text)) throw authoredError(`${label} must be a stable ID`, { value });
  return text;
}

function requireSingleLine(value: unknown, label: string, maximum: number): string {
  const text = requireString(value, label, { maximum });
  if (text.trim() !== text || /[\r\n]/u.test(text)) throw authoredError(`${label} must be bounded single-line text`);
  return text;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/** Workspace text may be structurally invalid or empty, but remains exact safe UTF-8/LF source. */
function requireWorkspaceSource(value: unknown): string {
  if (
    typeof value !== "string" || value.includes("\0") || value.includes("\r") || hasUnpairedSurrogate(value)
    || new TextEncoder().encode(value).byteLength > MAX_LEAD_SHEET_SOURCE_BYTES
  ) throw authoredError("Lead-sheet workspace source is invalid");
  return value;
}

function publicationPayloadKind(payload: AuthoredPublicationPayload): AuthoredDocumentKind {
  return payload.kind;
}

function documentKind(document: AuthoredDocument): AuthoredDocumentKind {
  return document.schemaVersion === LEAD_SHEET_SCHEMA_VERSION ? "lead-sheet" : "set-list";
}

function leadSheetOperationKind(command: LeadSheetCommand): string {
  if (command.kind === "restore-snapshot") return command.undoOfRevisionId === undefined ? "restore-lead-sheet" : "undo-lead-sheet";
  return command.kind;
}

function parsePublicationPayload(value: unknown): AuthoredPublicationPayload {
  const object = requireObject(value, "publication payload");
  requireExactKeys(object, ["schema_version", "kind", "path", "source", "deleted"], "publication payload");
  if (object.schema_version !== "v2publish-1" || object.deleted !== false || typeof object.path !== "string" || typeof object.source !== "string") {
    throw authoredError("publication payload is invalid");
  }
  if (object.kind === "set-list") {
    const decoded = decodeCanonicalSetListSource(object.source, object.path);
    const rebuilt = buildSetListPublicationPayload(decoded);
    if (canonicalJson(rebuilt) !== canonicalJson(object)) throw authoredError("publication payload is not canonical");
    return rebuilt;
  }
  if (object.kind === "lead-sheet") {
    const rebuilt = buildLeadSheetPublicationPayload(validateLeadSheet({ id: "song-payload-validation", path: object.path, source: object.source }));
    if (canonicalJson(rebuilt) !== canonicalJson(object)) throw authoredError("publication payload is not canonical");
    return rebuilt;
  }
  throw authoredError("publication payload is invalid");
}

function parseServerPublicationPayload(value: unknown): AuthoredPublicationPayload {
  const object = requireObject(value, "server publication payload");
  requireExactKeys(object, ["schema_version", "kind", "path", "source", "deleted"], "server publication payload");
  if (
    object.schema_version !== "v2publish-1" || object.deleted !== false || typeof object.source !== "string"
    || object.source.length === 0 || object.source.length > 1 << 20 || object.source.includes("\0")
  ) throw authoredError("Server publication payload is invalid");
  if (object.kind === "set-list" && typeof object.path === "string" && /^sets\/[A-Za-z0-9][A-Za-z0-9'_\-]*\.md$/.test(object.path)) {
    return Object.freeze({ schema_version: "v2publish-1", kind: "set-list", path: object.path, source: object.source, deleted: false });
  }
  if (object.kind === "lead-sheet" && typeof object.path === "string") {
    const path = requireLeadSheetPath(object.path);
    const source = validateLeadSheet({ id: "song-server-payload", path, source: object.source }).source;
    return Object.freeze({ schema_version: "v2publish-1", kind: "lead-sheet", path, source, deleted: false });
  }
  throw authoredError("Server publication payload is invalid");
}

function setListFromUnknown(value: unknown): SetList {
  const object = requireObject(value, "Set List");
  if (object.schemaVersion !== SET_LIST_SCHEMA_VERSION) throw authoredError("Set List schema version is invalid");
  return validateSetList(object as unknown as SetList);
}

function leadSheetFromUnknown(value: unknown): LeadSheet {
  const object = requireObject(value, "lead sheet");
  if (object.schemaVersion !== LEAD_SHEET_SCHEMA_VERSION) throw authoredError("Lead-sheet schema version is invalid");
  return validateLeadSheet(object as unknown as LeadSheet);
}

function documentFromUnknown(value: unknown): AuthoredDocument {
  const object = requireObject(value, "authored document");
  if (object.schemaVersion === SET_LIST_SCHEMA_VERSION) return setListFromUnknown(value);
  if (object.schemaVersion === LEAD_SHEET_SCHEMA_VERSION) return leadSheetFromUnknown(value);
  throw authoredError("Authored document schema version is invalid");
}

function authoredDocumentTitle(document: AuthoredDocument): string {
  if (document.schemaVersion === SET_LIST_SCHEMA_VERSION) return document.title;
  const validation = validateLeadSheetLocally(document);
  if (!validation.valid || validation.title === undefined) throw authoredError("Lead-sheet source must pass local validation before entering the authored outbox", { issues: validation.issues });
  return requireSingleLine(validation.title, "lead-sheet title", 512);
}

async function verifyDocumentSource(document: AuthoredDocument, source: string, sourceHash: string): Promise<void> {
  if (document.schemaVersion === SET_LIST_SCHEMA_VERSION) {
    if (encodeCanonicalSetListSource(document) !== source) throw authoredError("Stored canonical source does not match its Set List");
    if (await sha256Hex(source) !== sourceHash) throw authoredError("Stored canonical source hash does not match");
    const decoded = decodeCanonicalSetListSource(source, document.path);
    if (canonicalJson(decoded) !== canonicalJson(document)) throw authoredError("Stored canonical source does not decode to its Set List");
    return;
  }
  if (document.source !== source) throw authoredError("Stored exact source does not match its lead sheet");
  if (await sha256Hex(source) !== sourceHash) throw authoredError("Stored exact source hash does not match");
}

export async function buildLeadSheetWorkspaceRecord(
  input: { readonly id: string; readonly path: string; readonly source: string },
  options: BuildLeadSheetWorkspaceOptions,
): Promise<LeadSheetWorkspaceRecord> {
  const documentId = requireStable(input.id, "workspace document ID");
  const path = requireLeadSheetPath(input.path);
  const source = requireWorkspaceSource(input.source);
  const updatedAt = requireTimestamp(options.updatedAt, "workspace updatedAt");
  return Object.freeze({
    id: leadSheetWorkspaceId(documentId), schemaVersion: LEAD_SHEET_WORKSPACE_SCHEMA_VERSION, kind: "lead-sheet-workspace",
    documentId, path, source, sourceSha256: await sha256Hex(source), updatedAt,
  });
}

export async function validateLeadSheetWorkspaceRecord(value: unknown): Promise<LeadSheetWorkspaceRecord> {
  const object = requireObject(value, "lead-sheet workspace");
  requireExactKeys(object, ["id", "schemaVersion", "kind", "documentId", "path", "source", "sourceSha256", "updatedAt"], "lead-sheet workspace");
  if (object.schemaVersion !== LEAD_SHEET_WORKSPACE_SCHEMA_VERSION || object.kind !== "lead-sheet-workspace") throw authoredError("Lead-sheet workspace schema is invalid");
  const documentId = requireStable(object.documentId, "workspace document ID");
  const source = requireWorkspaceSource(object.source);
  const record: LeadSheetWorkspaceRecord = {
    id: requireString(object.id, "workspace ID", { maximum: 80 }), schemaVersion: LEAD_SHEET_WORKSPACE_SCHEMA_VERSION, kind: "lead-sheet-workspace",
    documentId, path: requireLeadSheetPath(requireString(object.path, "workspace path", { maximum: 240 })), source,
    sourceSha256: requireSha256(object.sourceSha256, "workspace source hash"), updatedAt: requireTimestamp(object.updatedAt, "workspace updatedAt"),
  };
  if (record.id !== leadSheetWorkspaceId(documentId)) throw authoredError("Lead-sheet workspace identity does not agree");
  if (await sha256Hex(source) !== record.sourceSha256) throw authoredError("Lead-sheet workspace source hash does not match");
  return Object.freeze(record);
}

function parseValidationIssue(value: unknown): LeadSheetValidationIssue {
  const object = requireObject(value, "lead-sheet validation issue");
  const keys = ["code", "message"];
  if (object.line !== undefined) keys.push("line");
  requireExactKeys(object, keys, "lead-sheet validation issue");
  return Object.freeze({
    code: requireString(object.code, "validation issue code", { maximum: 128 }),
    message: requireString(object.message, "validation issue message", { maximum: 4096 }),
    ...(object.line === undefined ? {} : { line: requireCount(object.line, "validation issue line") }),
  });
}

export function validateLeadSheetValidationResponse(value: unknown): LeadSheetValidationResponse {
  const object = requireObject(value, "lead-sheet validation response");
  const keys = ["schema_version", "authority", "document_id", "path", "title", "source_sha256", "valid", "issues"];
  if (object.html !== undefined) keys.push("html");
  requireExactKeys(object, keys, "lead-sheet validation response");
  if (object.schema_version !== "1" || object.authority !== "server-apex" || typeof object.valid !== "boolean" || !Array.isArray(object.issues)) {
    throw authoredError("Lead-sheet validation response schema is invalid");
  }
  const response: LeadSheetValidationResponse = {
    schema_version: "1", authority: "server-apex", document_id: requireStable(object.document_id, "validation document ID"),
    path: requireLeadSheetPath(requireString(object.path, "validation path", { maximum: 240 })), title: requireSingleLine(object.title, "validation title", 512),
    source_sha256: requireSha256(object.source_sha256, "validation source hash"), valid: object.valid,
    ...(object.html === undefined ? {} : { html: requireString(object.html, "validation HTML", { maximum: 4 << 20 }) }),
    issues: Object.freeze(object.issues.map(parseValidationIssue)),
  };
  if (response.valid && response.html === undefined) throw authoredError("A valid lead-sheet validation response must include rendered HTML");
  if (!response.valid && response.html !== undefined) throw authoredError("An invalid lead-sheet validation response cannot include rendered HTML");
  return Object.freeze(response);
}

export async function buildLeadSheetValidationReceipt(
  responseValue: unknown,
  options: BuildLeadSheetValidationReceiptOptions,
): Promise<LeadSheetValidationReceiptRecord> {
  const response = validateLeadSheetValidationResponse(responseValue);
  const source = requireWorkspaceSource(options.source);
  if (await sha256Hex(source) !== response.source_sha256) throw authoredError("Validation response does not belong to the supplied exact source");
  return Object.freeze({
    id: leadSheetValidationReceiptId(response.document_id, response.source_sha256),
    schemaVersion: LEAD_SHEET_VALIDATION_RECEIPT_SCHEMA_VERSION, kind: "lead-sheet-validation-receipt",
    documentId: response.document_id, sourceSha256: response.source_sha256, response,
    receivedAt: requireTimestamp(options.receivedAt, "validation receipt receivedAt"),
  });
}

export function validateLeadSheetValidationReceiptRecord(value: unknown): LeadSheetValidationReceiptRecord {
  const object = requireObject(value, "lead-sheet validation receipt");
  requireExactKeys(object, ["id", "schemaVersion", "kind", "documentId", "sourceSha256", "response", "receivedAt"], "lead-sheet validation receipt");
  if (object.schemaVersion !== LEAD_SHEET_VALIDATION_RECEIPT_SCHEMA_VERSION || object.kind !== "lead-sheet-validation-receipt") throw authoredError("Lead-sheet validation receipt schema is invalid");
  const response = validateLeadSheetValidationResponse(object.response);
  const record: LeadSheetValidationReceiptRecord = {
    id: requireString(object.id, "validation receipt ID", { maximum: 160 }), schemaVersion: LEAD_SHEET_VALIDATION_RECEIPT_SCHEMA_VERSION,
    kind: "lead-sheet-validation-receipt", documentId: requireStable(object.documentId, "validation receipt document ID"),
    sourceSha256: requireSha256(object.sourceSha256, "validation receipt source hash"), response,
    receivedAt: requireTimestamp(object.receivedAt, "validation receipt receivedAt"),
  };
  if (
    record.id !== leadSheetValidationReceiptId(record.documentId, record.sourceSha256)
    || record.documentId !== response.document_id || record.sourceSha256 !== response.source_sha256
  ) throw authoredError("Lead-sheet validation receipt identity does not agree with its response");
  return Object.freeze(record);
}

export function isSetListAuthoredDraft(record: AnyAuthoredDraftRecord): record is AuthoredDraftRecord {
  return record.kind === "set-list";
}

export function isLeadSheetAuthoredDraft(record: AnyAuthoredDraftRecord): record is AuthoredLeadSheetDraftRecord {
  return record.kind === "lead-sheet";
}

export function isSetListAuthoredLocalRevision(record: AnyAuthoredLocalRevisionRecord): record is AuthoredLocalRevisionRecord {
  return record.document.schemaVersion === SET_LIST_SCHEMA_VERSION;
}

export function isLeadSheetAuthoredLocalRevision(record: AnyAuthoredLocalRevisionRecord): record is AuthoredLeadSheetLocalRevisionRecord {
  return record.document.schemaVersion === LEAD_SHEET_SCHEMA_VERSION;
}

export async function buildAuthoredMutation(revision: SetListRevision, options: BuildAuthoredMutationOptions): Promise<AuthoredMutation>;
export async function buildAuthoredMutation(revision: LeadSheetRevision, options: BuildAuthoredMutationOptions): Promise<AuthoredLeadSheetMutation>;
export async function buildAuthoredMutation(revision: AuthoredRevision, options: BuildAuthoredMutationOptions): Promise<AnyAuthoredMutation> {
  if (
    revision.schemaVersion !== SET_LIST_REVISION_SCHEMA_VERSION && revision.schemaVersion !== LEAD_SHEET_REVISION_SCHEMA_VERSION
    || revision.documentId !== revision.document.id
  ) throw authoredError("Authored revision is invalid");
  const deviceId = requireStable(options.deviceId, "device ID");
  const baseServerRevisionId = requireRevisionId(options.baseServerRevisionId, "base server revision ID", { empty: true });
  const clientCursor = requireCount(options.clientCursor, "client cursor");
  const createdAt = requireTimestamp(options.createdAt, "createdAt");

  if (revision.schemaVersion === SET_LIST_REVISION_SCHEMA_VERSION) {
    const document = validateSetList(revision.document);
    const payload = buildSetListPublicationPayload(document);
    const canonicalPayload = canonicalJson(payload);
    const [sourceSha256, payloadSha256] = await Promise.all([sha256Hex(payload.source), sha256Hex(canonicalPayload)]);
    const localRevision: AuthoredLocalRevisionRecord = Object.freeze({
      id: revision.id, schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION, origin: "local", documentId: document.id,
      parentRevisionId: revision.parentRevisionId, deviceId, operationId: revision.operationId, operationKind: revision.operationKind,
      command: revision.command, inverse: revision.inverse, document, source: payload.source, sourceSha256, createdAt,
    });
    const draft: AuthoredDraftRecord = Object.freeze({
      id: document.id, schemaVersion: AUTHORED_DRAFT_SCHEMA_VERSION, kind: "set-list", documentId: document.id,
      localRevisionId: revision.id, baseServerRevisionId, document, source: payload.source, sourceSha256, updatedAt: createdAt,
    });
    const envelope: AuthoredApplyEnvelope = Object.freeze({
      protocol_version: "1", device_id: deviceId, operation_id: revision.operationId, operation_kind: revision.operationKind,
      document_id: document.id, base_revision_id: baseServerRevisionId, title: document.title, payload,
      payload_sha256: payloadSha256, client_cursor: clientCursor,
    });
    const outbox: AuthoredOutboxRecord = Object.freeze({
      id: authoredOutboxId(deviceId, revision.operationId), schemaVersion: AUTHORED_OUTBOX_SCHEMA_VERSION,
      documentId: document.id, localRevisionId: revision.id, state: "pending", envelope, canonicalPayload,
      attempts: 0, createdAt,
    });
    return Object.freeze({ draft, revision: localRevision, outbox });
  }

  const document = validateLeadSheet(revision.document);
  const payload = buildLeadSheetPublicationPayload(document);
  const title = authoredDocumentTitle(document);
  const canonicalPayload = canonicalJson(payload);
  const [sourceSha256, payloadSha256] = await Promise.all([sha256Hex(payload.source), sha256Hex(canonicalPayload)]);
  const localRevision: AuthoredLeadSheetLocalRevisionRecord = Object.freeze({
    id: revision.id, schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION, origin: "local", documentId: document.id,
    parentRevisionId: revision.parentRevisionId, deviceId, operationId: revision.operationId, operationKind: revision.operationKind,
    command: revision.command, inverse: revision.inverse, document, source: payload.source, sourceSha256, createdAt,
  });
  const draft: AuthoredLeadSheetDraftRecord = Object.freeze({
    id: document.id, schemaVersion: AUTHORED_DRAFT_SCHEMA_VERSION, kind: "lead-sheet", documentId: document.id,
    localRevisionId: revision.id, baseServerRevisionId, document, source: payload.source, sourceSha256, updatedAt: createdAt,
  });
  const envelope: AuthoredLeadSheetApplyEnvelope = Object.freeze({
    protocol_version: "1", device_id: deviceId, operation_id: revision.operationId, operation_kind: revision.operationKind,
    document_id: document.id, base_revision_id: baseServerRevisionId, title, payload,
    payload_sha256: payloadSha256, client_cursor: clientCursor,
  });
  const outbox: AuthoredLeadSheetOutboxRecord = Object.freeze({
    id: authoredOutboxId(deviceId, revision.operationId), schemaVersion: AUTHORED_OUTBOX_SCHEMA_VERSION,
    documentId: document.id, localRevisionId: revision.id, state: "pending", envelope, canonicalPayload,
    attempts: 0, createdAt,
  });
  return Object.freeze({ draft, revision: localRevision, outbox });
}

export async function validateDraftRecord(value: unknown): Promise<AnyAuthoredDraftRecord> {
  const object = requireObject(value, "authored draft");
  requireExactKeys(object, ["id", "schemaVersion", "kind", "documentId", "localRevisionId", "baseServerRevisionId", "document", "source", "sourceSha256", "updatedAt"], "authored draft");
  if (object.schemaVersion !== AUTHORED_DRAFT_SCHEMA_VERSION || (object.kind !== "set-list" && object.kind !== "lead-sheet")) throw authoredError("Authored draft schema is invalid");
  const document = documentFromUnknown(object.document);
  if (object.kind !== documentKind(document)) throw authoredError("Authored draft kind does not match its document");
  const id = requireStable(object.id, "draft ID");
  const documentId = requireStable(object.documentId, "draft document ID");
  const localRevisionId = requireStable(object.localRevisionId, "draft local revision ID");
  const baseServerRevisionId = requireRevisionId(object.baseServerRevisionId, "draft base server revision ID", { empty: true });
  const source = requireString(object.source, "draft source", { maximum: 1 << 20 });
  const sourceSha256 = requireSha256(object.sourceSha256, "draft source hash");
  const updatedAt = requireTimestamp(object.updatedAt, "draft updatedAt");
  const record: AnyAuthoredDraftRecord = document.schemaVersion === SET_LIST_SCHEMA_VERSION
    ? { id, schemaVersion: AUTHORED_DRAFT_SCHEMA_VERSION, kind: "set-list", documentId, localRevisionId, baseServerRevisionId, document, source, sourceSha256, updatedAt }
    : { id, schemaVersion: AUTHORED_DRAFT_SCHEMA_VERSION, kind: "lead-sheet", documentId, localRevisionId, baseServerRevisionId, document, source, sourceSha256, updatedAt };
  if (record.id !== record.documentId || record.documentId !== document.id) throw authoredError("Authored draft identities do not agree");
  await verifyDocumentSource(document, record.source, record.sourceSha256);
  return Object.freeze(record);
}

export async function validateRevisionRecord(value: unknown): Promise<AuthoredRevisionRecord> {
  const object = requireObject(value, "authored revision");
  if (object.schemaVersion !== AUTHORED_REVISION_SCHEMA_VERSION) throw authoredError("Authored revision schema is invalid");
  if (object.origin === "local") {
    requireExactKeys(object, ["id", "schemaVersion", "origin", "documentId", "parentRevisionId", "deviceId", "operationId", "operationKind", "command", "inverse", "document", "source", "sourceSha256", "createdAt"], "local authored revision");
    const document = documentFromUnknown(object.document);
    const id = requireStable(object.id, "local revision ID");
    const documentId = requireStable(object.documentId, "local revision document ID");
    const parentRevisionId = object.parentRevisionId === null ? null : requireStable(object.parentRevisionId, "parent local revision ID");
    const deviceId = requireStable(object.deviceId, "local revision device ID");
    const operationId = requireStable(object.operationId, "local revision operation ID");
    const source = requireString(object.source, "local revision source", { maximum: 1 << 20 });
    const sourceSha256 = requireSha256(object.sourceSha256, "local revision source hash");
    const createdAt = requireTimestamp(object.createdAt, "local revision createdAt");
    let record: AnyAuthoredLocalRevisionRecord;
    let initial: boolean;
    if (document.schemaVersion === SET_LIST_SCHEMA_VERSION) {
      const command = validateSetListCommand(object.command);
      const inverse = object.inverse === null ? null : validateSetListCommand(object.inverse);
      if (inverse !== null && inverse.kind !== "restore-snapshot") throw authoredError("Local revision inverse must be a restore snapshot");
      const operationKind = requireStable(object.operationKind, "local revision operation kind");
      if (operationKind !== setListOperationKind(command)) throw authoredError("Local revision operation kind does not match its command");
      initial = command.kind === "create-set-list" || command.kind === "duplicate-set-list";
      record = {
        id, schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION, origin: "local", documentId, parentRevisionId,
        deviceId, operationId, operationKind, command, inverse, document, source, sourceSha256, createdAt,
      };
    } else {
      const command = validateLeadSheetCommand(object.command);
      const inverse = object.inverse === null ? null : validateLeadSheetCommand(object.inverse);
      if (inverse !== null && inverse.kind !== "restore-snapshot") throw authoredError("Local revision inverse must be a restore snapshot");
      const operationKind = requireStable(object.operationKind, "local revision operation kind");
      if (operationKind !== leadSheetOperationKind(command)) throw authoredError("Local revision operation kind does not match its command");
      initial = command.kind === "create-lead-sheet";
      record = {
        id, schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION, origin: "local", documentId, parentRevisionId,
        deviceId, operationId, operationKind, command, inverse, document, source, sourceSha256, createdAt,
      };
    }
    if (record.documentId !== document.id) throw authoredError("Local revision document identity does not agree");
    if (initial !== (record.parentRevisionId === null) || initial !== (record.inverse === null)) throw authoredError("Local revision parent/inverse shape does not match its command");
    if (initial && "document" in record.command && canonicalJson(record.command.document) !== canonicalJson(document)) throw authoredError("Initial revision command does not match its document");
    if (record.inverse !== null && record.inverse.document.id !== record.documentId) throw authoredError("Local revision inverse belongs to another authored document");
    await verifyDocumentSource(document, record.source, record.sourceSha256);
    return Object.freeze(record);
  }
  if (object.origin === "server") {
    requireExactKeys(object, ["id", "schemaVersion", "origin", "documentId", "deviceId", "operationId", "baseRevisionId", "title", "payload", "contentHash", "receivedAt"], "server authored revision");
    const payload = parseServerPublicationPayload(object.payload);
    const contentHash = requireSha256(object.contentHash, "server revision content hash");
    if (await sha256Hex(canonicalJson(payload)) !== contentHash) throw authoredError("Server revision content hash does not match its payload");
    const id = requireRevisionId(object.id, "server revision ID");
    const documentId = requireStable(object.documentId, "server revision document ID");
    const deviceId = requireStable(object.deviceId, "server revision device ID");
    const operationId = requireStable(object.operationId, "server revision operation ID");
    const baseRevisionId = requireRevisionId(object.baseRevisionId, "server revision base ID", { empty: true });
    const title = requireSingleLine(object.title, "server revision title", 512);
    const receivedAt = requireTimestamp(object.receivedAt, "server revision receivedAt");
    const record: AuthoredRevisionRecord = payload.kind === "set-list"
      ? { id, schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION, origin: "server", documentId, deviceId, operationId, baseRevisionId, title, payload, contentHash, receivedAt }
      : { id, schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION, origin: "server", documentId, deviceId, operationId, baseRevisionId, title, payload, contentHash, receivedAt };
    return Object.freeze(record);
  }
  throw authoredError("Authored revision origin is invalid");
}

export async function validateOutboxRecord(value: unknown): Promise<AnyAuthoredOutboxRecord> {
  const object = requireObject(value, "authored outbox record");
  const keys = ["id", "schemaVersion", "documentId", "localRevisionId", "state", "envelope", "canonicalPayload", "attempts", "createdAt"];
  if (object.lastAttemptAt !== undefined) keys.push("lastAttemptAt");
  if (object.lastError !== undefined) keys.push("lastError");
  requireExactKeys(object, keys, "authored outbox record");
  if (object.schemaVersion !== AUTHORED_OUTBOX_SCHEMA_VERSION || (object.state !== "pending" && object.state !== "sending" && object.state !== "failed")) throw authoredError("Authored outbox schema or state is invalid");
  const envelopeObject = requireObject(object.envelope, "authored apply envelope");
  requireExactKeys(envelopeObject, ["protocol_version", "device_id", "operation_id", "operation_kind", "document_id", "base_revision_id", "title", "payload", "payload_sha256", "client_cursor"], "authored apply envelope");
  const payload = parsePublicationPayload(envelopeObject.payload);
  const canonicalPayload = requireString(object.canonicalPayload, "canonical outbox payload", { maximum: 8 << 20 });
  if (canonicalPayload !== canonicalJson(payload)) throw authoredError("Outbox canonical payload bytes do not match the payload");
  const payloadSha256 = requireSha256(envelopeObject.payload_sha256, "outbox payload hash");
  if (await sha256Hex(canonicalPayload) !== payloadSha256) throw authoredError("Outbox payload hash does not match");
  const protocolVersion = envelopeObject.protocol_version === "1" ? "1" as const : (() => { throw authoredError("Outbox protocol version is invalid"); })();
  const deviceId = requireStable(envelopeObject.device_id, "outbox device ID");
  const operationId = requireStable(envelopeObject.operation_id, "outbox operation ID");
  const operationKind = requireStable(envelopeObject.operation_kind, "outbox operation kind");
  const envelopeDocumentId = requireStable(envelopeObject.document_id, "outbox document ID");
  const baseRevisionId = requireRevisionId(envelopeObject.base_revision_id, "outbox base revision ID", { empty: true });
  const title = requireSingleLine(envelopeObject.title, "outbox title", 512);
  const clientCursor = requireCount(envelopeObject.client_cursor, "outbox client cursor");
  const envelope: AnyAuthoredApplyEnvelope = payload.kind === "set-list"
    ? {
      protocol_version: protocolVersion, device_id: deviceId, operation_id: operationId, operation_kind: operationKind,
      document_id: envelopeDocumentId, base_revision_id: baseRevisionId, title, payload, payload_sha256: payloadSha256, client_cursor: clientCursor,
    }
    : {
      protocol_version: protocolVersion, device_id: deviceId, operation_id: operationId, operation_kind: operationKind,
      document_id: envelopeDocumentId, base_revision_id: baseRevisionId, title, payload, payload_sha256: payloadSha256, client_cursor: clientCursor,
    };
  const id = requireString(object.id, "outbox ID", { maximum: 127 });
  const documentId = requireStable(object.documentId, "outbox document ID");
  const localRevisionId = requireStable(object.localRevisionId, "outbox local revision ID");
  const state: OutboxState = object.state;
  const attempts = requireCount(object.attempts, "outbox attempts");
  const lastAttemptAt = object.lastAttemptAt === undefined ? undefined : requireTimestamp(object.lastAttemptAt, "outbox lastAttemptAt");
  const lastError = object.lastError === undefined ? undefined : requireString(object.lastError, "outbox lastError", { maximum: 4096 });
  const createdAt = requireTimestamp(object.createdAt, "outbox createdAt");
  const optional = {
    ...(lastAttemptAt === undefined ? {} : { lastAttemptAt }),
    ...(lastError === undefined ? {} : { lastError }),
  };
  const record: AnyAuthoredOutboxRecord = payload.kind === "set-list"
    ? { id, schemaVersion: AUTHORED_OUTBOX_SCHEMA_VERSION, documentId, localRevisionId, state, envelope: envelope as AuthoredApplyEnvelope, canonicalPayload, attempts, ...optional, createdAt }
    : { id, schemaVersion: AUTHORED_OUTBOX_SCHEMA_VERSION, documentId, localRevisionId, state, envelope: envelope as AuthoredLeadSheetApplyEnvelope, canonicalPayload, attempts, ...optional, createdAt };
  const payloadDocumentId = payload.kind === "set-list" ? decodeCanonicalSetListSource(payload.source, payload.path).id : record.documentId;
  if (record.id !== authoredOutboxId(envelope.device_id, envelope.operation_id) || record.documentId !== envelope.document_id || record.documentId !== payloadDocumentId) {
    throw authoredError("Outbox identities do not agree");
  }
  return Object.freeze(record);
}

export function validateConflictRecord(value: unknown): AuthoredConflictRecord {
  const object = requireObject(value, "authored conflict");
  requireExactKeys(object, ["id", "schemaVersion", "documentId", "currentRevisionId", "candidateRevisionId", "resolutionRevisionId", "status", "updatedAt"], "authored conflict");
  if (object.schemaVersion !== AUTHORED_CONFLICT_SCHEMA_VERSION || (object.status !== "open" && object.status !== "resolved")) throw authoredError("Authored conflict schema or status is invalid");
  const id = requireString(object.id, "conflict ID", { maximum: 63 });
  if (!/^conf-[a-f0-9]{24}$/.test(id)) throw authoredError("Conflict ID is invalid");
  return Object.freeze({
    id, schemaVersion: AUTHORED_CONFLICT_SCHEMA_VERSION, documentId: requireStable(object.documentId, "conflict document ID"),
    currentRevisionId: requireRevisionId(object.currentRevisionId, "conflict current revision ID"),
    candidateRevisionId: requireRevisionId(object.candidateRevisionId, "conflict candidate revision ID"),
    resolutionRevisionId: requireRevisionId(object.resolutionRevisionId, "conflict resolution revision ID", { empty: true }),
    status: object.status, updatedAt: requireTimestamp(object.updatedAt, "conflict updatedAt"),
  });
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function validateSyncStateRecord(value: unknown): AuthoredSyncStateRecord {
  const object = requireObject(value, "authored sync state");
  requireExactKeys(object, ["id", "schemaVersion", "deviceId", "cursor", "acknowledgedCursor", "documents", "updatedAt"], "authored sync state");
  if (object.id !== AUTHORED_SYNC_STATE_ID || object.schemaVersion !== AUTHORED_SYNC_SCHEMA_VERSION || !Array.isArray(object.documents)) throw authoredError("Authored sync state schema is invalid");
  const cursor = requireCount(object.cursor, "sync cursor");
  const acknowledgedCursor = requireCount(object.acknowledgedCursor, "acknowledged sync cursor");
  if (acknowledgedCursor > cursor) throw authoredError("Acknowledged sync cursor cannot exceed the durable cursor");
  const seen = new Set<string>();
  const documents = object.documents.map((value) => {
    const document = requireObject(value, "document sync state");
    requireExactKeys(document, ["documentId", "currentServerRevisionId", "publishedRevisionId"], "document sync state");
    const result: AuthoredDocumentSyncState = {
      documentId: requireStable(document.documentId, "sync document ID"),
      currentServerRevisionId: requireRevisionId(document.currentServerRevisionId, "current server revision ID", { empty: true }),
      publishedRevisionId: requireRevisionId(document.publishedRevisionId, "published revision ID", { empty: true }),
    };
    if (seen.has(result.documentId)) throw authoredError("Document sync state IDs must be unique");
    seen.add(result.documentId);
    return Object.freeze(result);
  });
  const sorted = [...documents].sort((left, right) => compareStableText(left.documentId, right.documentId));
  if (documents.some((document, index) => document.documentId !== sorted[index]!.documentId)) throw authoredError("Document sync state must be sorted by document ID");
  return Object.freeze({
    id: AUTHORED_SYNC_STATE_ID, schemaVersion: AUTHORED_SYNC_SCHEMA_VERSION, deviceId: requireStable(object.deviceId, "sync device ID"),
    cursor, acknowledgedCursor, documents: Object.freeze(documents), updatedAt: requireTimestamp(object.updatedAt, "sync updatedAt"),
  });
}

function requireSortedById(records: readonly { readonly id: string }[], label: string): void {
  for (let index = 1; index < records.length; index++) {
    if (records[index - 1]!.id >= records[index]!.id) throw authoredError(`${label} must be strictly sorted by ID`);
  }
}

export async function validateStoredAuthoredState(value: unknown): Promise<StoredAuthoredState> {
  const object = requireObject(value, "authored state records");
  requireExactKeys(object, ["drafts", "revisions", "outbox", "conflicts", "sync"], "authored state records");
  if (!Array.isArray(object.drafts) || !Array.isArray(object.revisions) || !Array.isArray(object.outbox) || !Array.isArray(object.conflicts)) throw authoredError("Authored state record lists are invalid");
  const [drafts, revisions, outbox] = await Promise.all([
    Promise.all(object.drafts.map(validateDraftRecord)),
    Promise.all(object.revisions.map(validateRevisionRecord)),
    Promise.all(object.outbox.map(validateOutboxRecord)),
  ]);
  const conflicts = object.conflicts.map(validateConflictRecord);
  const sync = object.sync === null ? null : validateSyncStateRecord(object.sync);
  for (const [name, values] of [["draft", drafts], ["revision", revisions], ["outbox", outbox], ["conflict", conflicts]] as const) {
    const ids = new Set<string>();
    for (const record of values) {
      if (ids.has(record.id)) throw authoredError(`Authored ${name} IDs must be unique`, { id: record.id });
      ids.add(record.id);
    }
  }
  requireSortedById(drafts, "Authored drafts");
  requireSortedById(revisions, "Authored revisions");
  requireSortedById(outbox, "Authored outbox");
  requireSortedById(conflicts, "Authored conflicts");

  const localRevisions = new Map(revisions.filter((record): record is AnyAuthoredLocalRevisionRecord => record.origin === "local").map((record) => [record.id, record]));
  const serverRevisions = new Map(revisions.filter((record): record is AnyAuthoredServerRevisionRecord => record.origin === "server").map((record) => [record.id, record]));
  const replayed = new Map<string, AuthoredRevision>();
  const visiting = new Set<string>();
  const operationKeys = new Map<string, string>();
  const replay = (revision: AnyAuthoredLocalRevisionRecord): AuthoredRevision => {
    const cached = replayed.get(revision.id);
    if (cached !== undefined) return cached;
    if (visiting.has(revision.id)) throw authoredError("Local revision history contains a cycle", { revisionId: revision.id });
    visiting.add(revision.id);
    let parentRecord: AnyAuthoredLocalRevisionRecord | undefined;
    if (revision.parentRevisionId !== null) {
      parentRecord = localRevisions.get(revision.parentRevisionId);
      if (
        parentRecord === undefined || parentRecord.documentId !== revision.documentId
        || documentKind(parentRecord.document) !== documentKind(revision.document)
      ) throw authoredError("Local revision parent is missing or belongs to another authored document", { revisionId: revision.id });
    }
    let result: AuthoredRevision;
    try {
      if (isSetListAuthoredLocalRevision(revision)) {
        const parent = parentRecord === undefined ? null : replay(parentRecord);
        if (parent !== null && parent.schemaVersion !== SET_LIST_REVISION_SCHEMA_VERSION) throw authoredError("Set List revision parent has another document kind");
        result = executeSetListCommand(parent, revision.command, { revisionId: revision.id, operationId: revision.operationId });
      } else {
        const parent = parentRecord === undefined ? null : replay(parentRecord);
        if (parent !== null && parent.schemaVersion !== LEAD_SHEET_REVISION_SCHEMA_VERSION) throw authoredError("Lead-sheet revision parent has another document kind");
        result = executeLeadSheetCommand(parent, revision.command, { revisionId: revision.id, operationId: revision.operationId });
      }
    } catch (error) {
      throw authoredError("Local revision command cannot be deterministically replayed", { revisionId: revision.id, message: error instanceof Error ? error.message : String(error) });
    }
    const storedProjection = {
      schemaVersion: isSetListAuthoredLocalRevision(revision) ? SET_LIST_REVISION_SCHEMA_VERSION : LEAD_SHEET_REVISION_SCHEMA_VERSION,
      id: revision.id, documentId: revision.documentId, parentRevisionId: revision.parentRevisionId,
      operationId: revision.operationId, operationKind: revision.operationKind, command: revision.command,
      inverse: revision.inverse, document: revision.document,
    };
    if (canonicalJson(result) !== canonicalJson(storedProjection)) throw authoredError("Local revision differs from deterministic command replay", { revisionId: revision.id });
    const operationKey = authoredOutboxId(revision.deviceId, revision.operationId);
    const existingOperationRevision = operationKeys.get(operationKey);
    if (existingOperationRevision !== undefined && existingOperationRevision !== revision.id) throw authoredError("Device operation identity is reused by multiple local revisions", { operationKey });
    operationKeys.set(operationKey, revision.id);
    visiting.delete(revision.id);
    replayed.set(revision.id, result);
    return result;
  };
  for (const revision of localRevisions.values()) replay(revision);
  for (const draft of drafts) {
    const revision = localRevisions.get(draft.localRevisionId);
    if (
      revision === undefined || revision.documentId !== draft.documentId || documentKind(revision.document) !== draft.kind
      || revision.sourceSha256 !== draft.sourceSha256 || revision.source !== draft.source
      || canonicalJson(revision.document) !== canonicalJson(draft.document)
    ) throw authoredError("Authored draft does not match its local revision", { draftId: draft.id, localRevisionId: draft.localRevisionId });
    if (draft.baseServerRevisionId !== "") {
      const base = serverRevisions.get(draft.baseServerRevisionId);
      if (base === undefined || publicationPayloadKind(base.payload) !== draft.kind) throw authoredError("Authored draft base server revision is missing or has another document kind", { draftId: draft.id });
    }
  }
  for (const record of outbox) {
    const revision = localRevisions.get(record.localRevisionId);
    if (
      revision === undefined || revision.documentId !== record.documentId || revision.deviceId !== record.envelope.device_id
      || revision.operationId !== record.envelope.operation_id || revision.operationKind !== record.envelope.operation_kind
      || revision.source !== record.envelope.payload.source || revision.document.path !== record.envelope.payload.path
      || documentKind(revision.document) !== publicationPayloadKind(record.envelope.payload)
      || authoredDocumentTitle(revision.document) !== record.envelope.title
    ) throw authoredError("Authored outbox does not match its local revision", { outboxId: record.id });
    if (record.envelope.base_revision_id !== "") {
      const base = serverRevisions.get(record.envelope.base_revision_id);
      if (base === undefined || base.payload.kind !== record.envelope.payload.kind) throw authoredError("Authored outbox base server revision is missing or has another document kind", { outboxId: record.id });
    }
  }
  for (const record of conflicts) {
    const current = serverRevisions.get(record.currentRevisionId);
    const candidate = serverRevisions.get(record.candidateRevisionId);
    const resolution = record.resolutionRevisionId === "" ? undefined : serverRevisions.get(record.resolutionRevisionId);
    if (
      current === undefined || candidate === undefined || record.resolutionRevisionId !== "" && resolution === undefined
      || current.documentId !== record.documentId || candidate.documentId !== record.documentId || resolution !== undefined && resolution.documentId !== record.documentId
      || current.payload.kind !== candidate.payload.kind || resolution !== undefined && resolution.payload.kind !== current.payload.kind
    ) throw authoredError("Authored conflict references a missing or mismatched server revision", { conflictId: record.id });
  }
  for (const document of sync?.documents ?? []) {
    const current = document.currentServerRevisionId === "" ? undefined : serverRevisions.get(document.currentServerRevisionId);
    const published = document.publishedRevisionId === "" ? undefined : serverRevisions.get(document.publishedRevisionId);
    if (
      document.currentServerRevisionId !== "" && (current === undefined || current.documentId !== document.documentId)
      || document.publishedRevisionId !== "" && (published === undefined || published.documentId !== document.documentId)
      || current !== undefined && published !== undefined && current.payload.kind !== published.payload.kind
    ) throw authoredError("Sync state references a missing or mismatched server revision", { documentId: document.documentId });
  }

  return Object.freeze({
    drafts: Object.freeze(drafts),
    revisions: Object.freeze(revisions),
    outbox: Object.freeze(outbox),
    conflicts: Object.freeze(conflicts),
    sync,
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[a-f0-9]{2})*$/.test(value)) throw authoredError("Opaque binary value is not canonical hexadecimal");
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function opaqueNumber(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "infinity";
  if (value === -Infinity) return "-infinity";
  if (Object.is(value, -0)) return "-0";
  return String(value);
}

function decodedOpaqueNumber(value: unknown): number {
  if (typeof value !== "string") throw authoredError("Opaque number is invalid");
  if (value === "nan") return Number.NaN;
  if (value === "infinity") return Infinity;
  if (value === "-infinity") return -Infinity;
  if (value === "-0") return -0;
  const number = Number(value);
  if (!Number.isFinite(number) || String(number) !== value) throw authoredError("Opaque number is not canonical");
  return number;
}

function opaqueFields(value: OpaqueStructuredClone, fields: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = ["tag", ...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) throw authoredError("Opaque structured-clone node has unknown or missing fields", { tag: value.tag });
}

/** Deterministic, hashable subset of the IndexedDB structured-clone domain. */
export function encodeOpaqueStructuredClone(value: unknown, ancestors = new WeakSet<object>()): OpaqueStructuredClone {
  if (value === null) return Object.freeze({ tag: "null" });
  if (value === undefined) return Object.freeze({ tag: "undefined" });
  if (typeof value === "boolean") return Object.freeze({ tag: "boolean", value });
  if (typeof value === "string") return Object.freeze({ tag: "string", value });
  if (typeof value === "number") return Object.freeze({ tag: "number", value: opaqueNumber(value) });
  if (typeof value === "bigint") return Object.freeze({ tag: "bigint", value: value.toString() });
  if (typeof value !== "object") throw authoredError("Legacy pending value is outside the supported structured-clone export domain");
  if (ancestors.has(value)) throw authoredError("Cyclic legacy pending values cannot be exported safely");
  ancestors.add(value);
  try {
    if (value instanceof Date) return Object.freeze({ tag: "date", value: opaqueNumber(value.getTime()) });
    if (value instanceof RegExp) return Object.freeze({ tag: "regexp", value: value.source, name: value.flags });
    if (value instanceof ArrayBuffer) return Object.freeze({ tag: "array-buffer", value: bytesToHex(new Uint8Array(value)) });
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return Object.freeze({ tag: value instanceof DataView ? "data-view" : "typed-array", name: value.constructor.name, value: bytesToHex(bytes) });
    }
    if (Array.isArray(value)) return Object.freeze({ tag: "array", items: Object.freeze(value.map((item) => encodeOpaqueStructuredClone(item, ancestors))) });
    if (value instanceof Map) return Object.freeze({
      tag: "map",
      entries: Object.freeze([...value.entries()].map(([key, item]) => Object.freeze([encodeOpaqueStructuredClone(key, ancestors), encodeOpaqueStructuredClone(item, ancestors)] as const))),
    });
    if (value instanceof Set) return Object.freeze({ tag: "set", items: Object.freeze([...value].map((item) => encodeOpaqueStructuredClone(item, ancestors))) });
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw authoredError("Legacy pending object type is not supported for deterministic export", { name: value.constructor?.name });
    const entries = Object.keys(value as Record<string, unknown>)
      .sort(compareStableText)
      .map((key) => Object.freeze([key, encodeOpaqueStructuredClone((value as Record<string, unknown>)[key], ancestors)] as const));
    return Object.freeze({ tag: prototype === null ? "null-object" : "object", entries: Object.freeze(entries) });
  } finally {
    ancestors.delete(value);
  }
}

export function decodeOpaqueStructuredClone(value: OpaqueStructuredClone): unknown {
  if (value === null || typeof value !== "object" || typeof value.tag !== "string") throw authoredError("Opaque structured-clone node is invalid");
  switch (value.tag) {
    case "null": opaqueFields(value, []); return null;
    case "undefined": opaqueFields(value, []); return undefined;
    case "boolean": opaqueFields(value, ["value"]); if (typeof value.value !== "boolean") throw authoredError("Opaque boolean is invalid"); return value.value;
    case "string": opaqueFields(value, ["value"]); if (typeof value.value !== "string") throw authoredError("Opaque string is invalid"); return value.value;
    case "number": opaqueFields(value, ["value"]); return decodedOpaqueNumber(value.value);
    case "bigint": opaqueFields(value, ["value"]); if (typeof value.value !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(value.value)) throw authoredError("Opaque bigint is invalid"); return BigInt(value.value);
    case "date": opaqueFields(value, ["value"]); return new Date(decodedOpaqueNumber(value.value));
    case "regexp": opaqueFields(value, ["value", "name"]); if (typeof value.value !== "string" || typeof value.name !== "string") throw authoredError("Opaque regexp is invalid"); return new RegExp(value.value, value.name);
    case "array-buffer": { opaqueFields(value, ["value"]); if (typeof value.value !== "string") throw authoredError("Opaque ArrayBuffer is invalid"); return hexToBytes(value.value).buffer; }
    case "data-view": { opaqueFields(value, ["value", "name"]); if (typeof value.value !== "string" || value.name !== "DataView") throw authoredError("Opaque DataView is invalid"); return new DataView(hexToBytes(value.value).buffer); }
    case "typed-array": {
      opaqueFields(value, ["value", "name"]);
      if (typeof value.value !== "string" || typeof value.name !== "string") throw authoredError("Opaque typed array is invalid");
      const buffer = hexToBytes(value.value).buffer;
      switch (value.name) {
        case "Int8Array": return new Int8Array(buffer);
        case "Uint8Array": return new Uint8Array(buffer);
        case "Uint8ClampedArray": return new Uint8ClampedArray(buffer);
        case "Int16Array": return new Int16Array(buffer);
        case "Uint16Array": return new Uint16Array(buffer);
        case "Int32Array": return new Int32Array(buffer);
        case "Uint32Array": return new Uint32Array(buffer);
        case "Float32Array": return new Float32Array(buffer);
        case "Float64Array": return new Float64Array(buffer);
        case "BigInt64Array": return new BigInt64Array(buffer);
        case "BigUint64Array": return new BigUint64Array(buffer);
        default: throw authoredError("Opaque typed-array constructor is unsupported", { name: value.name });
      }
    }
    case "array": opaqueFields(value, ["items"]); if (!Array.isArray(value.items)) throw authoredError("Opaque array is invalid"); return value.items.map(decodeOpaqueStructuredClone);
    case "set": opaqueFields(value, ["items"]); if (!Array.isArray(value.items)) throw authoredError("Opaque set is invalid"); return new Set(value.items.map(decodeOpaqueStructuredClone));
    case "map": {
      opaqueFields(value, ["entries"]);
      if (!Array.isArray(value.entries)) throw authoredError("Opaque map is invalid");
      return new Map(value.entries.map((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] === "string") throw authoredError("Opaque map entry is invalid");
        return [decodeOpaqueStructuredClone(entry[0]), decodeOpaqueStructuredClone(entry[1])] as const;
      }));
    }
    case "object":
    case "null-object": {
      opaqueFields(value, ["entries"]);
      if (!Array.isArray(value.entries)) throw authoredError("Opaque object is invalid");
      const result: Record<string, unknown> = value.tag === "null-object" ? Object.create(null) as Record<string, unknown> : {};
      let previous = "";
      for (const entry of value.entries) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || (previous !== "" && previous >= entry[0])) throw authoredError("Opaque object entries are invalid or unsorted");
        previous = entry[0];
        result[entry[0]] = decodeOpaqueStructuredClone(entry[1]);
      }
      return result;
    }
    default: throw authoredError("Opaque structured-clone tag is unsupported", { tag: value.tag });
  }
}

function validateOpaquePendingRecords(value: unknown): readonly OpaquePendingRecord[] {
  if (!Array.isArray(value)) throw authoredError("Legacy pending export records must be an array");
  const records = value.map((item) => {
    const object = requireObject(item, "legacy pending record");
    requireExactKeys(object, ["store", "key", "value"], "legacy pending record");
    if (object.store !== "drafts" && object.store !== "outbox" && object.store !== "conflicts") throw authoredError("Legacy pending record store is invalid");
    const key = object.key as OpaqueStructuredClone;
    const encodedValue = object.value as OpaqueStructuredClone;
    decodeOpaqueStructuredClone(key);
    decodeOpaqueStructuredClone(encodedValue);
    return Object.freeze({ store: object.store, key, value: encodedValue });
  });
  const sorted = [...records].sort((left, right) => compareStableText(left.store, right.store) || compareStableText(canonicalJson(left.key), canonicalJson(right.key)));
  if (records.some((record, index) => canonicalJson(record) !== canonicalJson(sorted[index]))) throw authoredError("Legacy pending export records must be canonically sorted");
  for (let index = 1; index < records.length; index++) {
    if (records[index - 1]!.store === records[index]!.store && canonicalJson(records[index - 1]!.key) === canonicalJson(records[index]!.key)) throw authoredError("Legacy pending export keys must be unique");
  }
  return Object.freeze(records);
}

export async function createAuthoredStateExport(records: StoredAuthoredState, exportedAt: string, legacy: readonly OpaquePendingRecord[] = []): Promise<AuthoredStateExport> {
  const body: AuthoredStateExportBody = Object.freeze({
    schemaVersion: AUTHORED_EXPORT_SCHEMA_VERSION,
    database: "songs-v2",
    storageVersion: 3,
    exportedAt: requireTimestamp(exportedAt, "exportedAt"),
    records: await validateStoredAuthoredState(records),
    legacy: validateOpaquePendingRecords(legacy),
  });
  return Object.freeze({ ...body, sha256: await sha256Hex(canonicalJson(body)) });
}

export { canonicalJson };

export async function validateAuthoredStateExport(value: unknown): Promise<AuthoredStateExport> {
  const object = requireObject(value, "authored state export");
  requireExactKeys(object, ["schemaVersion", "database", "storageVersion", "exportedAt", "records", "legacy", "sha256"], "authored state export");
  if (object.schemaVersion !== AUTHORED_EXPORT_SCHEMA_VERSION || object.database !== "songs-v2" || object.storageVersion !== 3) throw authoredError("Authored state export schema is unsupported");
  const body: AuthoredStateExportBody = {
    schemaVersion: AUTHORED_EXPORT_SCHEMA_VERSION, database: "songs-v2", storageVersion: 3,
    exportedAt: requireTimestamp(object.exportedAt, "exportedAt"), records: await validateStoredAuthoredState(object.records),
    legacy: validateOpaquePendingRecords(object.legacy),
  };
  const currentKeys = {
    drafts: new Set(body.records.drafts.map((record) => record.id)),
    outbox: new Set(body.records.outbox.map((record) => record.id)),
    conflicts: new Set(body.records.conflicts.map((record) => record.id)),
  };
  for (const record of body.legacy) {
    const key = decodeOpaqueStructuredClone(record.key);
    if (typeof key === "string" && currentKeys[record.store].has(key)) throw authoredError("Legacy and current authored export records share a key", { store: record.store, key });
  }
  const hash = requireSha256(object.sha256, "authored export hash");
  if (await sha256Hex(canonicalJson(body)) !== hash) throw authoredError("Authored state export hash does not match its records");
  return Object.freeze({ ...body, sha256: hash });
}
