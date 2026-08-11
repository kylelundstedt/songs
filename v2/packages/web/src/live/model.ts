import type {
  FitResult,
  LeadSheetDocument,
  SetEntryProjection,
  SetListDocument,
  SetSectionProjection,
  VerifiedSnapshot,
} from "../bootstrap/types";
import { LibraryIndex, type LibrarySet, type LibrarySong } from "../library";

/** Errors raised while constructing a complete, occurrence-preserving Live model. */
export type PerformanceSetErrorCode =
  | "INVALID_SOURCE"
  | "SET_NOT_FOUND"
  | "SET_IDENTITY_MISMATCH"
  | "ENTRY_IDENTITY_MISMATCH"
  | "ENTRY_OWNERSHIP_MISMATCH"
  | "SECTION_IDENTITY_MISMATCH"
  | "SECTION_OWNERSHIP_MISMATCH"
  | "SECTION_ENTRY_COVERAGE_MISMATCH"
  | "ENTRY_SECTION_MISMATCH"
  | "ENTRY_SECTION_COVERAGE_MISMATCH"
  | "TARGET_NOT_FOUND"
  | "TARGET_KIND_MISMATCH"
  | "TARGET_PATH_MISMATCH"
  | "TARGET_IDENTITY_MISMATCH"
  | "FIT_PROFILE_MISMATCH";

export class PerformanceSetError extends Error {
  constructor(readonly code: PerformanceSetErrorCode, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "PerformanceSetError";
  }
}

export type PerformanceFitProfile = "ipad-portrait" | "ipad-landscape" | "phone";
export type PerformanceWarning = "landscape-needs-editing";

export interface PerformanceFitRecords {
  readonly portrait: FitResult;
  readonly landscape: FitResult;
  readonly phone: FitResult;
}

/** A frozen copy of the section identity attached to one Set Entry occurrence. */
export interface PerformanceSection {
  readonly projectionKey: string;
  readonly identityScope: "frozen-snapshot";
  readonly setId: string;
  readonly ordinal: number;
  readonly heading?: string;
  readonly columnBreakBefore: boolean;
  readonly entryIds: readonly string[];
}

/**
 * One occurrence in a performance sequence.  The Set Entry ID is intentionally
 * retained independently from the target song ID: the same song can therefore
 * occur more than once without collapsing or reordering the sequence.
 */
export class PerformanceEntry {
  readonly entry: SetEntryProjection;
  readonly setEntry: SetEntryProjection;
  readonly id: string;
  readonly entryId: string;
  readonly ordinal: number;
  readonly label: string;
  readonly singer?: string;
  readonly note?: string;
  readonly suffix: string;
  readonly targetLeadSheetId: string;
  readonly targetPath: string;
  readonly song: LibrarySong;
  readonly leadSheet: LeadSheetDocument;
  readonly apexHtml: string;
  readonly html: string;
  readonly section: PerformanceSection;
  readonly sectionHeading?: string;
  readonly sectionProjectionKey: string;
  readonly columnBreakBefore: boolean;
  readonly fit: PerformanceFitRecords;
  readonly fitRecords: PerformanceFitRecords;
  readonly portrait: FitResult;
  readonly portraitFit: FitResult;
  readonly landscape: FitResult;
  readonly landscapeFit: FitResult;
  readonly phone: FitResult;
  readonly phoneFit: FitResult;
  readonly warning: PerformanceWarning | null;
  readonly landscapeWarning: boolean;
  readonly hasLandscapeWarning: boolean;
  readonly warningProfile: "ipad-landscape" | null;

