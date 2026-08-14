/**
 * Writable Set List domain model. IDs are immutable application identity;
 * labels, paths, positions, and filenames are not identity.
 */

export const SET_LIST_SCHEMA_VERSION = "songs-v2-set-list-1" as const;

export type SetListId = string & { readonly __setListId: unique symbol };
export type SetSectionId = string & { readonly __setSectionId: unique symbol };
export type SetEntryId = string & { readonly __setEntryId: unique symbol };
export type LeadSheetId = string & { readonly __leadSheetId: unique symbol };
export type LocalRevisionId = string & { readonly __localRevisionId: unique symbol };
export type OperationId = string & { readonly __operationId: unique symbol };

export type StableId = SetListId | SetSectionId | SetEntryId | LeadSheetId | LocalRevisionId | OperationId;

export type SetListErrorCode =
  | "INVALID_ID"
  | "INVALID_FIELD"
  | "INVALID_PATH"
  | "DUPLICATE_ID"
  | "SECTION_NOT_FOUND"
  | "ENTRY_NOT_FOUND"
  | "INVALID_POSITION"
  | "INVALID_COMMAND"
  | "NO_CHANGE"
  | "UNDO_UNAVAILABLE"
  | "CODEC_INVALID";

export class SetListError extends Error {
  constructor(readonly code: SetListErrorCode, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "SetListError";
  }
}

export interface SetListEntry {
  readonly id: SetEntryId;
  readonly leadSheetId: LeadSheetId;
  /** Canonical repository-relative target, e.g. songs/Rebel-Yell.md. */
  readonly targetPath: string;
  readonly label: string;
  readonly note: string;
  readonly singer: string;
  readonly columnBreakBefore: boolean;
}

export interface SetListSection {
  readonly id: SetSectionId;
  readonly heading: string;
  readonly columnBreakBefore: boolean;
  readonly entries: readonly SetListEntry[];
}

export interface SetList {
  readonly schemaVersion: typeof SET_LIST_SCHEMA_VERSION;
  readonly id: SetListId;
  /** Canonical repository-relative publication path below sets/. */
  readonly path: string;
  readonly title: string;
  readonly date: string;
  readonly location: string;
  readonly band: string;
  readonly sections: readonly SetListSection[];
}

export interface NewSetListEntry {
  readonly id: string;
  readonly leadSheetId: string;
  readonly targetPath: string;
  readonly label: string;
  readonly note?: string;
  readonly singer?: string;
  readonly columnBreakBefore?: boolean;
}

export interface NewSetListSection {
  readonly id: string;
  readonly heading: string;
  readonly columnBreakBefore?: boolean;
  readonly entries?: readonly NewSetListEntry[];
}

export interface NewSetList {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly date?: string;
  readonly location?: string;
  readonly band?: string;
  readonly sections: readonly NewSetListSection[];
}

