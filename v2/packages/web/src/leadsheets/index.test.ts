import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLeadSheetPublicationPayload,
  createCanonicalLeadSheet,
  createLeadSheet,
  encodeCanonicalLeadSheetSource,
  executeLeadSheetCommand,
  readLeadSheetMetadata,
  scanLeadSheetFrontMatter,
  undoLeadSheetRevision,
  updateLeadSheetMetadataSource,
  validateLeadSheetLocally,
  type LeadSheet,
  type LeadSheetRevision,
} from "./index";

const LEGACY_SOURCE = [
  "---",
  "# retained front-matter comment",
  "artist :   'Prince & The Revolution'   # retain quote and comment",
  "custom_mapping:",
  "  nested: [one, two]",
  'performance_key: "Am"',
  "bpm: 120.5 # plain scalar remains plain",
  'legacy_source_path: "lead-sheet/Darling-Nikki.md"',
  "---",
  "",
  "# Darling Nikki",
  "",
  "### Verse 1",
  "I knew a girl named Nikki  ",
  "She had untouched lyrics.",
].join("\n");

function fixture(source = LEGACY_SOURCE): LeadSheet {
  return createLeadSheet({ id: "song-darling-nikki", path: "songs/Darling-Nikki.md", source });
}

function initial(document = fixture()): LeadSheetRevision {
  return executeLeadSheetCommand(null, { kind: "create-lead-sheet", document }, { revisionId: "revision-one", operationId: "operation-one" });
}

describe("reviewed corpus source preservation", () => {
  it("opens all 339 reviewed lead sheets without changing one source byte", () => {
    const root = resolve(process.cwd(), "../../../internal/v2bootstrap/data/chunks");
    let count = 0;
    for (const name of readdirSync(root).filter((item) => item.endsWith(".json")).sort()) {
      const chunk = JSON.parse(readFileSync(resolve(root, name), "utf8")) as { documents: Array<{ id: string; path: string; kind: string; source: { content_base64: string; sha256: string } }> };
      for (const record of chunk.documents.filter((item) => item.kind === "lead-sheet")) {
        const source = Buffer.from(record.source.content_base64, "base64").toString("utf8");
        const opened = createLeadSheet({ id: record.id, path: record.path, source });
        expect(opened.source, record.path).toBe(source);
        expect(scanLeadSheetFrontMatter(opened.source).source, record.path).toBe(source);
        count++;
      }
    }
    expect(count).toBe(339);
  });
});