  constructor(args: {
    readonly entry: SetEntryProjection;
    readonly section: PerformanceSection;
    readonly song: LibrarySong;
    readonly leadSheet: LeadSheetDocument;
    readonly fit: PerformanceFitRecords;
    readonly warning: PerformanceWarning | null;
  }) {
    const entry = args.entry;
    this.entry = entry;
    this.setEntry = entry;
    this.id = entry.id;
    this.entryId = entry.id;
    this.ordinal = entry.ordinal;
    this.label = entry.label;
    if (entry.singer !== undefined) this.singer = entry.singer;
    if (entry.note !== undefined) this.note = entry.note;
    this.suffix = entry.suffix;
    this.targetLeadSheetId = entry.targetLeadSheetId;
    this.targetPath = entry.targetPath;
    this.song = args.song;
    this.leadSheet = args.leadSheet;
    this.apexHtml = args.leadSheet.apex.html;
    this.html = args.leadSheet.apex.html;
    this.section = args.section;
    if (args.section.heading !== undefined) this.sectionHeading = args.section.heading;
    this.sectionProjectionKey = args.section.projectionKey;
    this.columnBreakBefore = entry.columnBreakBefore;
    this.fit = args.fit;
    this.fitRecords = args.fit;
    this.portrait = args.fit.portrait;
    this.portraitFit = this.portrait;
    this.landscape = args.fit.landscape;
    this.landscapeFit = this.landscape;
    this.phone = args.fit.phone;
    this.phoneFit = this.phone;
    this.warning = args.warning;
    this.landscapeWarning = args.warning !== null;
    this.hasLandscapeWarning = this.landscapeWarning;
    this.warningProfile = args.warning === null ? null : "ipad-landscape";
    Object.freeze(this);
  }
}

export type PerformanceOccurrence = PerformanceEntry;
export type PerformanceSetEntry = PerformanceEntry;
export type ResolvedPerformanceEntry = PerformanceEntry;

export interface PerformanceSetIdentity {
  readonly id: string;
  readonly path: string;
  readonly slug: string;
  readonly title: string;
  readonly date: string;
  readonly datePrecision?: string;
  readonly location: string;
  readonly band?: string;
  readonly status: string;
  readonly reviewRequired: boolean;
}

/**
 * Immutable local Live sequence for one Set List.  No source lookup or network
 * operation is performed after construction; navigation only returns bounded
 * indices/occurrences from this frozen sequence.
 */
export class PerformanceSet {
  readonly set: LibrarySet;
  readonly librarySet: LibrarySet;
  readonly document: SetListDocument;
  readonly id: string;
  readonly path: string;
  readonly slug: string;
  readonly title: string;
  readonly date: string;
  readonly datePrecision?: string;
  readonly location: string;
  readonly band?: string;
  readonly status: string;
  readonly reviewRequired: boolean;
  readonly identity: PerformanceSetIdentity;
  readonly entries: readonly PerformanceEntry[];
  readonly setEntries: readonly PerformanceEntry[];
  readonly resolvedEntries: readonly PerformanceEntry[];
  readonly performanceEntries: readonly PerformanceEntry[];
  readonly occurrences: readonly PerformanceEntry[];
  readonly warningOccurrences: readonly PerformanceEntry[];
  readonly landscapeWarningOccurrences: readonly PerformanceEntry[];
  readonly warnings: readonly PerformanceEntry[];
  readonly landscapeWarningSlugs: readonly string[];
  readonly length: number;
  readonly count: number;

  static from(source: PerformanceSetSource | LibrarySet, selection: PerformanceSetSelection | PerformanceSetSource): PerformanceSet {
    return buildPerformanceSet(source as never, selection as never);
  }

  static fromLibraryIndex(index: LibraryIndex, set: PerformanceSetSelection): PerformanceSet {
    return buildPerformanceSet(index, set);
  }

  static fromSnapshot(snapshot: VerifiedSnapshot, set: PerformanceSetSelection): PerformanceSet {
    return buildPerformanceSet(snapshot, set);
  }

