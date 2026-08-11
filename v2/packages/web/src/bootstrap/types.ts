export interface BaselineRef {
  readonly ref: string;
  readonly tag_object: string;
  readonly commit: string;
}

export interface ChunkDescriptor {
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

export interface SlugRoute {
  readonly kind: "song" | "set";
  readonly slug: string;
  readonly path: string;
  readonly documentId: string;
}

export interface BootstrapManifest {
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
  readonly apex: { readonly version_output: string; readonly executable_sha256: string; readonly flags: readonly string[] };
  readonly physical_ipad: { readonly status: "pending"; readonly note: string };
  readonly slug_routes: readonly SlugRoute[];
  readonly chunks: readonly ChunkDescriptor[];
  readonly snapshot_sha256: string;
  readonly verification: { readonly output_sha256: string };
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

interface BaseProjection {
  readonly id: string;
  readonly kind: "lead-sheet" | "set-list";
  readonly path: string;
  readonly slug: string;
  readonly title: string;
  readonly identitySource: "front-matter" | "sidecar-legacy-source";
  readonly bodyMarkdown: string;
}

export interface LeadSheetProjection extends BaseProjection {
  readonly kind: "lead-sheet";
  readonly metadata: {
    readonly artist: string;
    readonly performanceKey?: string;
    readonly bpm?: string;
    readonly originalKey?: string;
    readonly originalBpm?: string;
    readonly provenanceStatus: string;
    readonly sourceProvider?: string;
    readonly sourceUrl?: string;
  };
}

export interface SetEntryProjection {
  readonly id: string;
  readonly setId: string;
  readonly sectionProjectionKey: string;
  readonly ordinal: number;
  readonly columnBreakBefore: boolean;
  readonly label: string;
  readonly targetLeadSheetId: string;
  readonly targetPath: string;
  readonly singer?: string;
  readonly note?: string;
  readonly suffix: string;
}

export interface SetSectionProjection {
  readonly projectionKey: string;
  readonly identityScope: "frozen-snapshot";
  readonly setId: string;
  readonly ordinal: number;
  readonly heading?: string;
  readonly columnBreakBefore: boolean;
  readonly entryIds: readonly string[];
}

export interface SetListProjection extends BaseProjection {
  readonly kind: "set-list";
  readonly metadata: {
    readonly date: string;
    readonly datePrecision?: string;
    readonly location: string;
    readonly band?: string;
    readonly status: string;
    readonly reviewRequired: boolean;
  };
  readonly sections: readonly SetSectionProjection[];
  readonly entries: readonly SetEntryProjection[];
}

interface BootstrapDocumentBase {
  readonly ordinal: number;
  readonly id: string;
  readonly path: string;
  readonly slug: string;
  readonly source: {
    readonly ref: string;
    readonly commit: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly content_base64: string;
  };
  readonly verification: { readonly projection_sha256: string; readonly document_sha256: string };
}

export interface LeadSheetDocument extends BootstrapDocumentBase {
  readonly kind: "lead-sheet";
  readonly projection: LeadSheetProjection;
  readonly apex: { readonly source_sha256: string; readonly html: string; readonly sha256: string; readonly bytes: number };
  readonly fit: { readonly source_sha256: string; readonly profiles: readonly FitResult[] };
}

export interface SetListDocument extends BootstrapDocumentBase {
  readonly kind: "set-list";
  readonly projection: SetListProjection;
  readonly apex: null;
  readonly fit: null;
}

export type BootstrapDocument = LeadSheetDocument | SetListDocument;

export interface BootstrapChunk {
  readonly schema_version: "1";
  readonly kind: "songs-v2.bootstrap.chunk";
  readonly generation: string;
  readonly index: number;
  readonly documents: readonly BootstrapDocument[];
  readonly verification: { readonly documents_sha256: string; readonly output_sha256: string };
}

export interface VerifiedSnapshot {
  readonly manifest: BootstrapManifest;
  readonly documents: readonly BootstrapDocument[];
  readonly leadSheets: readonly LeadSheetDocument[];
  readonly setLists: readonly SetListDocument[];
  readonly documentsById: ReadonlyMap<string, BootstrapDocument>;
  readonly routeByKey: ReadonlyMap<string, SlugRoute>;
  readonly songRouteById: ReadonlyMap<string, SlugRoute>;
}

export type BootstrapClientErrorCode =
  | "UNAUTHENTICATED"
  | "NETWORK_OFFLINE"
  | "API_PROTOCOL_INVALID"
  | "MANIFEST_HASH_MISMATCH"
  | "MANIFEST_UNSUPPORTED"
  | "MANIFEST_INVALID"
  | "CHUNK_HASH_MISMATCH"
  | "CHUNK_INVALID"
  | "SNAPSHOT_INVALID";

export class BootstrapClientError extends Error {
  constructor(readonly code: BootstrapClientErrorCode, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "BootstrapClientError";
  }
}
