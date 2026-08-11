import type { LeadSheetDocument, SetListDocument, VerifiedSnapshot } from "../bootstrap/types";
import { CURRENT_LIBRARY_CONTRACT, assertLibrarySnapshotContract, parseFrozenDate } from "./contracts";

export { CURRENT_LIBRARY_CONTRACT, LibraryIndexError, assertCurrentLibraryContract, assertLibrarySnapshotContract, assertVerifiedLibraryShape, parseFrozenDate } from "./contracts";
export type { CurrentLibraryContract, LibraryIndexErrorCode } from "./contracts";

export type SongSearchField =
  | "title"
  | "artist"
  | "slug"
  | "performanceKey"
  | "originalKey"
  | "bpm"
  | "originalBpm"
  | "provenanceStatus"
  | "sourceProvider";

export type SetSearchField = "title" | "slug" | "date" | "location" | "band" | "status";

export interface LibrarySong {
  readonly id: string;
  readonly path: string;
  readonly slug: string;
  /** Exact reviewed projection text; it is never search-normalized in this model. */
  readonly title: string;
  readonly artist: string;
  readonly performanceKey?: string;
  readonly originalKey?: string;
  readonly bpm?: string;
  readonly originalBpm?: string;
  readonly provenanceStatus: string;
  readonly sourceProvider?: string;
  readonly document: LeadSheetDocument;
}

export interface LibrarySet {
  readonly id: string;
  readonly path: string;
  readonly slug: string;
  /** Exact reviewed projection text; it is never search-normalized in this model. */
  readonly title: string;
  readonly date: string;
  readonly datePrecision?: string;
  readonly location: string;
  readonly band?: string;
  readonly status: string;
  readonly reviewRequired: boolean;
  readonly document: SetListDocument;
}

export interface SongSearchResult {
  readonly song: LibrarySong;
  readonly score: number;
  readonly matchedFields: readonly SongSearchField[];
}

export interface SetSearchResult {
  readonly set: LibrarySet;
  readonly score: number;
  readonly matchedFields: readonly SetSearchField[];
}

export interface ActiveSetSelection {
  readonly set: LibrarySet | null;
  readonly reason: "reviewed-pin" | "latest-date" | "none";
  readonly configuredSetId: string | null;
}

export interface LibrarySearchResults {
  readonly query: string;
  readonly songs: readonly SongSearchResult[];
  readonly sets: readonly SetSearchResult[];
}

export interface FitDistribution {
  readonly total: number;
  readonly fit: number;
  readonly needsEditing: number;
  readonly scrollable: number;
}

export interface LibraryDiagnostics {
  readonly generation: string;
  readonly frozenDate: string;
  readonly sourceRef: string;
  readonly sourceCommit: string;
  readonly routeCount: number;
  readonly documents: { readonly total: number; readonly songs: number; readonly sets: number };
  readonly references: { readonly total: number; readonly resolved: number; readonly unresolved: number };
  readonly landscapeWarningSlugs: readonly string[];
  readonly fit: {
    readonly portrait: FitDistribution;
    readonly landscape: FitDistribution;
    readonly phone: FitDistribution;
  };
  readonly contractKind: "current-exact" | "reviewed-predecessor";
  /** Exact frozen-v1 paths contractually absent from the current catalog only. */
  readonly excludedDeletedSetPaths: readonly string[];
}

type SearchFieldMap<Field extends string> = Readonly<Record<Field, string>>;

interface Searchable<Item, Field extends string> {
  readonly item: Item;
  readonly fields: SearchFieldMap<Field>;
}

const SONG_FIELDS: readonly SongSearchField[] = Object.freeze([
  "title",
  "artist",
  "slug",
  "performanceKey",
  "originalKey",
  "bpm",
  "originalBpm",
  "provenanceStatus",
  "sourceProvider",
]);

const SET_FIELDS: readonly SetSearchField[] = Object.freeze(["title", "slug", "date", "location", "band", "status"]);

const SONG_FIELD_WEIGHT: Readonly<Record<SongSearchField, number>> = Object.freeze({
  title: 900,
  artist: 800,
  slug: 700,
  performanceKey: 600,
  originalKey: 550,
  bpm: 500,
  originalBpm: 450,
  provenanceStatus: 400,
  sourceProvider: 350,
});