  constructor(set: LibrarySet, entries: readonly PerformanceEntry[]) {
    this.set = set;
    this.librarySet = set;
    this.document = set.document;
    this.id = set.id;
    this.path = set.path;
    this.slug = set.slug;
    this.title = set.title;
    this.date = set.date;
    if (set.datePrecision !== undefined) this.datePrecision = set.datePrecision;
    this.location = set.location;
    if (set.band !== undefined) this.band = set.band;
    this.status = set.status;
    this.reviewRequired = set.reviewRequired;
    this.identity = freezeObject({
      id: set.id,
      path: set.path,
      slug: set.slug,
      title: set.title,
      date: set.date,
      ...(set.datePrecision === undefined ? {} : { datePrecision: set.datePrecision }),
      location: set.location,
      ...(set.band === undefined ? {} : { band: set.band }),
      status: set.status,
      reviewRequired: set.reviewRequired,
    });
    this.entries = freezeArray(entries);
    this.setEntries = this.entries;
    this.resolvedEntries = this.entries;
    this.performanceEntries = this.entries;
    this.occurrences = this.entries;
    this.warningOccurrences = freezeArray(entries.filter((entry) => entry.landscapeWarning));
    this.landscapeWarningOccurrences = this.warningOccurrences;
    this.warnings = this.warningOccurrences;
    this.landscapeWarningSlugs = freezeArray(uniqueStrings(this.warningOccurrences.map((entry) => entry.song.slug)));
    this.length = entries.length;
    this.count = entries.length;
    Object.freeze(this);
  }

  /** Clamp an occurrence position to this sequence; an empty sequence is -1. */
  clampIndex(index: number): number {
    return clampOccurrenceIndex(index, this.length);
  }

  previousIndex(index: number): number {
    return previousOccurrenceIndex(index, this.length);
  }

  nextIndex(index: number): number {
    return nextOccurrenceIndex(index, this.length);
  }

  previous(index: number): PerformanceEntry | null {
    return this.occurrenceAt(this.previousIndex(index));
  }

  next(index: number): PerformanceEntry | null {
    return this.occurrenceAt(this.nextIndex(index));
  }

  occurrenceAt(index: number): PerformanceEntry | null {
    const bounded = this.clampIndex(index);
    return bounded < 0 ? null : this.entries[bounded] ?? null;
  }

  entryAt(index: number): PerformanceEntry | null {
    return this.occurrenceAt(index);
  }
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function freezeObject<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }
  return unique;
}

function fail(code: PerformanceSetErrorCode, message: string, detail?: unknown): never {
  throw new PerformanceSetError(code, message, detail);
}

function isLibraryIndex(value: unknown): value is LibraryIndex {
  return value instanceof LibraryIndex || (
    value !== null && typeof value === "object" &&
    typeof (value as { songById?: unknown }).songById === "function" &&
    typeof (value as { setById?: unknown }).setById === "function"
  );
}

function isVerifiedSnapshot(value: unknown): value is VerifiedSnapshot {
  return value !== null && typeof value === "object" &&
    "documentsById" in value && "setLists" in value && "leadSheets" in value;
}

function isLibrarySet(value: unknown): value is LibrarySet {
  return value !== null && typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { path?: unknown }).path === "string" &&
    "document" in value;
}

function selectionText(selection: string | LibrarySet): string {
  return typeof selection === "string" ? selection : selection.id;
}

function makeLibrarySet(document: SetListDocument): LibrarySet {
  const metadata = document.projection.metadata;
  return freezeObject({
    id: document.id,
    path: document.path,
    slug: document.slug,
    title: document.projection.title,
    date: metadata.date,
    ...(metadata.datePrecision === undefined ? {} : { datePrecision: metadata.datePrecision }),
    location: metadata.location,
    ...(metadata.band === undefined ? {} : { band: metadata.band }),
    status: metadata.status,
    reviewRequired: metadata.reviewRequired,
    document,
  });
}

function resolveSetFromIndex(index: LibraryIndex, selection: string | LibrarySet): LibrarySet {
  const selected = typeof selection === "string"
    ? index.setById(selection) ?? index.setBySlug(selection)
    : index.setById(selection.id);
  if (selected === null || selected === undefined) {
    fail("SET_NOT_FOUND", `Set List ${selectionText(selection)} is not present in the LibraryIndex`, { selection: selectionText(selection) });
  }
  if (typeof selection !== "string" && (selected.path !== selection.path || selected.slug !== selection.slug || selected.document !== selection.document)) {
    fail("SET_IDENTITY_MISMATCH", `Set List ${selection.id} does not belong to the supplied LibraryIndex`, { expected: selected, actual: selection });
  }
  return selected;
}

