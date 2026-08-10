import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test, { before } from "node:test";
import { fileURLToPath } from "node:url";
import { ReadModelError } from "../src/errors.js";
import { parseMarkdownEnvelope } from "../src/frontmatter.js";
import { FROZEN_SOURCE_COMMIT } from "../src/frozen.js";
import { GitReader, findRepositoryRoot } from "../src/git.js";
import {
  projectReadModel,
  readFrozenProjectionInput,
  type FrozenProjectionInput,
} from "../src/importer.js";
import { buildImportReport, renderImportReport, verifyImportReport } from "../src/report.js";
import { parseGitArchive } from "../src/tar.js";
import type { ReadModelSnapshot } from "../src/types.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = findRepositoryRoot(packageRoot);
let input: FrozenProjectionInput;
let snapshot: ReadModelSnapshot;

before(() => {
  input = readFrozenProjectionInput(repositoryRoot);
  snapshot = projectReadModel(input);
});

function tarSize(raw: Uint8Array, offset: number): number {
  const text = Buffer.from(raw.subarray(offset + 124, offset + 136)).toString("ascii").replaceAll("\0", "").trim();
  return Number.parseInt(text || "0", 8);
}

function nextTarHeader(raw: Uint8Array, offset: number): number {
  return offset + 512 + Math.ceil(tarSize(raw, offset) / 512) * 512;
}

function writeTarChecksum(raw: Uint8Array, offset: number): void {
  raw.fill(32, offset + 148, offset + 156);
  let checksum = 0;
  for (let index = 0; index < 512; index += 1) checksum += raw[offset + index] ?? 0;
  raw.set(Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii"), offset + 148);
}

function terminalTarOffset(raw: Uint8Array): number {
  let offset = 0;
  while (offset + 512 <= raw.byteLength) {
    const block = raw.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) return offset;
    offset = nextTarHeader(raw, offset);
  }
  throw new Error("archive has no terminal block");
}

function expectCode(code: ReadModelError["code"], action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof ReadModelError && error.code === code);
}

test("projects the complete frozen TASK-008 corpus exactly once", () => {
  assert.equal(snapshot.documents.length, 373);
  assert.equal(snapshot.leadSheets.length, 339);
  assert.equal(snapshot.setLists.length, 34);
  assert.equal(snapshot.setLists.flatMap((setList) => setList.sections).length, 36);
  assert.equal(snapshot.setLists.flatMap((setList) => setList.entries).length, 1_076);
  assert.equal(snapshot.slugRoutes.length, 373);
  assert.equal(new Set(snapshot.documents.map((document) => document.id)).size, 373);
  assert.equal(new Set(snapshot.slugRoutes.map((route) => `${route.kind}:${route.slug}`)).size, 373);
  assert.equal(new Set(snapshot.setLists.flatMap((setList) => setList.entries.map((entry) => entry.id))).size, 1_076);
  assert.equal(snapshot.documents.reduce((sum, document) => sum + document.source.bytes, 0), 748_034);
});

test("retains exact canonical bytes and every Set List source line", () => {
  for (const document of snapshot.documents) {
    const decoded = Buffer.from(document.canonicalSourceBase64, "base64");
    assert.equal(decoded.byteLength, document.source.bytes, document.path);
    assert.equal(decoded.toString("utf8"), document.canonicalMarkdown, document.path);
  }
  for (const setList of snapshot.setLists) {
    assert.equal(setList.sourceNodes.map((node) => node.raw).join("\n"), setList.bodyMarkdown, setList.path);
  }
});