const SET_FIELD_WEIGHT: Readonly<Record<SetSearchField, number>> = Object.freeze({
  title: 900,
  slug: 800,
  date: 700,
  location: 600,
  band: 500,
  status: 400,
});

function frozenArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function frozenObject<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

/** Stable Unicode code-point ordering, without locale or host-language collation. */
export function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]!.codePointAt(0)!;
    const rightPoint = rightPoints[index]!.codePointAt(0)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  return leftPoints.length < rightPoints.length ? -1 : 1;
}

function compareValues(...values: readonly [string, string][]): number {
  for (const [left, right] of values) {
    const comparison = compareCodePoints(left, right);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function compareSongs(left: LibrarySong, right: LibrarySong): number {
  return compareValues(
    [left.title, right.title],
    [left.artist, right.artist],
    [left.slug, right.slug],
    [left.path, right.path],
    [left.id, right.id],
  );
}

function compareSets(left: LibrarySet, right: LibrarySet): number {
  return compareValues([left.title, right.title], [left.slug, right.slug], [left.path, right.path], [left.id, right.id]);
}

function compareRecentSets(left: LibrarySet, right: LibrarySet): number {
  if (left.date !== right.date) return left.date > right.date ? -1 : 1;
  return compareValues([left.path, right.path], [left.id, right.id]);
}

/**
 * Canonicalizes text only while comparing query terms.  Catalog identity and
 * displayed metadata stay exactly as the verified projection supplied them.
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[&]/gu, " and ")
    .replace(/[♯#]/gu, " sharp ")
    .replace(/[♭]/gu, " flat ")
    .replace(/[’'ʼ]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function queryTokens(query: string): readonly string[] {
  const normalized = normalizeSearchText(query);
  if (normalized === "") return frozenArray([]);
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of normalized.split(" ")) {
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }
  return frozenArray(tokens);
}

function normalizedFields<Field extends string>(values: Readonly<Record<Field, string>>): SearchFieldMap<Field> {
  const normalized = {} as Record<Field, string>;
  for (const field of Object.keys(values) as Field[]) normalized[field] = normalizeSearchText(values[field]);
  return frozenObject(normalized);
}

function makeSong(document: LeadSheetDocument): LibrarySong {
  const metadata = document.projection.metadata;
  return frozenObject({
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

function makeSet(document: SetListDocument): LibrarySet {
  const metadata = document.projection.metadata;
  return frozenObject({
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

function musicalKeySearch(value: string | undefined): string {
  if (value === undefined) return "";
  const normalized = value.normalize("NFKC").trim();
  const match = /^([A-Ga-g])([#♯b♭]?)(m?)$/.exec(normalized);
  if (match === null) return value;
  const note = match[1]!.toLowerCase();
  const accidental = match[2] === "#" || match[2] === "♯" ? "sharp" : match[2] === "b" || match[2] === "♭" ? "flat" : "";
  const minor = match[3] === "m" ? "minor" : "major";
  return [value, note, accidental, `${note}${accidental}`, minor].filter(Boolean).join(" ");
}

function songSearchable(song: LibrarySong): Searchable<LibrarySong, SongSearchField> {
  return frozenObject({
    item: song,
    fields: normalizedFields({
      title: song.title,
      artist: song.artist,
      slug: song.slug,
      performanceKey: musicalKeySearch(song.performanceKey),
      originalKey: musicalKeySearch(song.originalKey),
      bpm: song.bpm ?? "",
      originalBpm: song.originalBpm ?? "",
      provenanceStatus: song.provenanceStatus,
      sourceProvider: song.sourceProvider ?? "",
    }),
  });
}

function setSearchable(set: LibrarySet): Searchable<LibrarySet, SetSearchField> {
  return frozenObject({
    item: set,
    fields: normalizedFields({
      title: set.title,
      slug: set.slug,
      date: set.date,
      location: set.location,
      band: set.band ?? "",
      status: set.status,
    }),
  });
}

function distribution(): { total: number; fit: number; needsEditing: number; scrollable: number } {
  return { total: 0, fit: 0, needsEditing: 0, scrollable: 0 };
}

function makeDiagnostics(snapshot: VerifiedSnapshot): LibraryDiagnostics {
  const portrait = distribution();
  const landscape = distribution();
  const phone = distribution();
  const warningSlugs: string[] = [];
  let entries = 0;
  let resolved = 0;

  for (const set of snapshot.setLists) {
    entries += set.projection.entries.length;
    resolved += set.projection.entries.length;
  }
  for (const song of snapshot.leadSheets) {
    for (const result of song.fit!.profiles) {
      const target = result.profile === "ipad-portrait" ? portrait : result.profile === "ipad-landscape" ? landscape : phone;
      target.total += 1;
      if (result.status === "fit") target.fit += 1;
      else if (result.status === "needs-editing") {
        target.needsEditing += 1;
        if (result.profile === "ipad-landscape") warningSlugs.push(snapshot.songRouteById.get(song.id)!.slug);
      } else target.scrollable += 1;
    }
  }

  return frozenObject({
    generation: snapshot.manifest.generation,
    frozenDate: parseFrozenDate(snapshot.manifest.source_baseline.ref),
    sourceRef: snapshot.manifest.source_baseline.ref,
    sourceCommit: snapshot.manifest.source_baseline.commit,
    routeCount: snapshot.routeByKey.size,
    documents: frozenObject({ total: snapshot.documents.length, songs: snapshot.leadSheets.length, sets: snapshot.setLists.length }),
    references: frozenObject({ total: entries, resolved, unresolved: entries - resolved }),
    landscapeWarningSlugs: frozenArray(warningSlugs.sort(compareCodePoints)),
    fit: frozenObject({
      portrait: frozenObject(portrait),
      landscape: frozenObject(landscape),
      phone: frozenObject(phone),
    }),
    contractKind: snapshot.manifest.generation === CURRENT_LIBRARY_CONTRACT.generation ? "current-exact" : "reviewed-predecessor",
    excludedDeletedSetPaths: snapshot.manifest.generation === CURRENT_LIBRARY_CONTRACT.generation ? frozenArray(CURRENT_LIBRARY_CONTRACT.deletedSetPaths) : frozenArray([]),
  });
}

function emptySongResult(song: LibrarySong): SongSearchResult {
  return frozenObject({ song, score: 0, matchedFields: frozenArray([]) });
}

function emptySetResult(set: LibrarySet): SetSearchResult {
  return frozenObject({ set, score: 0, matchedFields: frozenArray([]) });
}

function rank<Item, Field extends string>(
  index: readonly Searchable<Item, Field>[],
  tokens: readonly string[],
  fieldOrder: readonly Field[],
  weights: Readonly<Record<Field, number>>,
  compareItems: (left: Item, right: Item) => number,
): readonly { readonly item: Item; readonly score: number; readonly matchedFields: readonly Field[] }[] {
  const matched: { item: Item; score: number; matchedFields: readonly Field[] }[] = [];
  for (const candidate of index) {
    const matchedFields = fieldOrder.filter((field) => tokens.some((token) => candidate.fields[field].includes(token)));
    if (!tokens.every((token) => fieldOrder.some((field) => candidate.fields[field].includes(token)))) continue;
    let score = 0;
    for (const token of tokens) {
      let tokenScore = 0;
      for (const field of fieldOrder) {
        if (candidate.fields[field].includes(token)) tokenScore = Math.max(tokenScore, weights[field]);
      }
      score += tokenScore;
    }
    matched.push(frozenObject({ item: candidate.item, score, matchedFields: frozenArray(matchedFields) }));
  }
  matched.sort((left, right) => right.score - left.score || compareItems(left.item, right.item));
  return frozenArray(matched);
}

/**
 * A pure, immutable library view over one fully verified active snapshot.
 * Constructing it never fetches, persists, or changes the snapshot.
 */
export class LibraryIndex {
  readonly songs: readonly LibrarySong[];
  readonly sets: readonly LibrarySet[];
  readonly recentSets: readonly LibrarySet[];
  readonly diagnostics: LibraryDiagnostics;
  #songsById: ReadonlyMap<string, LibrarySong>;
  #songsBySlug: ReadonlyMap<string, LibrarySong>;
  #setsById: ReadonlyMap<string, LibrarySet>;
  #setsBySlug: ReadonlyMap<string, LibrarySet>;
  #songSearch: readonly Searchable<LibrarySong, SongSearchField>[];
  #setSearch: readonly Searchable<LibrarySet, SetSearchField>[];

  constructor(snapshot: VerifiedSnapshot) {
    assertLibrarySnapshotContract(snapshot);

    const songs = snapshot.leadSheets.map(makeSong).sort(compareSongs);
    const sets = snapshot.setLists.map(makeSet).sort(compareSets);
    this.songs = frozenArray(songs);
    this.sets = frozenArray(sets);
    this.recentSets = frozenArray([...sets].sort(compareRecentSets));
    this.diagnostics = makeDiagnostics(snapshot);
    this.#songsById = new Map(songs.map((song) => [song.id, song]));
    this.#songsBySlug = new Map(songs.map((song) => [song.slug, song]));
    this.#setsById = new Map(sets.map((set) => [set.id, set]));
    this.#setsBySlug = new Map(sets.map((set) => [set.slug, set]));
    this.#songSearch = frozenArray(songs.map(songSearchable));
    this.#setSearch = frozenArray(sets.map(setSearchable));
    Object.freeze(this);
  }

  static fromSnapshot(snapshot: VerifiedSnapshot): LibraryIndex {
    return new LibraryIndex(snapshot);
  }

  songById(id: string): LibrarySong | null {
    return this.#songsById.get(id) ?? null;
  }

  songBySlug(slug: string): LibrarySong | null {
    return this.#songsBySlug.get(slug) ?? null;
  }

  setById(id: string): LibrarySet | null {
    return this.#setsById.get(id) ?? null;
  }

  setBySlug(slug: string): LibrarySet | null {
    return this.#setsBySlug.get(slug) ?? null;
  }

  activeSetSelection(configuredSetId: string | null): ActiveSetSelection {
    if (configuredSetId !== null) {
      const configured = this.setById(configuredSetId);
      if (configured !== null) return frozenObject({ set: configured, reason: "reviewed-pin", configuredSetId });
    }
    const latest = this.recentSets[0] ?? null;
    return frozenObject({ set: latest, reason: latest === null ? "none" : "latest-date", configuredSetId });
  }

  /** A configured ID wins; an explicit null picks the most recent dated Set List. */
  selectPinnedSet(configuredSetId: string | null): LibrarySet | null {
    return configuredSetId === null ? this.recentSets[0] ?? null : this.setById(configuredSetId);
  }

  /** Alias for dashboard callers that describe the chosen Set List as active. */
  selectActiveSet(configuredSetId: string | null): LibrarySet | null {
    return this.selectPinnedSet(configuredSetId);
  }

  searchSongs(query: string): readonly SongSearchResult[] {
    const tokens = queryTokens(query);
    if (tokens.length === 0) return frozenArray(this.songs.map(emptySongResult));
    return frozenArray(rank(this.#songSearch, tokens, SONG_FIELDS, SONG_FIELD_WEIGHT, compareSongs).map((result) => frozenObject({
      song: result.item,
      score: result.score,
      matchedFields: result.matchedFields,
    })));
  }

  searchSets(query: string): readonly SetSearchResult[] {
    const tokens = queryTokens(query);
    if (tokens.length === 0) return frozenArray(this.sets.map(emptySetResult));
    return frozenArray(rank(this.#setSearch, tokens, SET_FIELDS, SET_FIELD_WEIGHT, compareSets).map((result) => frozenObject({
      set: result.item,
      score: result.score,
      matchedFields: result.matchedFields,
    })));
  }

  search(query: string): LibrarySearchResults {
    return frozenObject({ query, songs: this.searchSongs(query), sets: this.searchSets(query) });
  }
}

/** Preferred React-facing construction API. */
export function buildLibraryIndex(snapshot: VerifiedSnapshot): LibraryIndex {
  return LibraryIndex.fromSnapshot(snapshot);
}