function resolveSetFromSnapshot(snapshot: VerifiedSnapshot, selection: string | LibrarySet): LibrarySet {
  const selected = typeof selection === "string"
    ? snapshot.setLists.find((document) => document.id === selection || document.slug === selection)
    : snapshot.setLists.find((document) => document.id === selection.id);
  if (selected === undefined) {
    fail("SET_NOT_FOUND", `Set List ${selectionText(selection)} is not present in the VerifiedSnapshot`, { selection: selectionText(selection) });
  }
  if (typeof selection !== "string" && (selected.path !== selection.path || selected.slug !== selection.slug || selected !== selection.document)) {
    fail("SET_IDENTITY_MISMATCH", `Set List ${selection.id} does not belong to the supplied VerifiedSnapshot`, { expected: selected, actual: selection });
  }
  return typeof selection === "string" ? makeLibrarySet(selected) : selection;
}

function resolveSelectedSet(
  source: LibraryIndex | VerifiedSnapshot,
  selection: string | LibrarySet,
): LibrarySet {
  return isLibraryIndex(source) ? resolveSetFromIndex(source, selection) : resolveSetFromSnapshot(source, selection);
}

function assertSetIdentity(set: LibrarySet): SetListDocument {
  const document = set.document;
  if (
    document.kind !== "set-list" || document.id !== set.id || document.path !== set.path ||
    document.slug !== set.slug || document.projection.kind !== "set-list" ||
    document.projection.id !== set.id || document.projection.path !== set.path || document.projection.slug !== set.slug
  ) {
    fail("SET_IDENTITY_MISMATCH", `Set List ${set.id} has inconsistent document identity`, { set, document });
  }
  return document;
}

function freezeEntry(entry: SetEntryProjection): SetEntryProjection {
  return freezeObject({
    ...entry,
    ...(entry.singer === undefined ? {} : { singer: entry.singer }),
    ...(entry.note === undefined ? {} : { note: entry.note }),
  });
}

function freezeSection(section: SetSectionProjection): PerformanceSection {
  return freezeObject({
    projectionKey: section.projectionKey,
    identityScope: section.identityScope,
    setId: section.setId,
    ordinal: section.ordinal,
    ...(section.heading === undefined ? {} : { heading: section.heading }),
    columnBreakBefore: section.columnBreakBefore,
    entryIds: freezeArray(section.entryIds),
  });
}

function freezeFitResult(result: FitResult): FitResult {
  return freezeObject({
    ...result,
    columns: freezeArray(result.columns.map((column) => freezeObject({ ...column }))),
  });
}

function fitRecords(document: LeadSheetDocument): PerformanceFitRecords {
  if (document.fit === null || !Array.isArray(document.fit.profiles)) {
    fail("FIT_PROFILE_MISMATCH", `Lead sheet ${document.id} has no verified fit records`, { document: document.path });
  }
  const byProfile = new Map<PerformanceFitProfile, FitResult>();
  for (const profile of document.fit.profiles) {
    if (
      profile === null || typeof profile !== "object" ||
      (profile.profile !== "ipad-portrait" && profile.profile !== "ipad-landscape" && profile.profile !== "phone") ||
      !Array.isArray(profile.columns)
    ) {
      fail("FIT_PROFILE_MISMATCH", `Lead sheet ${document.id} contains a malformed fit record`, { document: document.path, profile });
    }
    if (byProfile.has(profile.profile)) {
      fail("FIT_PROFILE_MISMATCH", `Lead sheet ${document.id} has duplicate ${profile.profile} fit records`, { document: document.path });
    }
    byProfile.set(profile.profile, freezeFitResult(profile));
  }
  const portrait = byProfile.get("ipad-portrait");
  const landscape = byProfile.get("ipad-landscape");
  const phone = byProfile.get("phone");
  if (portrait === undefined || landscape === undefined || phone === undefined) {
    fail("FIT_PROFILE_MISMATCH", `Lead sheet ${document.id} does not have portrait, landscape, and phone fit records`, { document: document.path, profiles: [...byProfile.keys()] });
  }
  return freezeObject({ portrait, landscape, phone });
}