const STABLE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SET_PATH_RE = /^sets\/[A-Za-z0-9][A-Za-z0-9'_\-]*\.md$/;
const SONG_PATH_RE = /^songs\/[A-Za-z0-9][A-Za-z0-9'_\-]*\.md$/;
const DATE_RE = /^(?:|\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?)$/;

function fail(code: SetListErrorCode, message: string, detail?: unknown): never {
  throw new SetListError(code, message, detail);
}

export function isStableId(value: unknown): value is string {
  return typeof value === "string" && STABLE_ID_RE.test(value) && !value.includes("--");
}

export function requireStableId<T extends StableId>(value: string, label = "ID"): T {
  if (!isStableId(value)) fail("INVALID_ID", `${label} must be a stable lowercase ID`, { value });
  return value as T;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function requireString(value: unknown, label: string, maximum: number, options: { readonly empty?: boolean } = {}): string {
  if (
    typeof value !== "string" || new TextEncoder().encode(value).byteLength > maximum || value.includes("\0")
    || /[\r\n]/.test(value) || hasUnpairedSurrogate(value)
  ) {
    fail("INVALID_FIELD", `${label} must be bounded single-line UTF-8 text`, { value });
  }
  if (value.trim() !== value || (!options.empty && value.length === 0)) {
    fail("INVALID_FIELD", `${label} must not have surrounding whitespace${options.empty ? "" : " and must not be empty"}`, { value });
  }
  return value;
}

function validCalendarDate(value: string): boolean {
  if (value === "" || value.length < 10) return true;
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function requireSetListPath(value: string): string {
  if (!SET_PATH_RE.test(value)) fail("INVALID_PATH", "Set List path must be one safe Markdown file below sets/", { value });
  return value;
}

export function requireLeadSheetPath(value: string): string {
  if (!SONG_PATH_RE.test(value)) fail("INVALID_PATH", "Lead-sheet target must be one safe Markdown file below songs/", { value });
  return value;
}

export function requireSetListDate(value: string): string {
  if (!DATE_RE.test(value) || !validCalendarDate(value)) fail("INVALID_FIELD", "Set List date must be empty or a real YYYY, YYYY-MM, or YYYY-MM-DD date", { value });
  return value;
}

function freezeEntry(input: NewSetListEntry | SetListEntry): SetListEntry {
  if (input.columnBreakBefore !== undefined && typeof input.columnBreakBefore !== "boolean") {
    fail("INVALID_FIELD", "Set Entry columnBreakBefore must be boolean");
  }
  const singer = requireString(input.singer ?? "", "Set Entry singer", 512, { empty: true });
  if (singer.includes(" — note: ")) fail("INVALID_FIELD", "Set Entry singer contains the canonical note delimiter");
  return Object.freeze({
    id: requireStableId<SetEntryId>(input.id, "Set Entry ID"),
    leadSheetId: requireStableId<LeadSheetId>(input.leadSheetId, "Lead-sheet ID"),
    targetPath: requireLeadSheetPath(input.targetPath),
    label: requireString(input.label, "Set Entry label", 512),
    note: requireString(input.note ?? "", "Set Entry note", 4096, { empty: true }),
    singer,
    columnBreakBefore: input.columnBreakBefore ?? false,
  });
}

function freezeSection(input: NewSetListSection | SetListSection): SetListSection {
  if (typeof input.columnBreakBefore !== "undefined" && typeof input.columnBreakBefore !== "boolean") {
    fail("INVALID_FIELD", "Set section columnBreakBefore must be boolean");
  }
  const entries = input.entries?.map(freezeEntry) ?? [];
  return Object.freeze({
    id: requireStableId<SetSectionId>(input.id, "Set section ID"),
    heading: requireString(input.heading, "Set section heading", 512),
    columnBreakBefore: input.columnBreakBefore ?? false,
    entries: Object.freeze(entries),
  });
}

export function validateSetListEntry(input: NewSetListEntry | SetListEntry): SetListEntry {
  return freezeEntry(input);
}

export function validateSetListSection(input: NewSetListSection | SetListSection): SetListSection {
  return freezeSection(input);
}

/** Validate, detach, and deeply freeze one Set List at the domain boundary. */
export function validateSetList(input: NewSetList | SetList): SetList {
  if (!Array.isArray(input.sections) || input.sections.length === 0 || input.sections.length > 100) {
    fail("INVALID_FIELD", "A Set List must contain between 1 and 100 sections");
  }
  const sections = input.sections.map(freezeSection);
  const sectionIds = new Set<string>();
  const entryIds = new Set<string>();
  let entryCount = 0;
  for (const section of sections) {
    if (sectionIds.has(section.id)) fail("DUPLICATE_ID", "Set section IDs must be unique", { id: section.id });
    sectionIds.add(section.id);
    for (const entry of section.entries) {
      entryCount++;
      if (entryCount > 2_000) fail("INVALID_FIELD", "A Set List cannot contain more than 2,000 entries");
      if (entryIds.has(entry.id)) fail("DUPLICATE_ID", "Set Entry IDs must be unique across the Set List", { id: entry.id });
      entryIds.add(entry.id);
    }
  }
  const date = requireSetListDate(input.date ?? "");
  return Object.freeze({
    schemaVersion: SET_LIST_SCHEMA_VERSION,
    id: requireStableId<SetListId>(input.id, "Set List ID"),
    path: requireSetListPath(input.path),
    title: requireString(input.title, "Set List title", 512),
    date,
    location: requireString(input.location ?? "", "Set List location", 512, { empty: true }),
    band: requireString(input.band ?? "", "Set List band", 512, { empty: true }),
    sections: Object.freeze(sections),
  });
}

export function createSetList(input: NewSetList): SetList {
  return validateSetList(input);
}

export function entryCount(setList: SetList): number {
  return setList.sections.reduce((sum, section) => sum + section.entries.length, 0);
}

export function locateEntry(setList: SetList, entryId: string): Readonly<{ sectionIndex: number; entryIndex: number; section: SetListSection; entry: SetListEntry }> {
  for (const [sectionIndex, section] of setList.sections.entries()) {
    const entryIndex = section.entries.findIndex((entry) => entry.id === entryId);
    if (entryIndex >= 0) return Object.freeze({ sectionIndex, entryIndex, section, entry: section.entries[entryIndex]! });
  }
  fail("ENTRY_NOT_FOUND", `Set Entry ${entryId} does not exist`, { entryId });
}

export function locateSection(setList: SetList, sectionId: string): Readonly<{ sectionIndex: number; section: SetListSection }> {
  const sectionIndex = setList.sections.findIndex((section) => section.id === sectionId);
  if (sectionIndex < 0) fail("SECTION_NOT_FOUND", `Set section ${sectionId} does not exist`, { sectionId });
  return Object.freeze({ sectionIndex, section: setList.sections[sectionIndex]! });
}

/**
 * Generate a server-valid stable ID from 128 bits of browser entropy. Tests and
 * deterministic importers should pass their own RandomSource.
 */
export interface RandomSource {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
}

export function randomStableId(prefix: "set" | "section" | "entry" | "revision" | "operation", random: RandomSource = globalThis.crypto): string {
  if (random === undefined || typeof random.getRandomValues !== "function") fail("INVALID_ID", "Cryptographic random ID generation is unavailable");
  const bytes = random.getRandomValues(new Uint8Array(16));
  const suffix = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return requireStableId(`${prefix}-${suffix}`);
}
