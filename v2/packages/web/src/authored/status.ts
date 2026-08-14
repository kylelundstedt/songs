import type { AuthoredConflictRecord, AuthoredDocumentKind, AuthoredDocumentSyncState, AnyAuthoredOutboxRecord, LeadSheetValidationReceiptRecord } from "../storage/authored";

export type AuthoredReadinessCode =
  | "conflicted"
  | "resolution-failed"
  | "resolution-queued"
  | "sync-failed"
  | "queued"
  | "local"
  | "acknowledged"
  | "server-accepted"
  | "server-validated"
  | "published";

export interface AuthoredReadiness {
  readonly code: AuthoredReadinessCode;
  readonly label: string;
  readonly detail: string;
}

export interface AuthoredReadinessInput {
  readonly documentId: string;
  readonly kind: AuthoredDocumentKind;
  readonly baseServerRevisionId: string;
  readonly localRevisionId?: string;
  readonly sourceSha256?: string;
  readonly sync: AuthoredDocumentSyncState | undefined;
  readonly acknowledgedCursor: number;
  readonly cursor: number;
  readonly outbox: readonly AnyAuthoredOutboxRecord[];
  readonly conflicts: readonly AuthoredConflictRecord[];
  readonly validationReceipt?: LeadSheetValidationReceiptRecord | null;
}

/** Shared, explicit readiness vocabulary. Publication never hides a conflict. */
export function authoredReadiness(input: AuthoredReadinessInput): AuthoredReadiness {
  const conflict = input.conflicts.find((item) => item.documentId === input.documentId && item.status === "open");
  const queue = input.outbox.filter((item) => item.documentId === input.documentId);
  const resolution = queue.find((item) => "conflictId" in item);
  if (resolution !== undefined) {
    if (resolution.state === "failed") return { code: "resolution-failed", label: "Resolution retry required", detail: resolution.lastError ?? "The reviewed resolution remains durable and was not accepted." };
    return { code: "resolution-queued", label: "Resolution queued", detail: "The reviewed resolution is durable and waiting for foreground sync." };
  }
  if (conflict !== undefined) return { code: "conflicted", label: "Conflicted", detail: "Both server candidates are retained until explicit review." };
  const failed = queue.find((item) => item.state === "failed");
  if (failed !== undefined) return { code: "sync-failed", label: "Queued · retry required", detail: failed.lastError ?? "The immutable operation remains durable." };
  if (queue.length > 0) return { code: "queued", label: "Queued", detail: "Local revisions are durable and waiting for foreground sync." };
  if (input.baseServerRevisionId === "") return { code: "local", label: "Local", detail: "Saved on this browser; no server revision has been accepted." };
  const published = input.sync?.publishedRevisionId === input.baseServerRevisionId;
  if (published) return { code: "published", label: "Published", detail: "The current accepted server revision is materialized in Git." };
  if (input.kind === "lead-sheet" && input.validationReceipt?.response.valid === true && input.validationReceipt.sourceSha256 === input.sourceSha256) {
    return { code: "server-validated", label: "Server/Apex validated", detail: "This exact source passed authoritative server/Apex validation." };
  }
  if (input.acknowledgedCursor === input.cursor && input.cursor > 0) return { code: "acknowledged", label: "Acknowledged", detail: "The browser durably processed and acknowledged the current server cursor." };
  return { code: "server-accepted", label: "Server accepted", detail: "The server accepted this revision; browser acknowledgement is pending." };
}