interface TargetResolver {
  readonly songById: (id: string) => LibrarySong | null;
  readonly documentById: (id: string) => LeadSheetDocument | null;
}

function resolverFor(source: LibraryIndex | VerifiedSnapshot): TargetResolver {
  if (isLibraryIndex(source)) {
    return {
      songById: (id) => source.songById(id),
      documentById: (id) => source.songById(id)?.document ?? null,
    };
  }
  const songsById = new Map(source.leadSheets.map((document) => [document.id, makeLibrarySong(document)] as const));
  return {
    songById: (id) => songsById.get(id) ?? null,
    documentById: (id) => {
      const document = source.documentsById.get(id);
      return document?.kind === "lead-sheet" ? document : null;
    },
  };
}

function makeLibrarySong(document: LeadSheetDocument): LibrarySong {
  const metadata = document.projection.metadata;
  return freezeObject({
    id: document.id,
    path: document.path,
    slug: document.slug,
    title: document.projection.title,
    artist: metadata.artist,
    ...(metadata.performanceKey === undefined ? {} : { performanceKey: metadata.performanceKey }),
    ...(metadata.originalKey === undefined ? {} : { originalKey: metadata.originalKey }),
    ...(metadata.bpm === undefined ? {} : { bpm: metadata.bpm }),
    ...(metadata.originalBpm === undefined ? {} : { originalBpm: metadata.originalBpm }),
    provenanceStatus: metadata.provenanceStatus,
    ...(metadata.sourceProvider === undefined ? {} : { sourceProvider: metadata.sourceProvider }),
    document,
  });
}

function assertEntryIdentity(entry: SetEntryProjection, set: SetListDocument, position: number): void {
  if (
    typeof entry.id !== "string" || entry.id === "" || typeof entry.ordinal !== "number" ||
    entry.ordinal !== position + 1 || typeof entry.sectionProjectionKey !== "string" ||
    typeof entry.targetLeadSheetId !== "string" || entry.targetLeadSheetId === "" ||
    typeof entry.targetPath !== "string" || entry.targetPath === ""
  ) {
    fail("ENTRY_IDENTITY_MISMATCH", `Set Entry at position ${position} has an invalid immutable identity or ordinal`, { entryId: entry.id, expectedOrdinal: position + 1, actualOrdinal: entry.ordinal });
  }
  if (entry.setId !== set.id) {
    fail("ENTRY_OWNERSHIP_MISMATCH", `Set Entry ${entry.id} does not belong to Set List ${set.id}`, { entrySetId: entry.setId, setId: set.id });
  }
}

function buildSections(set: SetListDocument): ReadonlyMap<string, PerformanceSection> {
  if (!Array.isArray(set.projection.sections) || !Array.isArray(set.projection.entries)) {
    fail("SECTION_IDENTITY_MISMATCH", `Set List ${set.id} has no valid projected sections or entries`, { setId: set.id });
  }
  const sections = new Map<string, PerformanceSection>();
  const sectionEntryIds = new Set<string>();
  for (const [position, section] of set.projection.sections.entries()) {
    if (
      typeof section.projectionKey !== "string" || section.projectionKey === "" ||
      !Array.isArray(section.entryIds) || typeof section.columnBreakBefore !== "boolean" ||
      section.identityScope !== "frozen-snapshot" || section.setId !== set.id ||
      section.ordinal !== position + 1 || sections.has(section.projectionKey)
    ) {
      fail("SECTION_IDENTITY_MISMATCH", `Set section ${section.projectionKey} has inconsistent immutable identity`, { section, setId: set.id });
    }
    for (const entryId of section.entryIds) {
      if (sectionEntryIds.has(entryId)) {
        fail("SECTION_ENTRY_COVERAGE_MISMATCH", `Set Entry ${entryId} belongs to more than one section`, { entryId, setId: set.id });
      }
      sectionEntryIds.add(entryId);
    }
    sections.set(section.projectionKey, freezeSection(section));
  }
  if (sectionEntryIds.size !== set.projection.entries.length) {
    fail("ENTRY_SECTION_COVERAGE_MISMATCH", `Set List ${set.id} sections do not cover every Set Entry occurrence exactly once`, { entries: set.projection.entries.length, sectionEntryIds: sectionEntryIds.size });
  }
  return sections;
}

