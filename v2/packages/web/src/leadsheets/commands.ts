import {
  type LeadSheetMetadataPatch,
  updateLeadSheetMetadataSource,
} from "./codec";
import {
  type LeadSheet,
  LeadSheetError,
  type LeadSheetOperationId,
  type LeadSheetRevisionId,
  requireExactLeadSheetSource,
  requireLeadSheetOperationId,
  requireLeadSheetRevisionId,
  validateLeadSheet,
} from "./model";

export const LEAD_SHEET_REVISION_SCHEMA_VERSION = "songs-v2-lead-sheet-revision-1" as const;

export interface CreateLeadSheetCommand { readonly kind: "create-lead-sheet"; readonly document: LeadSheet }
export interface UpdateLeadSheetMetadataCommand { readonly kind: "update-metadata"; readonly patch: LeadSheetMetadataPatch }
export interface ReplaceLeadSheetSourceCommand { readonly kind: "replace-source"; readonly source: string }
export interface RestoreLeadSheetSnapshotCommand {
  readonly kind: "restore-snapshot";
  readonly document: LeadSheet;
  readonly undoOfRevisionId?: LeadSheetRevisionId;
}

export type LeadSheetCommand =
  | CreateLeadSheetCommand
  | UpdateLeadSheetMetadataCommand
  | ReplaceLeadSheetSourceCommand
  | RestoreLeadSheetSnapshotCommand;

export interface LeadSheetRevision {
  readonly schemaVersion: typeof LEAD_SHEET_REVISION_SCHEMA_VERSION;
  readonly id: LeadSheetRevisionId;
  readonly documentId: LeadSheet["id"];
  readonly parentRevisionId: LeadSheetRevisionId | null;
  readonly operationId: LeadSheetOperationId;
  readonly operationKind: string;
  readonly command: LeadSheetCommand;
  /** Exact inverse snapshot. Undo applies it as another immutable revision. */
  readonly inverse: RestoreLeadSheetSnapshotCommand | null;
  readonly document: LeadSheet;
}

export interface LeadSheetRevisionIdentity {
  readonly revisionId: string;
  readonly operationId: string;
}

function fail(code: "INVALID_COMMAND" | "NO_CHANGE" | "UNDO_UNAVAILABLE", message: string, detail?: unknown): never {
  throw new LeadSheetError(code, message, detail);
}

function commandObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INVALID_COMMAND", "Lead-sheet command must be an object");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) {
    fail("INVALID_COMMAND", "Lead-sheet command has unknown or missing fields", { actual: Object.keys(value), required, optional });
  }
}

function validatePatch(value: unknown): LeadSheetMetadataPatch {
  const object = commandObject(value);
  const allowed = ["title", "artist", "performanceKey", "bpm", "originalKey", "originalBpm"] as const;
  if (Object.keys(object).length === 0 || Object.keys(object).some((key) => !allowed.includes(key as typeof allowed[number]))) {
    fail("INVALID_COMMAND", "Lead-sheet metadata patch is empty or contains unknown fields", { actual: Object.keys(object) });
  }
  for (const key of allowed) {
    const item = object[key];
    if (item !== undefined && typeof item !== "string" && item !== null) fail("INVALID_COMMAND", `${key} must be a string or null`);
    if ((key === "title" || key === "artist") && item === null) fail("INVALID_COMMAND", `${key} cannot be removed`);
  }
  // Let the surgical codec enforce field semantics before history can retain it.
  const probe = ["---", 'title: "Old"', 'artist: "Artist"', "---", "", "# Old", ""].join("\n");
  updateLeadSheetMetadataSource(probe, object as LeadSheetMetadataPatch);
  return Object.freeze({ ...object }) as LeadSheetMetadataPatch;
}