test("preserves declared, legacy-sidecar, duplicate-entry, and section projection identities", () => {
  const legacy = snapshot.leadSheets.find((song) => song.path === "songs/1979.md");
  const declared = snapshot.leadSheets.find((song) => song.path === "songs/3-am.md");
  const declaredWithLegacyFields = snapshot.leadSheets.find((song) => song.path === "songs/fire-woman.md");
  assert.equal(legacy?.id, "song-0548a267-cd50-5fde-957c-303134dc189f");
  assert.equal(legacy?.identitySource, "sidecar-legacy-source");
  assert.equal(declared?.id, "3-am");
  assert.equal(declared?.identitySource, "front-matter");
  assert.equal(declaredWithLegacyFields?.identitySource, "front-matter");

  const nineTease = snapshot.setLists.find((setList) => setList.path === "sets/2025-10-13-9tease-stripped.md");
  assert.deepEqual(nineTease?.sections.map((section) => section.entryIds.length), [20, 23, 15]);
  assert.deepEqual(nineTease?.sections.map((section) => section.heading), ["Set 1 - Slow", "Set 2 - Medium", "Set 3 - Fast"]);
  assert.ok(nineTease?.sections.every((section) => section.identityScope === "frozen-snapshot"));
  const cheapSunglasses = nineTease?.entries.filter((entry) => entry.sourceContent.startsWith("[Cheap Sunglasses]")) ?? [];
  assert.equal(cheapSunglasses.length, 2);
  assert.notEqual(cheapSunglasses[0]?.id, cheapSunglasses[1]?.id);
  assert.deepEqual(cheapSunglasses.map((entry) => entry.fingerprintOccurrence), [1, 2]);
});

test("parses singer, note, and unlabelled annotation suffixes without rewriting labels", () => {
  const easter = snapshot.setLists.find((setList) => setList.path === "sets/2005-03-26-easter-pageant.md");
  assert.equal(easter?.entries[0]?.note, "Eve 6; “Everybody Poops”. Hugh.");
  const hopmonk = snapshot.setLists.find((setList) => setList.path === "sets/2017-11-10-20171110-hopmonk.md");
  const normalized = hopmonk?.entries.find((entry) => entry.label === "Thats The Way I Like It");
  assert.equal(normalized?.singer, "Kyle");
  assert.equal(normalized?.note, "match: normalized?");
  assert.equal(normalized?.label, "Thats The Way I Like It");
});

test("repeated imports and the checked-in report are byte deterministic", () => {
  const second = projectReadModel(input);
  const firstReport = buildImportReport(input, snapshot);
  const secondReport = buildImportReport(input, second);
  assert.equal(renderImportReport(firstReport), renderImportReport(secondReport));
  assert.ok(verifyImportReport(firstReport));
  assert.ok(firstReport.sections.every((section) => section.identityScope === "frozen-snapshot"));
  const golden = readFileSync(resolve(packageRoot, "fixtures/current/import-report.json"), "utf8");
  assert.equal(renderImportReport(firstReport), golden);
});

test("front matter supports CRLF while retaining lexical source", () => {
  const parsed = parseMarkdownEnvelope("---\r\nid: 007\r\ndate: 2015-09\r\n---\r\n# Demo", "synthetic.md");
  assert.equal(parsed.frontMatter.raw, "id: 007\r\ndate: 2015-09");
  assert.equal(parsed.frontMatter.data.id, "007");
  assert.equal(parsed.frontMatter.data.date, "2015-09");
  assert.equal(parsed.bodyMarkdown, "# Demo");
  assert.equal(parsed.bodyStartLine, 5);
});