function resolvePerformanceEntries(source: LibraryIndex | VerifiedSnapshot, set: LibrarySet): readonly PerformanceEntry[] {
  const document = assertSetIdentity(set);
  const sections = buildSections(document);
  const resolver = resolverFor(source);
  const seenEntryIds = new Set<string>();
  const entries: PerformanceEntry[] = [];

  for (const [position, rawEntry] of document.projection.entries.entries()) {
    assertEntryIdentity(rawEntry, document, position);
    if (seenEntryIds.has(rawEntry.id)) {
      fail("ENTRY_IDENTITY_MISMATCH", `Set Entry ${rawEntry.id} occurs more than once as an identity`, { setId: document.id, entryId: rawEntry.id });
    }
    seenEntryIds.add(rawEntry.id);

    const section = sections.get(rawEntry.sectionProjectionKey);
    if (section === undefined) {
      fail("ENTRY_SECTION_MISMATCH", `Set Entry ${rawEntry.id} references a section it does not own`, { setId: document.id, sectionProjectionKey: rawEntry.sectionProjectionKey });
    }
    const sectionOccurrenceCount = section.entryIds.filter((entryId) => entryId === rawEntry.id).length;
    if (section.setId !== document.id || sectionOccurrenceCount !== 1) {
      fail("SECTION_OWNERSHIP_MISMATCH", `Section ${section.projectionKey} does not own Set Entry ${rawEntry.id} exactly once`, { section, entryId: rawEntry.id });
    }

    const song = resolver.songById(rawEntry.targetLeadSheetId);
    if (song === null) {
      const target = isVerifiedSnapshot(source) ? source.documentsById.get(rawEntry.targetLeadSheetId) : null;
      if (target !== undefined && target !== null && target.kind !== "lead-sheet") {
        fail("TARGET_KIND_MISMATCH", `Set Entry ${rawEntry.id} targets ${target.kind}, not a lead sheet`, { entryId: rawEntry.id, targetLeadSheetId: rawEntry.targetLeadSheetId });
      }
      fail("TARGET_NOT_FOUND", `Set Entry ${rawEntry.id} target ${rawEntry.targetLeadSheetId} is not present`, { entryId: rawEntry.id, targetLeadSheetId: rawEntry.targetLeadSheetId });
    }
    const leadSheet = resolver.documentById(rawEntry.targetLeadSheetId);
    if (leadSheet === null || leadSheet.kind !== "lead-sheet") {
      fail("TARGET_KIND_MISMATCH", `Set Entry ${rawEntry.id} target ${rawEntry.targetLeadSheetId} is not a lead sheet`, { entryId: rawEntry.id, targetLeadSheetId: rawEntry.targetLeadSheetId });
    }
    if (song.id !== rawEntry.targetLeadSheetId || leadSheet.id !== rawEntry.targetLeadSheetId || song.document !== leadSheet) {
      fail("TARGET_IDENTITY_MISMATCH", `Set Entry ${rawEntry.id} target identity is not bound to targetLeadSheetId`, { entryId: rawEntry.id, targetLeadSheetId: rawEntry.targetLeadSheetId });
    }
    if (song.path !== rawEntry.targetPath || leadSheet.path !== rawEntry.targetPath || leadSheet.projection.path !== rawEntry.targetPath) {
      fail("TARGET_PATH_MISMATCH", `Set Entry ${rawEntry.id} target path does not match the resolved lead sheet`, { entryId: rawEntry.id, expectedPath: rawEntry.targetPath, actualPath: leadSheet.path });
    }
    const fit = fitRecords(leadSheet);
    const warning = fit.landscape.status === "needs-editing" ? "landscape-needs-editing" : null;
    entries.push(new PerformanceEntry({
      entry: freezeEntry(rawEntry),
      section,
      song,
      leadSheet,
      fit,
      warning,
    }));
  }

  if (seenEntryIds.size !== document.projection.entries.length) {
    fail("ENTRY_IDENTITY_MISMATCH", `Set List ${document.id} does not retain one identity for every occurrence`, { setId: document.id });
  }
  return freezeArray(entries);
}