/** Parse, detach, and freeze commands before they enter revision history. */
export function validateLeadSheetCommand(value: unknown): LeadSheetCommand {
  const object = commandObject(value);
  switch (object.kind) {
    case "create-lead-sheet":
      exactKeys(object, ["kind", "document"]);
      return Object.freeze({ kind: object.kind, document: validateLeadSheet(object.document as LeadSheet) });
    case "update-metadata":
      exactKeys(object, ["kind", "patch"]);
      return Object.freeze({ kind: object.kind, patch: validatePatch(object.patch) });
    case "replace-source":
      exactKeys(object, ["kind", "source"]);
      return Object.freeze({ kind: object.kind, source: requireExactLeadSheetSource(object.source) });
    case "restore-snapshot": {
      exactKeys(object, ["kind", "document"], ["undoOfRevisionId"]);
      const undo = object.undoOfRevisionId;
      if (undo !== undefined && typeof undo !== "string") fail("INVALID_COMMAND", "undoOfRevisionId must be a stable ID");
      return Object.freeze({
        kind: object.kind,
        document: validateLeadSheet(object.document as LeadSheet),
        ...(undo === undefined ? {} : { undoOfRevisionId: requireLeadSheetRevisionId(undo) }),
      });
    }
    default:
      fail("INVALID_COMMAND", "Lead-sheet command kind is invalid", { kind: object.kind });
  }
}

function operationKind(command: LeadSheetCommand): string {
  if (command.kind === "restore-snapshot") return command.undoOfRevisionId === undefined ? "restore-lead-sheet" : "undo-lead-sheet";
  return command.kind;
}

function mutate(base: LeadSheet, command: Exclude<LeadSheetCommand, CreateLeadSheetCommand>): LeadSheet {
  switch (command.kind) {
    case "update-metadata":
      return validateLeadSheet({ ...base, source: updateLeadSheetMetadataSource(base.source, command.patch) });
    case "replace-source":
      return validateLeadSheet({ ...base, source: command.source });
    case "restore-snapshot":
      if (command.document.id !== base.id || command.document.path !== base.path) {
        fail("INVALID_COMMAND", "A restored snapshot cannot change lead-sheet identity or publication path");
      }
      return validateLeadSheet(command.document);
  }
}

/** Apply exactly one command and create an immutable forward revision. */
export function executeLeadSheetCommand(
  base: LeadSheetRevision | null,
  input: LeadSheetCommand,
  identity: LeadSheetRevisionIdentity,
): LeadSheetRevision {
  const command = validateLeadSheetCommand(input);
  const id = requireLeadSheetRevisionId(identity.revisionId);
  const operationId = requireLeadSheetOperationId(identity.operationId);
  const baseDocument = base === null ? null : validateLeadSheet(base.document);
  const baseRevisionId = base === null ? null : requireLeadSheetRevisionId(base.id);
  if (base !== null && base.documentId !== baseDocument!.id) fail("INVALID_COMMAND", "Base revision document identity is inconsistent");
  let document: LeadSheet;
  let parentRevisionId: LeadSheetRevisionId | null;
  let inverse: RestoreLeadSheetSnapshotCommand | null;

  if (command.kind === "create-lead-sheet") {
    if (base !== null) fail("INVALID_COMMAND", "create-lead-sheet cannot be applied to an existing revision");
    document = validateLeadSheet(command.document);
    parentRevisionId = null;
    inverse = null;
  } else {
    if (baseDocument === null || baseRevisionId === null) fail("INVALID_COMMAND", `${command.kind} requires an existing lead-sheet revision`);
    if (id === baseRevisionId) fail("INVALID_COMMAND", "A forward revision must receive a new revision ID");
    document = mutate(baseDocument, command);
    if (document.source === baseDocument.source) fail("NO_CHANGE", "The lead-sheet command did not change the exact source", { kind: command.kind });
    parentRevisionId = baseRevisionId;
    inverse = Object.freeze({ kind: "restore-snapshot", document: baseDocument });
  }

  return Object.freeze({
    schemaVersion: LEAD_SHEET_REVISION_SCHEMA_VERSION,
    id,
    documentId: document.id,
    parentRevisionId,
    operationId,
    operationKind: operationKind(command),
    command,
    inverse,
    document,
  });
}

/** Undo is itself a deterministic forward operation and can therefore be undone. */
export function undoLeadSheetRevision(current: LeadSheetRevision, identity: LeadSheetRevisionIdentity): LeadSheetRevision {
  if (current.inverse === null) fail("UNDO_UNAVAILABLE", "The initial lead-sheet revision cannot be undone");
  return executeLeadSheetCommand(current, Object.freeze({ ...current.inverse, undoOfRevisionId: current.id }), identity);
}
