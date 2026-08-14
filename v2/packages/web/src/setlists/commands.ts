import {
  type LocalRevisionId,
  type NewSetListEntry,
  type OperationId,
  type SetEntryId,
  type SetList,
  SetListError,
  type SetListId,
  type SetListSection,
  type SetSectionId,
  locateEntry,
  locateSection,
  requireStableId,
  validateSetList,
  validateSetListEntry,
  validateSetListSection,
} from "./model";

export const SET_LIST_REVISION_SCHEMA_VERSION = "songs-v2-set-list-revision-1" as const;

export interface CreateSetListCommand { readonly kind: "create-set-list"; readonly document: SetList }
export interface DuplicateSetListCommand { readonly kind: "duplicate-set-list"; readonly sourceDocumentId: SetListId; readonly document: SetList }
export interface UpdateDetailsCommand { readonly kind: "update-details"; readonly title?: string; readonly date?: string; readonly location?: string; readonly band?: string }
export interface AddEntryCommand { readonly kind: "add-entry"; readonly sectionId: SetSectionId; readonly entry: NewSetListEntry; readonly beforeEntryId?: SetEntryId }
export interface RemoveEntryCommand { readonly kind: "remove-entry"; readonly entryId: SetEntryId }
export interface MoveEntryCommand { readonly kind: "move-entry"; readonly entryId: SetEntryId; readonly toSectionId: SetSectionId; readonly beforeEntryId?: SetEntryId }
export interface UpdateEntryNoteCommand { readonly kind: "update-entry-note"; readonly entryId: SetEntryId; readonly note: string }
export interface AddSectionCommand { readonly kind: "add-section"; readonly section: SetListSection; readonly beforeSectionId?: SetSectionId }
export interface RemoveSectionCommand { readonly kind: "remove-section"; readonly sectionId: SetSectionId }
export interface UpdateSectionHeadingCommand { readonly kind: "update-section-heading"; readonly sectionId: SetSectionId; readonly heading: string }
export interface MoveSectionCommand { readonly kind: "move-section"; readonly sectionId: SetSectionId; readonly beforeSectionId?: SetSectionId }
export interface RestoreSnapshotCommand { readonly kind: "restore-snapshot"; readonly document: SetList; readonly undoOfRevisionId?: LocalRevisionId }

export type SetListCommand =
  | CreateSetListCommand
  | DuplicateSetListCommand
  | UpdateDetailsCommand
  | AddEntryCommand
  | RemoveEntryCommand
  | MoveEntryCommand
  | UpdateEntryNoteCommand
  | AddSectionCommand
  | RemoveSectionCommand
  | UpdateSectionHeadingCommand
  | MoveSectionCommand
  | RestoreSnapshotCommand;

export interface SetListRevision {
  readonly schemaVersion: typeof SET_LIST_REVISION_SCHEMA_VERSION;
  readonly id: LocalRevisionId;
  readonly documentId: SetListId;
  readonly parentRevisionId: LocalRevisionId | null;
  readonly operationId: OperationId;
  readonly operationKind: string;
  readonly command: SetListCommand;
  /** Exact inverse snapshot. Applying it creates another forward revision. */
  readonly inverse: RestoreSnapshotCommand | null;
  readonly document: SetList;
}

export interface RevisionIdentity {
  readonly revisionId: string;
  readonly operationId: string;
}

function commandObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INVALID_COMMAND", "Set List command must be an object");
  return value as Record<string, unknown>;
}

function exactCommandKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) {
    fail("INVALID_COMMAND", "Set List command has unknown or missing fields", { actual: Object.keys(value), required, optional });
  }
}

function stableCommandId<T extends SetListId | SetSectionId | SetEntryId | LocalRevisionId>(value: unknown, label: string): T {
  if (typeof value !== "string") fail("INVALID_COMMAND", `${label} must be a stable ID`);
  return requireStableId<T>(value, label);
}

function validatedDetails(value: Record<string, unknown>): Pick<SetList, "title" | "date" | "location" | "band"> {
  return validateSetList({
    id: "set-command-validation",
    path: "sets/Command-Validation.md",
    title: typeof value.title === "string" ? value.title : "Validation",
    date: typeof value.date === "string" ? value.date : "",
    location: typeof value.location === "string" ? value.location : "",
    band: typeof value.band === "string" ? value.band : "",
    sections: [{ id: "section-command-validation", heading: "Set One" }],
  });
}

