export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type DocumentKind = "song" | "set";
export type IdentitySource = "front-matter" | "sidecar-legacy-source";

export interface FrozenBaseline {
  readonly ref: string;
  readonly commit: string;
}

export interface SourceEnvelope {
  readonly ref: string;
  readonly commit: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface FrontMatterProjection {
  readonly raw: string;
  readonly data: Readonly<Record<string, JsonValue>>;
}

export interface BaseDocument {
  readonly id: string;
  readonly kind: "lead-sheet" | "set-list";
  readonly path: string;
  readonly slug: string;
  readonly title: string;
  readonly identitySource: IdentitySource;
  readonly source: SourceEnvelope;
  readonly canonicalMarkdown: string;
  readonly canonicalSourceBase64: string;
  readonly frontMatter: FrontMatterProjection;
  readonly bodyMarkdown: string;
}

export interface LeadSheetMetadata {
  readonly artist: string;
  readonly performanceKey?: string;
  readonly bpm?: string;
  readonly originalKey?: string;
  readonly originalBpm?: string;
  readonly provenanceStatus: string;
  readonly sourceProvider?: string;
  readonly sourceUrl?: string;
  readonly legacySourceCommit?: string;
  readonly legacySourcePath?: string;
}

export interface LeadSheet extends BaseDocument {
  readonly kind: "lead-sheet";
  readonly metadata: LeadSheetMetadata;
}

export interface SetListMetadata {
  readonly date: string;
  readonly datePrecision?: string;
  readonly location: string;
  readonly band?: string;
  readonly status: string;
  readonly reviewRequired: boolean;
  readonly sourceType?: string;
  readonly sourceId?: string;
}

export type SetSourceNode =
  | { readonly kind: "blank"; readonly line: number; readonly raw: string }
  | { readonly kind: "heading"; readonly level: 1 | 2; readonly line: number; readonly raw: string; readonly text: string }
  | { readonly kind: "column-break"; readonly line: number; readonly raw: string }
  | { readonly kind: "entry"; readonly line: number; readonly raw: string; readonly entryId: string }
  | { readonly kind: "other"; readonly line: number; readonly raw: string };

export interface SetEntry {
  readonly id: string;
  readonly setId: string;
  readonly sectionProjectionKey: string;
  readonly ordinal: number;
  readonly sourceLine: number;
  readonly columnBreakBefore: boolean;
  readonly sourceContent: string;
  readonly fingerprint: string;
  readonly fingerprintOccurrence: number;
  readonly label: string;
  readonly target: string;
  readonly targetPath: string;
  readonly targetLeadSheetId: string;
  readonly singer?: string;
  readonly note?: string;
  readonly suffix: string;
}

export interface SetSection {
  readonly projectionKey: string;
  readonly identityScope: "frozen-snapshot";
  readonly setId: string;
  readonly ordinal: number;
  readonly heading?: string;
  readonly columnBreakBefore: boolean;
  readonly startLine: number;
  readonly endLine: number;
  readonly entryIds: readonly string[];
}

export interface SetList extends BaseDocument {
  readonly kind: "set-list";
  readonly metadata: SetListMetadata;
  readonly sections: readonly SetSection[];
  readonly entries: readonly SetEntry[];
  readonly sourceNodes: readonly SetSourceNode[];
}

export interface SlugRoute {
  readonly kind: DocumentKind;
  readonly slug: string;
  readonly path: string;
  readonly documentId: string;
}

export interface ReadModelSnapshot {
  readonly schemaVersion: "1";
  readonly sourceBaseline: FrozenBaseline;
  readonly evidenceBaseline: FrozenBaseline;
  readonly identityNamespace: string;
  readonly documents: readonly (LeadSheet | SetList)[];
  readonly leadSheets: readonly LeadSheet[];
  readonly setLists: readonly SetList[];
  readonly slugRoutes: readonly SlugRoute[];
}

export interface ImportReportDocument {
  readonly id: string;
  readonly kind: "lead-sheet" | "set-list";
  readonly path: string;
  readonly slug: string;
  readonly title: string;
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly identitySource: IdentitySource;
}

export interface ImportReportEntry {
  readonly id: string;
  readonly setId: string;
  readonly sectionProjectionKey: string;
  readonly ordinal: number;
  readonly targetPath: string;
  readonly targetLeadSheetId: string;
  readonly fingerprint: string;
}

export interface ImportReportSection {
  readonly projectionKey: string;
  readonly identityScope: "frozen-snapshot";
  readonly setId: string;
  readonly ordinal: number;
  readonly heading?: string;
  readonly entryCount: number;
}

export interface ImportReport {
  readonly schemaVersion: "1";
  readonly sourceBaseline: FrozenBaseline;
  readonly evidenceBaseline: FrozenBaseline;
  readonly contractHashes: {
    readonly corpusManifest: string;
    readonly identitySidecars: string;
  };
  readonly counts: {
    readonly documents: number;
    readonly leadSheets: number;
    readonly setLists: number;
    readonly setSections: number;
    readonly setEntries: number;
    readonly resolvedSetEntries: number;
    readonly canonicalSourceBytes: number;
  };
  readonly documents: readonly ImportReportDocument[];
  readonly sections: readonly ImportReportSection[];
  readonly setEntries: readonly ImportReportEntry[];
  readonly verification: {
    readonly projectionSha256: string;
    readonly outputSha256: string;
  };
}
