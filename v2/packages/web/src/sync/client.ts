export const SYNC_PROTOCOL_VERSION = "1";
export const SYNC_PREFIX = "/api/v2/sync";
export const WRITABLE_CAPABILITIES_PATH = "/api/v2/writable-capabilities";

export interface WritableCapabilities {
  readonly schema_version: "1";
  readonly set_list_authoring: boolean;
  readonly foreground_sync: boolean;
}

export interface DeviceCredential {
  readonly deviceId: string;
  readonly token: string;
}

export interface Registration {
  readonly protocol_version: "1";
  readonly owner_id: string;
  readonly device_id: string;
  readonly registration_id: string;
  readonly name: string;
  readonly status: "active";
  readonly token: string;
}

export interface ApplyEnvelope {
  readonly protocol_version: "1";
  readonly device_id: string;
  readonly operation_id: string;
  readonly operation_kind: string;
  readonly document_id: string;
  readonly base_revision_id: string;
  readonly title: string;
  readonly payload: unknown;
  readonly payload_sha256: string;
  readonly client_cursor: number;
}

export interface SyncOutcome {
  readonly operation_id: string;
  readonly status: "applied" | "conflict" | "resolved" | "published";
  readonly revision_id: string;
  readonly conflict_id?: string;
  readonly sequence: number;
}

export interface SyncRevision {
  readonly revision_id: string;
  readonly document_id: string;
  readonly device_id: string;
  readonly operation_id: string;
  readonly base_revision_id: string;
  readonly title: string;
  readonly payload: unknown;
  readonly content_hash: string;
}

export interface SyncEvent {
  readonly sequence: number;
  readonly kind: string;
  readonly operation_id: string;
  readonly document_id: string;
  readonly revision_id: string;
  readonly conflict_id?: string;
}

export interface SyncConflict {
  readonly conflict_id: string;
  readonly document_id: string;
  readonly current_revision_id: string;
  readonly candidate_revision_id: string;
  readonly resolution_revision_id?: string;
  readonly status: "open" | "resolved";
}

export interface PullResult {
  readonly events: readonly SyncEvent[];
  readonly revisions: readonly SyncRevision[];
  readonly conflicts: readonly SyncConflict[];
  readonly cursor: number;
  readonly compaction_floor: number;
}

export interface SyncDocumentHead {
  readonly document_id: string;
  readonly current_revision_id: string;
  readonly title: string;
}

export interface SyncPublication {
  readonly document_id: string;
  readonly revision_id: string;
  readonly commit: string;
}

export interface SyncSnapshot {
  readonly protocol_version: "1";
  readonly cursor: number;
  readonly compaction_floor: number;
  readonly revisions: readonly SyncRevision[];
  readonly conflicts: readonly SyncConflict[];
  readonly documents?: readonly SyncDocumentHead[];
  readonly publications?: readonly SyncPublication[];
}

export class SyncHTTPError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "SyncHTTPError";
  }
}

function credentialHeaders(credential: DeviceCredential): Record<string, string> {
  return { "X-Songs-V2-Device-ID": credential.deviceId, "X-Songs-V2-Device-Token": credential.token };
}

function withSignal(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

async function parseJSON<T>(response: Response): Promise<T> {
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const body = value !== null && typeof value === "object" ? value as { code?: unknown; message?: unknown } : {};
    throw new SyncHTTPError(response.status, typeof body.code === "string" ? body.code : "HTTP_ERROR", typeof body.message === "string" ? body.message : `Sync request failed (${response.status})`);
  }
  return value as T;
}

export async function loadWritableCapabilities(signal?: AbortSignal): Promise<WritableCapabilities> {
  const response = await fetch(WRITABLE_CAPABILITIES_PATH, { method: "GET", credentials: "same-origin", cache: "no-store", ...withSignal(signal) });
  return parseJSON<WritableCapabilities>(response);
}

export async function registerDevice(input: { readonly deviceId: string; readonly registrationId: string; readonly name: string; readonly signal?: AbortSignal }): Promise<Registration> {
  const response = await fetch(`${SYNC_PREFIX}/devices/register`, {
    method: "POST", credentials: "same-origin", cache: "no-store", ...withSignal(input.signal),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ protocol_version: SYNC_PROTOCOL_VERSION, device_id: input.deviceId, registration_id: input.registrationId, name: input.name }),
  });
  return parseJSON<Registration>(response);
}

export async function applyOperation(envelope: ApplyEnvelope, credential: DeviceCredential, signal?: AbortSignal): Promise<SyncOutcome> {
  const response = await fetch(`${SYNC_PREFIX}/operations/apply`, {
    method: "POST", credentials: "same-origin", cache: "no-store", ...withSignal(signal),
    headers: { "Content-Type": "application/json", ...credentialHeaders(credential) }, body: JSON.stringify(envelope),
  });
  return parseJSON<SyncOutcome>(response);
}

export async function pull(cursor: number, credential: DeviceCredential, signal?: AbortSignal): Promise<PullResult> {
  const response = await fetch(`${SYNC_PREFIX}/pull?cursor=${encodeURIComponent(String(cursor))}`, { method: "GET", credentials: "same-origin", cache: "no-store", ...withSignal(signal), headers: credentialHeaders(credential) });
  return parseJSON<PullResult>(response);
}

export async function snapshot(credential: DeviceCredential, signal?: AbortSignal): Promise<SyncSnapshot> {
  const response = await fetch(`${SYNC_PREFIX}/snapshot`, { method: "GET", credentials: "same-origin", cache: "no-store", ...withSignal(signal), headers: credentialHeaders(credential) });
  return parseJSON<SyncSnapshot>(response);
}

export async function acknowledge(cursor: number, credential: DeviceCredential, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${SYNC_PREFIX}/ack`, {
    method: "POST", credentials: "same-origin", cache: "no-store", ...withSignal(signal),
    headers: { "Content-Type": "application/json", ...credentialHeaders(credential) },
    body: JSON.stringify({ protocol_version: SYNC_PROTOCOL_VERSION, device_id: credential.deviceId, cursor }),
  });
  await parseJSON<unknown>(response);
}
