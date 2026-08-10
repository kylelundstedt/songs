export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface BaselineRef {
  readonly ref: string;
  readonly tag_object: string;
  readonly commit: string;
}

export interface FitBox {
  readonly client_width: number;
  readonly client_height: number;
  readonly scroll_width: number;
  readonly scroll_height: number;
}

export interface FitResult extends FitBox {
  readonly profile: "ipad-portrait" | "ipad-landscape" | "phone";
  readonly status: "fit" | "needs-editing" | "scrollable";
  readonly body_px: number;
  readonly auto_body_px: number;
  readonly line_height: number;
  readonly column_count: number;
  readonly columns: readonly FitBox[];
}

export interface BootstrapDocumentV1 {
  readonly ordinal: number;
  readonly id: string;
  readonly kind: "lead-sheet" | "set-list";
  readonly path: string;
  readonly slug: string;
  readonly source: {
    readonly ref: string;
    readonly commit: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly content_base64: string;
  };
  readonly projection: JsonValue;
  readonly apex: null | {
    readonly source_sha256: string;
    readonly html: string;
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly fit: null | {
    readonly source_sha256: string;
    readonly profiles: readonly FitResult[];
  };
  readonly verification: {
    readonly projection_sha256: string;
    readonly document_sha256: string | null;
  };
}

export interface BootstrapChunkV1 {
  readonly schema_version: "1";
  readonly kind: "songs-v2.bootstrap.chunk";
  readonly generation: string;
  readonly index: number;
  readonly documents: readonly BootstrapDocumentV1[];
  readonly verification: {
    readonly documents_sha256: string;
    readonly output_sha256: string | null;
  };
}

export interface BootstrapChunkDescriptorV1 {
  readonly index: number;
  readonly path: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly source_bytes: number;
  readonly document_count: number;
  readonly first_path: string;
  readonly last_path: string;
}

export interface BootstrapManifestV1 {
  readonly schema_version: "1";
  readonly kind: "songs-v2.bootstrap.manifest";
  readonly generation: string;
  readonly source_baseline: BaselineRef;
  readonly evidence_baseline: BaselineRef;
  readonly read_model_anchor: {
    readonly implementation_commit: string;
    readonly import_report_file_sha256: string;
    readonly import_report_output_sha256: string;
  };
  readonly counts: {
    readonly documents: number;
    readonly lead_sheets: number;
    readonly set_lists: number;
    readonly set_sections: number;
    readonly set_entries: number;
    readonly source_bytes: number;
  };
  readonly contract_hashes: {
    readonly corpus_manifest: string;
    readonly identity_sidecars: string;
    readonly read_model_projection: string;
  };
  readonly evidence_hashes: {
    readonly renderer_baseline: string;
    readonly browser_fit_summary: string;
    readonly fit_captures: Readonly<Record<string, string>>;
  };
  readonly apex: {
    readonly version_output: string;
    readonly executable_sha256: string;
    readonly flags: readonly string[];
  };
  readonly physical_ipad: {
    readonly status: "pending";
    readonly note: string;
  };
  readonly slug_routes: JsonValue;
  readonly chunks: readonly BootstrapChunkDescriptorV1[];
  readonly snapshot_sha256: string;
  readonly verification: {
    readonly output_sha256: string | null;
  };
}

export interface BootstrapArtifacts {
  readonly manifest: Uint8Array;
  readonly chunks: ReadonlyMap<string, Uint8Array>;
}

export type BootstrapErrorCode =
  | "EVIDENCE_INVALID"
  | "APEX_INVALID"
  | "GENERATION_INVALID"
  | "SCHEMA_UNSUPPORTED"
  | "CHUNK_MISSING"
  | "CHUNK_UNEXPECTED"
  | "CHUNK_ORDER_INVALID"
  | "CHUNK_HASH_MISMATCH"
  | "DOCUMENT_INVALID"
  | "SNAPSHOT_INVALID";

export class BootstrapError extends Error {
  constructor(readonly code: BootstrapErrorCode, message: string, readonly context: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "BootstrapError";
  }
}