/** Parse, detach, and deeply freeze a command before it enters revision history. */
export function validateSetListCommand(value: unknown): SetListCommand {
  const object = commandObject(value);
  const kind = object.kind;
  switch (kind) {
    case "create-set-list":
      exactCommandKeys(object, ["kind", "document"]);
      return Object.freeze({ kind, document: validateSetList(object.document as SetList) });
    case "duplicate-set-list":
      exactCommandKeys(object, ["kind", "sourceDocumentId", "document"]);
      return Object.freeze({ kind, sourceDocumentId: stableCommandId<SetListId>(object.sourceDocumentId, "Source Set List ID"), document: validateSetList(object.document as SetList) });
    case "update-details": {
      exactCommandKeys(object, ["kind"], ["title", "date", "location", "band"]);
      if (object.title === undefined && object.date === undefined && object.location === undefined && object.band === undefined) fail("INVALID_COMMAND", "update-details must contain at least one field");
      for (const field of ["title", "date", "location", "band"] as const) if (object[field] !== undefined && typeof object[field] !== "string") fail("INVALID_COMMAND", `${field} must be a string`);
      const details = validatedDetails(object);
      return Object.freeze({
        kind,
        ...(object.title === undefined ? {} : { title: details.title }),
        ...(object.date === undefined ? {} : { date: details.date }),
        ...(object.location === undefined ? {} : { location: details.location }),
        ...(object.band === undefined ? {} : { band: details.band }),
      });
    }
    case "add-entry": {
      exactCommandKeys(object, ["kind", "sectionId", "entry"], ["beforeEntryId"]);
      return Object.freeze({
        kind,
        sectionId: stableCommandId<SetSectionId>(object.sectionId, "Set section ID"),
        entry: validateSetListEntry(object.entry as NewSetListEntry),
        ...(object.beforeEntryId === undefined ? {} : { beforeEntryId: stableCommandId<SetEntryId>(object.beforeEntryId, "Set Entry anchor ID") }),
      });
    }
    case "remove-entry":
      exactCommandKeys(object, ["kind", "entryId"]);
      return Object.freeze({ kind, entryId: stableCommandId<SetEntryId>(object.entryId, "Set Entry ID") });
    case "move-entry":
      exactCommandKeys(object, ["kind", "entryId", "toSectionId"], ["beforeEntryId"]);
      return Object.freeze({
        kind,
        entryId: stableCommandId<SetEntryId>(object.entryId, "Set Entry ID"),
        toSectionId: stableCommandId<SetSectionId>(object.toSectionId, "Destination set section ID"),
        ...(object.beforeEntryId === undefined ? {} : { beforeEntryId: stableCommandId<SetEntryId>(object.beforeEntryId, "Set Entry anchor ID") }),
      });
    case "update-entry-note": {
      exactCommandKeys(object, ["kind", "entryId", "note"]);
      const entry = validateSetListEntry({ id: "entry-command-validation", leadSheetId: "song-command-validation", targetPath: "songs/Command-Validation.md", label: "Validation", note: object.note as string });
      return Object.freeze({ kind, entryId: stableCommandId<SetEntryId>(object.entryId, "Set Entry ID"), note: entry.note });
    }
    case "add-section":
      exactCommandKeys(object, ["kind", "section"], ["beforeSectionId"]);
      return Object.freeze({
        kind,
        section: validateSetListSection(object.section as SetListSection),
        ...(object.beforeSectionId === undefined ? {} : { beforeSectionId: stableCommandId<SetSectionId>(object.beforeSectionId, "Set section anchor ID") }),
      });
    case "remove-section":
      exactCommandKeys(object, ["kind", "sectionId"]);
      return Object.freeze({ kind, sectionId: stableCommandId<SetSectionId>(object.sectionId, "Set section ID") });
    case "update-section-heading": {
      exactCommandKeys(object, ["kind", "sectionId", "heading"]);
      const section = validateSetListSection({ id: "section-command-validation", heading: object.heading as string });
      return Object.freeze({ kind, sectionId: stableCommandId<SetSectionId>(object.sectionId, "Set section ID"), heading: section.heading });
    }
    case "move-section":
      exactCommandKeys(object, ["kind", "sectionId"], ["beforeSectionId"]);
      return Object.freeze({
        kind,
        sectionId: stableCommandId<SetSectionId>(object.sectionId, "Set section ID"),
        ...(object.beforeSectionId === undefined ? {} : { beforeSectionId: stableCommandId<SetSectionId>(object.beforeSectionId, "Set section anchor ID") }),
      });
    case "restore-snapshot":
      exactCommandKeys(object, ["kind", "document"], ["undoOfRevisionId"]);
      return Object.freeze({
        kind,
        document: validateSetList(object.document as SetList),
        ...(object.undoOfRevisionId === undefined ? {} : { undoOfRevisionId: stableCommandId<LocalRevisionId>(object.undoOfRevisionId, "Undone revision ID") }),
      });
    default:
      fail("INVALID_COMMAND", "Set List command kind is invalid", { kind });
  }
}

