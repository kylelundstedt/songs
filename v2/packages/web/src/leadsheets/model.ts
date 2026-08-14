/** Local-first lead-sheet identity and exact-source model. */

import { isStableId } from "../setlists/model";

export const LEAD_SHEET_SCHEMA_VERSION = "songs-v2-lead-sheet-1" as const;
export const MAX_LEAD_SHEET_SOURCE_BYTES = 1 << 20;

export type LeadSheetId = string & { readonly __leadSheetId: unique symbol };
export type LeadSheetRevisionId = string & { readonly __leadSheetRevisionId: unique symbol };
export type LeadSheetOperationId = string & { readonly __leadSheetOperationId: unique symbol };

export type LeadSheetErrorCode =
  | "INVALID_ID"
  | "INVALID_PATH"
  | "INVALID_SOURCE"
  | "INVALID_METADATA"
  | "FRONT_MATTER_INVALID"
  | "INVALID_COMMAND"
  | "NO_CHANGE"
  | "UNDO_UNAVAILABLE";

export class LeadSheetError extends Error {
  constructor(readonly code: LeadSheetErrorCode, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "LeadSheetError";
  }
}

export interface LeadSheet {
  readonly schemaVersion: typeof LEAD_SHEET_SCHEMA_VERSION;
  readonly id: LeadSheetId;
  /** Canonical repository-relative publication path below songs/. */
  readonly path: string;
  /** Exact authored UTF-8/LF Markdown source. */
  readonly source: string;
}

export interface NewLeadSheet {
  readonly id: string;
  readonly path: string;
  readonly source: string;
}

const SONG_PATH_RE = /^songs\/[A-Za-z0-9][A-Za-z0-9'_\-]*\.md$/;
const encoder = new TextEncoder();

function fail(code: LeadSheetErrorCode, message: string, detail?: unknown): never {
  throw new LeadSheetError(code, message, detail);
}

export function requireLeadSheetId(value: string, label = "Lead-sheet ID"): LeadSheetId {
  if (!isStableId(value)) fail("INVALID_ID", `${label} must be a stable lowercase ID`, { value });
  return value as LeadSheetId;
}

export function requireLeadSheetRevisionId(value: string, label = "Lead-sheet revision ID"): LeadSheetRevisionId {
  if (!isStableId(value)) fail("INVALID_ID", `${label} must be a stable lowercase ID`, { value });
  return value as LeadSheetRevisionId;
}

export function requireLeadSheetOperationId(value: string, label = "Lead-sheet operation ID"): LeadSheetOperationId {
  if (!isStableId(value)) fail("INVALID_ID", `${label} must be a stable lowercase ID`, { value });
  return value as LeadSheetOperationId;
}

export function requireLeadSheetPath(value: string): string {
  if (!SONG_PATH_RE.test(value)) fail("INVALID_PATH", "Lead-sheet path must be one safe Markdown file below songs/", { value });
  return value;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Reject values that cannot round-trip as the exact UTF-8/LF publication bytes. */
export function requireExactLeadSheetSource(value: unknown): string {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\r")
    || hasUnpairedSurrogate(value) || encoder.encode(value).byteLength > MAX_LEAD_SHEET_SOURCE_BYTES
  ) {
    fail("INVALID_SOURCE", "Lead-sheet source must be non-empty bounded UTF-8 with LF line endings and no NUL", { value });
  }
  return value;
}

/** Validate, detach, and freeze one exact-source draft at the domain boundary. */
export function validateLeadSheet(input: NewLeadSheet | LeadSheet): LeadSheet {
  return Object.freeze({
    schemaVersion: LEAD_SHEET_SCHEMA_VERSION,
    id: requireLeadSheetId(input.id),
    path: requireLeadSheetPath(input.path),
    source: requireExactLeadSheetSource(input.source),
  });
}

export function createLeadSheet(input: NewLeadSheet): LeadSheet {
  return validateLeadSheet(input);
}
