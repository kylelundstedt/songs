import { describe, expect, it } from "vitest";
import {
  buildSetListPublicationPayload,
  canonicalJson,
  createSetList,
  decodeCanonicalSetListSource,
  duplicateSetList,
  encodeCanonicalSetListSource,
  executeSetListCommand,
  sha256Hex,
  undoSetListRevision,
  validateSetList,
  type SetList,
  type SetListRevision,
} from "./index";

function fixture(): SetList {
  return createSetList({
    id: "set-gig-a",
    path: "sets/Gig-A.md",
    title: "Gig A",
    date: "2026-08-14",
    location: "The Venue",
    band: "The Band",
    sections: [
      {
        id: "section-one",
        heading: "Set One",
        entries: [
          { id: "entry-first", leadSheetId: "song-shine", targetPath: "songs/Shine.md", label: "Shine", note: "Count four" },
          { id: "entry-second", leadSheetId: "song-shine", targetPath: "songs/Shine.md", label: "Shine (encore)", note: "Half time" },
        ],
      },
      { id: "section-two", heading: "Encore", columnBreakBefore: true, entries: [] },
    ],
  });
}

function initial(document = fixture()): SetListRevision {
  return executeSetListCommand(null, { kind: "create-set-list", document }, { revisionId: "revision-one", operationId: "operation-one" });
}

describe("writable Set List model and canonical codec", () => {
  it("preserves stable set, section, entry, and duplicate occurrence identities", () => {
    const setList = fixture();
    expect(setList.sections[0]?.entries.map((entry) => [entry.id, entry.leadSheetId])).toEqual([
      ["entry-first", "song-shine"],
      ["entry-second", "song-shine"],
    ]);
    expect(Object.isFrozen(setList)).toBe(true);
    expect(Object.isFrozen(setList.sections[0]?.entries)).toBe(true);

    expect(() => validateSetList({
      ...setList,
      sections: [{ ...setList.sections[0]!, entries: [setList.sections[0]!.entries[0]!] }, { ...setList.sections[1]!, entries: [setList.sections[0]!.entries[0]!] }],
    })).toThrow(expect.objectContaining({ code: "DUPLICATE_ID" }));
  });

  it("serializes a deterministic publication source with persisted IDs and exact round trip", async () => {
    const setList = fixture();
    const source = encodeCanonicalSetListSource(setList);
    expect(source).toContain('id: "set-gig-a"');
    expect(source).toContain('<!-- songs-v2-section id="section-one" -->');
    expect(source).toContain('<!-- songs-v2-entry id="entry-first" lead-sheet-id="song-shine" -->');
    expect(source.match(/lead-sheet-id="song-shine"/g)).toHaveLength(2);
    expect(source).toContain("<!-- column-break -->\n\n<!-- songs-v2-section");
    expect(decodeCanonicalSetListSource(source, setList.path)).toEqual(setList);
    expect(encodeCanonicalSetListSource(decodeCanonicalSetListSource(source, setList.path))).toBe(source);

    const payload = buildSetListPublicationPayload(setList);
    expect(payload).toEqual({ schema_version: "v2publish-1", kind: "set-list", path: "sets/Gig-A.md", source, deleted: false });
    const canonical = canonicalJson(payload);
    expect(JSON.parse(canonical)).toEqual(payload);
    expect(canonical).toContain("\\u003c!-- songs-v2-entry");
    expect(await sha256Hex(canonicalJson(payload))).toMatch(/^[a-f0-9]{64}$/);
  });

  it("matches Go encoding/json canonical escaping and hashing", async () => {
    const value = { schema_version: "v2publish-1", kind: "set-list", path: "sets/X.md", source: "<!-- x -->\nA & B\n🙂\n", deleted: false };
    const canonical = canonicalJson(value);
    expect(canonical).toBe('{"deleted":false,"kind":"set-list","path":"sets/X.md","schema_version":"v2publish-1","source":"\\u003c!-- x --\\u003e\\nA \\u0026 B\\n🙂\\n"}');
    expect(await sha256Hex(canonical)).toBe("e68c41667819c96c3c52f58e048956fa3e54f5be78ecb53f83a342d32dbcad42");
  });

  it("escapes labels reversibly and rejects source whose persisted IDs are removed or changed", () => {
    const setList = validateSetList({
      ...fixture(),
      sections: [{
        ...fixture().sections[0]!,
        entries: [{ id: "entry-special", leadSheetId: "song-shine", targetPath: "songs/Shine.md", label: "A [live] \\ take", note: "No repeats" }],
      }],
    });
    const source = encodeCanonicalSetListSource(setList);
    expect(source).toContain("[A \\[live\\] \\\\ take]");
    expect(decodeCanonicalSetListSource(source, setList.path)).toEqual(setList);
    expect(decodeCanonicalSetListSource(source.replace('id="entry-special"', 'id="entry-changed"'), setList.path).sections[0]?.entries[0]?.id).toBe("entry-changed");
    expect(() => decodeCanonicalSetListSource(source.replace(/<!-- songs-v2-entry[^\n]+-->\n/u, ""), setList.path)).toThrow(expect.objectContaining({ code: "CODEC_INVALID" }));
  });

  it("rejects invalid dates, unsafe paths, malformed IDs, and duplicate entry identities", () => {
    expect(() => createSetList({ ...fixture(), date: "2026-02-30" })).toThrow(expect.objectContaining({ code: "INVALID_FIELD" }));
    expect(() => createSetList({ ...fixture(), path: "../sets/Gig.md" })).toThrow(expect.objectContaining({ code: "INVALID_PATH" }));
    expect(() => createSetList({ ...fixture(), id: "Set_Bad" })).toThrow(expect.objectContaining({ code: "INVALID_ID" }));
    expect(() => createSetList({
      ...fixture(),
      sections: [{ ...fixture().sections[0]!, entries: [fixture().sections[0]!.entries[0]!, fixture().sections[0]!.entries[0]!] }],
    })).toThrow(expect.objectContaining({ code: "DUPLICATE_ID" }));
  });
});