function fail(code: "INVALID_COMMAND" | "INVALID_POSITION" | "NO_CHANGE" | "UNDO_UNAVAILABLE", message: string, detail?: unknown): never {
  throw new SetListError(code, message, detail);
}

function replaceSections(setList: SetList, sections: readonly SetListSection[]): SetList {
  return validateSetList({ ...setList, sections });
}

function insertBefore<T extends { readonly id: string }>(items: readonly T[], item: T, beforeId: string | undefined, label: string): readonly T[] {
  if (beforeId === undefined) return [...items, item];
  const index = items.findIndex((candidate) => candidate.id === beforeId);
  if (index < 0) fail("INVALID_POSITION", `${label} insertion anchor does not exist`, { beforeId });
  return [...items.slice(0, index), item, ...items.slice(index)];
}

function mutate(base: SetList, command: Exclude<SetListCommand, CreateSetListCommand | DuplicateSetListCommand>): SetList {
  switch (command.kind) {
    case "update-details":
      return validateSetList({
        ...base,
        title: command.title ?? base.title,
        date: command.date ?? base.date,
        location: command.location ?? base.location,
        band: command.band ?? base.band,
      });
    case "add-entry": {
      if (base.sections.some((section) => section.entries.some((entry) => entry.id === command.entry.id))) fail("INVALID_COMMAND", "Set Entry ID already exists", { id: command.entry.id });
      const { sectionIndex, section } = locateSection(base, command.sectionId);
      if (command.beforeEntryId !== undefined && !section.entries.some((entry) => entry.id === command.beforeEntryId)) {
        fail("INVALID_POSITION", "Set Entry insertion anchor must belong to the destination section", { beforeEntryId: command.beforeEntryId });
      }
      const entries = insertBefore(section.entries, validateSetList({ ...base, sections: [{ ...section, entries: [command.entry] }] }).sections[0]!.entries[0]!, command.beforeEntryId, "Set Entry");
      const sections = base.sections.map((candidate, index) => index === sectionIndex ? { ...candidate, entries } : candidate);
      return replaceSections(base, sections);
    }
    case "remove-entry": {
      const { sectionIndex, entryIndex, section } = locateEntry(base, command.entryId);
      const entries = [...section.entries.slice(0, entryIndex), ...section.entries.slice(entryIndex + 1)];
      return replaceSections(base, base.sections.map((candidate, index) => index === sectionIndex ? { ...candidate, entries } : candidate));
    }
    case "move-entry": {
      const source = locateEntry(base, command.entryId);
      const destination = locateSection(base, command.toSectionId);
      if (command.beforeEntryId === command.entryId) fail("INVALID_POSITION", "A Set Entry cannot be positioned before itself");
      if (command.beforeEntryId !== undefined && !destination.section.entries.some((entry) => entry.id === command.beforeEntryId)) {
        fail("INVALID_POSITION", "Set Entry move anchor must belong to the destination section", { beforeEntryId: command.beforeEntryId });
      }
      const without = base.sections.map((section, sectionIndex) => ({
        ...section,
        entries: sectionIndex === source.sectionIndex
          ? section.entries.filter((entry) => entry.id !== command.entryId)
          : [...section.entries],
      }));
      const destinationAfterRemoval = without[destination.sectionIndex]!;
      const entries = [...insertBefore(destinationAfterRemoval.entries, source.entry, command.beforeEntryId, "Set Entry")];
      without[destination.sectionIndex] = { ...destinationAfterRemoval, entries };
      return replaceSections(base, without);
    }
    case "update-entry-note": {
      const found = locateEntry(base, command.entryId);
      const entries = found.section.entries.map((entry) => entry.id === command.entryId ? { ...entry, note: command.note } : entry);
      return replaceSections(base, base.sections.map((section, index) => index === found.sectionIndex ? { ...section, entries } : section));
    }
    case "add-section": {
      if (base.sections.some((section) => section.id === command.section.id)) fail("INVALID_COMMAND", "Set section ID already exists", { id: command.section.id });
      const validated = validateSetList({ ...base, sections: [command.section] }).sections[0]!;
      return replaceSections(base, insertBefore(base.sections, validated, command.beforeSectionId, "Set section"));
    }
    case "remove-section": {
      const found = locateSection(base, command.sectionId);
      if (base.sections.length === 1) fail("INVALID_COMMAND", "The final Set List section cannot be removed");
      if (found.section.entries.length > 0) fail("INVALID_COMMAND", "A non-empty Set List section cannot be removed");
      return replaceSections(base, base.sections.filter((section) => section.id !== command.sectionId));
    }
    case "update-section-heading": {
      const found = locateSection(base, command.sectionId);
      return replaceSections(base, base.sections.map((section, index) => index === found.sectionIndex ? { ...section, heading: command.heading } : section));
    }
    case "move-section": {
      const found = locateSection(base, command.sectionId);
      if (command.beforeSectionId === command.sectionId) fail("INVALID_POSITION", "A Set section cannot be positioned before itself");
      const without = base.sections.filter((section) => section.id !== command.sectionId);
      return replaceSections(base, insertBefore(without, found.section, command.beforeSectionId, "Set section"));
    }
    case "restore-snapshot":
      if (command.document.id !== base.id) fail("INVALID_COMMAND", "An undo snapshot cannot change Set List identity");
      return validateSetList(command.document);
  }
}