describe("lossless lead-sheet source and front-matter codec", () => {
  it("retains exact UTF-8 LF source when merely scanned and modeled", () => {
    const document = fixture();
    const scan = scanLeadSheetFrontMatter(document.source);
    expect(document.source).toBe(LEGACY_SOURCE);
    expect(scan.source).toBe(LEGACY_SOURCE);
    expect(scan.raw).toContain("custom_mapping:\n  nested: [one, two]");
    expect(scan.body).toBe("\n# Darling Nikki\n\n### Verse 1\nI knew a girl named Nikki  \nShe had untouched lyrics.");
    expect(scan.fields.artist).toMatchObject({ value: "Prince & The Revolution", style: "single-quoted" });
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(scan.lines)).toBe(true);
  });

  it("surgically updates only requested spans while preserving fields, order, comments, quoting, and body", () => {
    const before = scanLeadSheetFrontMatter(LEGACY_SOURCE);
    const changed = updateLeadSheetMetadataSource(LEGACY_SOURCE, {
      artist: "Prince's Band",
      performanceKey: "Dm, D",
      bpm: "121.25",
      originalKey: "Dm",
      originalBpm: "120.5",
    });
    const after = scanLeadSheetFrontMatter(changed);

    expect(after.body).toBe(before.body);
    expect(changed).toContain("artist :   'Prince''s Band'   # retain quote and comment");
    expect(changed).toContain('performance_key: "Dm, D"');
    expect(changed).toContain("bpm: 121.25 # plain scalar remains plain");
    expect(changed).toContain("custom_mapping:\n  nested: [one, two]");
    expect(changed.indexOf("custom_mapping:")).toBeLessThan(changed.indexOf("performance_key:"));
    expect(changed).toContain('original_key: "Dm"\noriginal_bpm: "120.5"\n---');
    expect(readLeadSheetMetadata(changed)).toEqual({
      artist: "Prince's Band",
      performanceKey: "Dm, D",
      bpm: "121.25",
      originalKey: "Dm",
      originalBpm: "120.5",
    });
  });

  it("updates title metadata and the sole H1 but no other body bytes", () => {
    const changed = updateLeadSheetMetadataSource(LEGACY_SOURCE, { title: "Darling Nikki (Live)" });
    expect(changed).toContain('title: "Darling Nikki (Live)"\n---');
    expect(changed).toContain("\n# Darling Nikki (Live)\n\n### Verse 1\nI knew a girl named Nikki  \nShe had untouched lyrics.");
    expect(changed.replace('title: "Darling Nikki (Live)"\n', "").replaceAll("Darling Nikki (Live)", "Darling Nikki")).toBe(LEGACY_SOURCE);
  });

  it("updates quoted and escaped managed keys without inserting semantic duplicates", () => {
    const quoted = LEGACY_SOURCE.replace("artist :   'Prince & The Revolution'", "'artist' :   'Prince & The Revolution'");
    const quotedChanged = updateLeadSheetMetadataSource(quoted, { artist: "Prince's Band" });
    expect(quotedChanged).toContain("'artist' :   'Prince''s Band'   # retain quote and comment");
    expect(quotedChanged.match(/artist/gu)).toHaveLength(1);

    const escaped = LEGACY_SOURCE.replace("artist :", '"\\x61rtist" :');
    const escapedChanged = updateLeadSheetMetadataSource(escaped, { artist: "The Band" });
    expect(escapedChanged).toContain('"\\x61rtist" :   \'The Band\'');
    expect(readLeadSheetMetadata(escapedChanged).artist).toBe("The Band");
  });

  it("does not mistake H1-looking fenced content for the document title", () => {
    const source = LEGACY_SOURCE.replace("# Darling Nikki", ["````markdown", "~~~", "# Not the title", "~~~", "````", "# Darling Nikki"].join("\n"));
    const changed = updateLeadSheetMetadataSource(source, { title: "Darling Nikki Live" });
    expect(changed).toContain("# Not the title");
    expect(changed).toContain("````\n# Darling Nikki Live\n");
  });

  it("can remove optional managed metadata without generic YAML rewriting", () => {
    const changed = updateLeadSheetMetadataSource(LEGACY_SOURCE, { performanceKey: null, bpm: null });
    expect(changed).not.toContain("performance_key:");
    expect(changed).not.toContain("bpm:");
    expect(changed).toContain("# retained front-matter comment");
    expect(scanLeadSheetFrontMatter(changed).body).toBe(scanLeadSheetFrontMatter(LEGACY_SOURCE).body);
  });

  it("rejects CRLF, NUL, unpaired surrogates, ambiguous duplicates, and unsafe plain-style rewrites", () => {
    expect(() => fixture(LEGACY_SOURCE.replaceAll("\n", "\r\n"))).toThrow(expect.objectContaining({ code: "INVALID_SOURCE" }));
    expect(() => fixture(`${LEGACY_SOURCE}\0`)).toThrow(expect.objectContaining({ code: "INVALID_SOURCE" }));
    expect(() => fixture(`${LEGACY_SOURCE}\ud800`)).toThrow(expect.objectContaining({ code: "INVALID_SOURCE" }));
    expect(() => updateLeadSheetMetadataSource(LEGACY_SOURCE.replace("artist :   'Prince & The Revolution'   # retain quote and comment", "artist: |\n  Prince\n  and the Band"), { artist: "The Band" })).toThrow(expect.objectContaining({ code: "FRONT_MATTER_INVALID" }));
    expect(() => updateLeadSheetMetadataSource(LEGACY_SOURCE.replace("artist :   'Prince & The Revolution'   # retain quote and comment", "artist: Prince\n  and the Band"), { artist: "The Band" })).toThrow(expect.objectContaining({ code: "FRONT_MATTER_INVALID" }));
    expect(() => updateLeadSheetMetadataSource(LEGACY_SOURCE.replace("artist :   'Prince & The Revolution'   # retain quote and comment", "artist: Prince"), { artist: "123" })).toThrow(expect.objectContaining({ code: "INVALID_METADATA" }));
    expect(() => updateLeadSheetMetadataSource(LEGACY_SOURCE.replace("bpm: 120.5", "bpm: 120.5\nbpm: 99"), { bpm: "100" })).toThrow(expect.objectContaining({ code: "FRONT_MATTER_INVALID" }));
    expect(() => updateLeadSheetMetadataSource(LEGACY_SOURCE, { bpm: "12 # surprise" })).toThrow(expect.objectContaining({ code: "INVALID_METADATA" }));
  });
});