export type PerformanceSetSource = LibraryIndex | VerifiedSnapshot;
export type PerformanceSetSelection = LibrarySet | string;

export function buildPerformanceSet(source: LibraryIndex, selection: PerformanceSetSelection): PerformanceSet;
export function buildPerformanceSet(source: VerifiedSnapshot, selection: PerformanceSetSelection): PerformanceSet;
export function buildPerformanceSet(source: LibrarySet, resolver: LibraryIndex | VerifiedSnapshot): PerformanceSet;
export function buildPerformanceSet(
  source: PerformanceSetSource | LibrarySet,
  selection: PerformanceSetSelection | PerformanceSetSource,
): PerformanceSet {
  let resolvedSource: PerformanceSetSource;
  let resolvedSelection: PerformanceSetSelection;
  if (isLibrarySet(source) && (isLibraryIndex(selection) || isVerifiedSnapshot(selection))) {
    resolvedSource = selection;
    resolvedSelection = source;
  } else if ((isLibraryIndex(source) || isVerifiedSnapshot(source)) && (typeof selection === "string" || isLibrarySet(selection))) {
    resolvedSource = source;
    resolvedSelection = selection;
  } else {
    fail("INVALID_SOURCE", "PerformanceSet requires a LibraryIndex or VerifiedSnapshot and a LibrarySet, ID, or slug", { source, selection });
  }

  try {
    const set = resolveSelectedSet(resolvedSource, resolvedSelection);
    const entries = resolvePerformanceEntries(resolvedSource, set);
    return new PerformanceSet(set, entries);
  } catch (error) {
    if (error instanceof PerformanceSetError) throw error;
    fail("INVALID_SOURCE", "The supplied verified Set List shape cannot be resolved safely", { cause: error });
  }
}

/** Explicit alias for callers that describe construction as reference resolution. */
export const resolvePerformanceSet = buildPerformanceSet;

export function buildPerformanceSetFromSnapshot(snapshot: VerifiedSnapshot, selection: PerformanceSetSelection): PerformanceSet {
  return buildPerformanceSet(snapshot, selection);
}

/** Clamp an arbitrary occurrence position to [0, count - 1], or -1 when empty. */
export function clampOccurrenceIndex(index: number, count: number): number {
  if (!Number.isFinite(count) || count <= 0) return -1;
  const upper = Math.max(0, Math.ceil(count) - 1);
  if (!Number.isFinite(index)) return index === Number.POSITIVE_INFINITY ? upper : 0;
  return Math.min(upper, Math.max(0, Math.trunc(index)));
}

/** Return the bounded previous occurrence index for a sequence of `count` items. */
export function previousOccurrenceIndex(index: number, count: number): number {
  const bounded = clampOccurrenceIndex(index, count);
  return bounded < 0 ? -1 : Math.max(0, bounded - 1);
}

/** Return the bounded next occurrence index for a sequence of `count` items. */
export function nextOccurrenceIndex(index: number, count: number): number {
  const bounded = clampOccurrenceIndex(index, count);
  return bounded < 0 ? -1 : Math.min(Math.max(0, Math.ceil(count) - 1), bounded + 1);
}

export const clampPerformanceIndex = clampOccurrenceIndex;
export const previousPerformanceIndex = previousOccurrenceIndex;
export const nextPerformanceIndex = nextOccurrenceIndex;
export const previousIndex = previousOccurrenceIndex;
export const nextIndex = nextOccurrenceIndex;

export function previousOccurrence(performanceSet: PerformanceSet, index: number): PerformanceEntry | null {
  return performanceSet.previous(index);
}

export function nextOccurrence(performanceSet: PerformanceSet, index: number): PerformanceEntry | null {
  return performanceSet.next(index);
}