function sameDocument(left: SetList, right: SetList): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function setListOperationKind(command: SetListCommand): string {
  if (command.kind === "restore-snapshot") return command.undoOfRevisionId === undefined ? "restore-set-list" : "undo-set-list";
  return command.kind;
}

/** Apply exactly one command and create an immutable forward revision. */
export function executeSetListCommand(base: SetListRevision | null, input: SetListCommand, identity: RevisionIdentity): SetListRevision {
  const command = validateSetListCommand(input);
  const revisionId = requireStableId<LocalRevisionId>(identity.revisionId, "Local revision ID");
  const operationId = requireStableId<OperationId>(identity.operationId, "Operation ID");
  let document: SetList;
  let inverse: RestoreSnapshotCommand | null;
  let parentRevisionId: LocalRevisionId | null;

  if (command.kind === "create-set-list" || command.kind === "duplicate-set-list") {
    if (base !== null) fail("INVALID_COMMAND", `${command.kind} cannot be applied to an existing revision`);
    document = validateSetList(command.document);
    if (command.kind === "duplicate-set-list" && command.sourceDocumentId === document.id) fail("INVALID_COMMAND", "A duplicated Set List must receive a new Set List ID");
    inverse = null;
    parentRevisionId = null;
  } else {
    if (base === null) fail("INVALID_COMMAND", `${command.kind} requires an existing Set List revision`);
    document = mutate(base.document, command);
    if (sameDocument(base.document, document)) fail("NO_CHANGE", "The Set List command did not change the document", { kind: command.kind });
    inverse = Object.freeze({ kind: "restore-snapshot", document: base.document });
    parentRevisionId = base.id;
  }

  return Object.freeze({
    schemaVersion: SET_LIST_REVISION_SCHEMA_VERSION,
    id: revisionId,
    documentId: document.id,
    parentRevisionId,
    operationId,
    operationKind: setListOperationKind(command),
    command,
    inverse,
    document,
  });
}

/**
 * Undo never rewinds or deletes history. It applies the latest revision's exact
 * inverse as a new operation/revision, making retries deterministic and making
 * the undo itself undoable (redo) with the same mechanism.
 */
export function undoSetListRevision(current: SetListRevision, identity: RevisionIdentity): SetListRevision {
  if (current.inverse === null) fail("UNDO_UNAVAILABLE", "The initial Set List revision cannot be undone");
  return executeSetListCommand(current, Object.freeze({ ...current.inverse, undoOfRevisionId: current.id }), identity);
}

export interface DuplicateSetListIdentity {
  readonly setListId: string;
  readonly path: string;
  readonly sectionIds: readonly string[];
  readonly entryIds: readonly string[];
}

/** Duplicate all occurrence identities; duplicate lead-sheet references remain legal. */
export function duplicateSetList(source: SetList, identity: DuplicateSetListIdentity, details: Partial<Pick<SetList, "title" | "date" | "location" | "band">> = {}): SetList {
  if (identity.sectionIds.length !== source.sections.length) fail("INVALID_COMMAND", "Duplicate Set List requires one new ID per section");
  const sourceEntries = source.sections.flatMap((section) => section.entries);
  if (identity.entryIds.length !== sourceEntries.length) fail("INVALID_COMMAND", "Duplicate Set List requires one new ID per Set Entry occurrence");
  let entryIndex = 0;
  return validateSetList({
    ...source,
    ...details,
    id: requireStableId<SetListId>(identity.setListId, "Duplicated Set List ID"),
    path: identity.path,
    sections: source.sections.map((section, sectionIndex) => ({
      ...section,
      id: requireStableId<SetSectionId>(identity.sectionIds[sectionIndex]!, "Duplicated set section ID"),
      entries: section.entries.map((entry) => ({
        ...entry,
        id: requireStableId<SetEntryId>(identity.entryIds[entryIndex++]!, "Duplicated Set Entry ID"),
      })),
    })),
  });
}