describe("atomic Set List commands and forward undo", () => {
  it("adds, removes, and moves occurrence IDs without collapsing duplicate songs", () => {
    let revision = initial();
    revision = executeSetListCommand(revision, {
      kind: "add-entry",
      sectionId: revision.document.sections[1]!.id,
      entry: { id: "entry-third", leadSheetId: "song-shine", targetPath: "songs/Shine.md", label: "Shine reprise", note: "Quiet" },
    }, { revisionId: "revision-two", operationId: "operation-two" });
    revision = executeSetListCommand(revision, {
      kind: "move-entry",
      entryId: revision.document.sections[0]!.entries[1]!.id,
      toSectionId: revision.document.sections[1]!.id,
      beforeEntryId: revision.document.sections[1]!.entries[0]!.id,
    }, { revisionId: "revision-three", operationId: "operation-three" });
    expect(revision.document.sections.map((section) => section.entries.map((entry) => entry.id))).toEqual([
      ["entry-first"],
      ["entry-second", "entry-third"],
    ]);
    expect(revision.document.sections.flatMap((section) => section.entries).map((entry) => entry.leadSheetId)).toEqual(["song-shine", "song-shine", "song-shine"]);

    revision = executeSetListCommand(revision, { kind: "remove-entry", entryId: revision.document.sections[1]!.entries[0]!.id }, { revisionId: "revision-four", operationId: "operation-four" });
    expect(revision.document.sections.flatMap((section) => section.entries).map((entry) => entry.id)).toEqual(["entry-first", "entry-third"]);
  });

  it("makes undo a deterministic new revision and makes that undo itself undoable", () => {
    const base = initial();
    const changed = executeSetListCommand(base, { kind: "update-entry-note", entryId: base.document.sections[0]!.entries[0]!.id, note: "Start on cue" }, { revisionId: "revision-two", operationId: "operation-two" });
    const undone = undoSetListRevision(changed, { revisionId: "revision-three", operationId: "operation-three" });
    const repeated = undoSetListRevision(changed, { revisionId: "revision-three", operationId: "operation-three" });

    expect(undone).toEqual(repeated);
    expect(undone.id).toBe("revision-three");
    expect(undone.parentRevisionId).toBe("revision-two");
    expect(undone.operationKind).toBe("undo-set-list");
    expect(undone.command).toMatchObject({ kind: "restore-snapshot", undoOfRevisionId: "revision-two" });
    expect(undone.document).toEqual(base.document);

    const redone = undoSetListRevision(undone, { revisionId: "revision-four", operationId: "operation-four" });
    expect(redone.document).toEqual(changed.document);
    expect(() => undoSetListRevision(base, { revisionId: "revision-five", operationId: "operation-five" })).toThrow(expect.objectContaining({ code: "UNDO_UNAVAILABLE" }));
  });

  it("rejects no-op and invalid-position commands without producing revisions", () => {
    const base = initial();
    expect(() => executeSetListCommand(base, { kind: "update-details", title: base.document.title }, { revisionId: "revision-two", operationId: "operation-two" })).toThrow(expect.objectContaining({ code: "NO_CHANGE" }));
    expect(() => executeSetListCommand(base, {
      kind: "move-entry", entryId: base.document.sections[0]!.entries[0]!.id,
      toSectionId: base.document.sections[1]!.id, beforeEntryId: base.document.sections[0]!.entries[1]!.id,
    }, { revisionId: "revision-two", operationId: "operation-two" })).toThrow(expect.objectContaining({ code: "INVALID_POSITION" }));
  });

  it("duplicates every owned identity while retaining duplicate occurrences and reviewed targets", () => {
    const source = fixture();
    const copy = duplicateSetList(source, {
      setListId: "set-gig-copy",
      path: "sets/Gig-Copy.md",
      sectionIds: ["section-copy-one", "section-copy-two"],
      entryIds: ["entry-copy-one", "entry-copy-two"],
    }, { title: "Gig Copy", date: "" });
    expect(copy.id).not.toBe(source.id);
    expect(copy.sections.map((section) => section.id)).toEqual(["section-copy-one", "section-copy-two"]);
    expect(copy.sections.flatMap((section) => section.entries).map((entry) => entry.id)).toEqual(["entry-copy-one", "entry-copy-two"]);
    expect(copy.sections.flatMap((section) => section.entries).map((entry) => entry.leadSheetId)).toEqual(["song-shine", "song-shine"]);
  });
});