test("rejects unsafe YAML tags and aliases without prototype mutation", () => {
  expectCode("FRONT_MATTER_INVALID", () =>
    parseMarkdownEnvelope("---\nwhen: !!timestamp 2026-08-10\n---\n# Demo", "timestamp.md"),
  );
  expectCode("FRONT_MATTER_INVALID", () =>
    parseMarkdownEnvelope("---\nloop: &loop [*loop]\n---\n# Demo", "recursive.md"),
  );
  const parsed = parseMarkdownEnvelope("---\n__proto__:\n  polluted: true\n---\n# Demo", "prototype.md");
  assert.ok(Object.hasOwn(parsed.frontMatter.data, "__proto__"));
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("tar decoding rejects local PAX overrides, invalid UTF-8, and truncated terminators", () => {
  const archive = new GitReader(repositoryRoot).readArchive(FROZEN_SOURCE_COMMIT, ["songs", "sets"]);

  const localPax = Uint8Array.from(archive);
  localPax[156] = "x".charCodeAt(0);
  writeTarChecksum(localPax, 0);
  expectCode("CONTRACT_INVALID", () => parseGitArchive(localPax, FROZEN_SOURCE_COMMIT));

  const invalidName = Uint8Array.from(archive);
  const secondHeader = nextTarHeader(invalidName, 0);
  invalidName[secondHeader] = 0xff;
  writeTarChecksum(invalidName, secondHeader);
  expectCode("CONTRACT_INVALID", () => parseGitArchive(invalidName, FROZEN_SOURCE_COMMIT));

  const terminal = terminalTarOffset(archive);
  expectCode("CONTRACT_INVALID", () => parseGitArchive(archive.subarray(0, terminal + 512), FROZEN_SOURCE_COMMIT));
});

test("source and identity failures return stable typed codes", () => {
  const firstBlob = input.sourceBlobs[0];
  assert.ok(firstBlob);
  const changedBytes = Uint8Array.from(firstBlob.bytes);
  changedBytes[changedBytes.length - 1] = (changedBytes[changedBytes.length - 1] ?? 0) ^ 1;
  expectCode("SOURCE_HASH_DRIFT", () =>
    projectReadModel({
      ...input,
      sourceBlobs: [{ path: firstBlob.path, bytes: changedBytes }, ...input.sourceBlobs.slice(1)],
    }),
  );

  const firstIdentity = input.identitySidecars.documents[0];
  assert.ok(firstIdentity);
  expectCode("DOCUMENT_ID_DUPLICATE", () =>
    projectReadModel({
      ...input,
      identitySidecars: {
        ...input.identitySidecars,
        documents: input.identitySidecars.documents.map((document, index) =>
          index === 1 ? { ...document, id: firstIdentity.id } : document,
        ),
      },
    }),
  );

  const firstEntry = input.identitySidecars.set_entries[0];
  assert.ok(firstEntry);
  expectCode("SET_ENTRY_CONTRACT_DRIFT", () =>
    projectReadModel({
      ...input,
      identitySidecars: {
        ...input.identitySidecars,
        set_entries: input.identitySidecars.set_entries.map((entry, index) =>
          index === 0 ? { ...entry, source_content: `${entry.source_content} changed` } : entry,
        ),
      },
    }),
  );
  const wrongTarget = input.identitySidecars.documents.find((document) => document.path === "songs/1979.md");
  assert.ok(wrongTarget);
  expectCode("SET_ENTRY_CONTRACT_DRIFT", () =>
    projectReadModel({
      ...input,
      identitySidecars: {
        ...input.identitySidecars,
        set_entries: input.identitySidecars.set_entries.map((entry, index) =>
          index === 0
            ? { ...entry, target_path: wrongTarget.path, target_document_id: wrongTarget.id }
            : entry,
        ),
      },
    }),
  );
  expectCode("TARGET_MISSING", () =>
    projectReadModel({
      ...input,
      identitySidecars: {
        ...input.identitySidecars,
        set_entries: input.identitySidecars.set_entries.map((entry, index) =>
          index === 0 ? { ...entry, target_document_id: "missing-document" } : entry,
        ),
      },
    }),
  );
  expectCode("CONTRACT_INVALID", () =>
    projectReadModel({
      ...input,
      identitySidecars: { ...input.identitySidecars, namespace_uuid: "not-a-uuid" },
    }),
  );
  expectCode("SOURCE_REF_DRIFT", () => projectReadModel({ ...input, sourceCommit: "0".repeat(40) }));
  expectCode("EVIDENCE_REF_DRIFT", () => projectReadModel({ ...input, evidenceCommit: "0".repeat(40) }));
  expectCode("FRONT_MATTER_INVALID", () => parseMarkdownEnvelope("---\na: [\n---\n# Broken", "broken.md"));
});