describe("canonical create, local validation, and publication payload", () => {
  it("creates deterministic canonical source and a lead-sheet publication payload", () => {
    const source = encodeCanonicalLeadSheetSource({
      id: "song-cafe",
      path: "songs/Cafe.md",
      title: "Café Song",
      artist: "The Artists",
      performanceKey: "Eb",
      bpm: "108.5",
      originalKey: "E",
      originalBpm: "109",
      body: "### Verse\nExact body 🙂",
    });
    expect(source).toBe([
      "---",
      "schema_version: 1",
      'id: "song-cafe"',
      'title: "Café Song"',
      'artist: "The Artists"',
      'performance_key: "Eb"',
      'bpm: "108.5"',
      'original_key: "E"',
      'original_bpm: "109"',
      'provenance_status: "authored-pending-review"',
      "---",
      "",
      "# Café Song",
      "",
      "### Verse",
      "Exact body 🙂",
      "",
    ].join("\n"));
    const document = createCanonicalLeadSheet({ id: "song-cafe", path: "songs/Cafe.md", title: "Café Song", artist: "The Artists", body: "### Verse\nExact body 🙂" });
    expect(buildLeadSheetPublicationPayload(document)).toEqual({
      schema_version: "v2publish-1",
      kind: "lead-sheet",
      path: "songs/Cafe.md",
      source: document.source,
      deleted: false,
    });
  });

  it("reports useful local checks while explicitly reserving authority for server/Apex", () => {
    const document = createCanonicalLeadSheet({ id: "song-cafe", path: "songs/Cafe.md", title: "Café Song", artist: "The Artists", bpm: "108.5" });
    const report = validateLeadSheetLocally(document);
    expect(report).toMatchObject({ authority: "local-only", valid: true, requiresServerValidation: true, requiresApexValidation: true, title: "Café Song" });
    expect(report.issues).toContainEqual(expect.objectContaining({ severity: "warning", code: "APEX_VALIDATION_REQUIRED" }));

    const invalid = fixture(LEGACY_SOURCE.replace("artist :   'Prince & The Revolution'   # retain quote and comment\n", ""));
    expect(validateLeadSheetLocally(invalid)).toMatchObject({ valid: false });
    expect(validateLeadSheetLocally(invalid).issues).toContainEqual(expect.objectContaining({ code: "ARTIST_REQUIRED" }));
  });
});

describe("immutable lead-sheet commands and forward undo", () => {
  it("applies surgical metadata and exact source replacement as immutable revisions", () => {
    const base = initial();
    const metadata = executeLeadSheetCommand(base, { kind: "update-metadata", patch: { artist: "Prince's Band", bpm: "121" } }, { revisionId: "revision-two", operationId: "operation-two" });
    expect(metadata.parentRevisionId).toBe(base.id);
    expect(metadata.document.source).toContain("artist :   'Prince''s Band'");
    expect(base.document.source).toBe(LEGACY_SOURCE);
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.command)).toBe(true);

    const replacementSource = metadata.document.source.replace("She had untouched lyrics.", "Edited exact source.");
    const replaced = executeLeadSheetCommand(metadata, { kind: "replace-source", source: replacementSource }, { revisionId: "revision-three", operationId: "operation-three" });
    expect(replaced.document.source).toBe(replacementSource);
  });

  it("undoes by creating a deterministic new forward revision, itself undoable", () => {
    const base = initial();
    const changed = executeLeadSheetCommand(base, { kind: "update-metadata", patch: { bpm: "121" } }, { revisionId: "revision-two", operationId: "operation-two" });
    const undone = undoLeadSheetRevision(changed, { revisionId: "revision-three", operationId: "operation-three" });
    const replay = undoLeadSheetRevision(changed, { revisionId: "revision-three", operationId: "operation-three" });
    expect(undone).toEqual(replay);
    expect(undone.document).toEqual(base.document);
    expect(undone.operationKind).toBe("undo-lead-sheet");
    expect(undone.command).toMatchObject({ kind: "restore-snapshot", undoOfRevisionId: "revision-two" });

    const redone = undoLeadSheetRevision(undone, { revisionId: "revision-four", operationId: "operation-four" });
    expect(redone.document).toEqual(changed.document);
    expect(() => undoLeadSheetRevision(base, { revisionId: "revision-five", operationId: "operation-five" })).toThrow(expect.objectContaining({ code: "UNDO_UNAVAILABLE" }));
  });

  it("rejects no-op commands and command mutation cannot alter retained history", () => {
    const base = initial();
    expect(() => executeLeadSheetCommand(base, { kind: "update-metadata", patch: { bpm: "120.5" } }, { revisionId: "revision-two", operationId: "operation-two" })).toThrow(expect.objectContaining({ code: "NO_CHANGE" }));
    expect(() => executeLeadSheetCommand(base, { kind: "replace-source", source: base.document.source }, { revisionId: "revision-two", operationId: "operation-two" })).toThrow(expect.objectContaining({ code: "NO_CHANGE" }));
    expect(() => executeLeadSheetCommand(base, { kind: "update-metadata", patch: { bpm: "121" } }, { revisionId: base.id, operationId: "operation-two" })).toThrow(expect.objectContaining({ code: "INVALID_COMMAND" }));

    const mutable = { kind: "update-metadata" as const, patch: { artist: "A New Artist" } };
    const revision = executeLeadSheetCommand(base, mutable, { revisionId: "revision-two", operationId: "operation-two" });
    mutable.patch.artist = "Mutated Later";
    expect(revision.command).toMatchObject({ patch: { artist: "A New Artist" } });

    const mutableDocument = { ...base.document };
    const mutableBase = { ...base, document: mutableDocument } as LeadSheetRevision;
    const detached = executeLeadSheetCommand(mutableBase, { kind: "update-metadata", patch: { bpm: "121" } }, { revisionId: "revision-three", operationId: "operation-three" });
    mutableDocument.source = "mutated outside history";
    expect(detached.inverse?.document.source).toBe(LEGACY_SOURCE);
  });
});
