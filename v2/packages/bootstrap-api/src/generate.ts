import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  buildImportReport,
  findRepositoryRoot,
  projectReadModel,
  readFrozenProjectionInput,
} from "@songs-v2/read-model/git";
import type { LeadSheet, SetList } from "@songs-v2/read-model";
import { loadFrozenBootstrapEvidence } from "./evidence.js";
import { canonicalBytes, canonicalCompactBytes, framedSha256, sha256 } from "./hash.js";
import { BootstrapError, type BootstrapArtifacts, type BootstrapChunkDescriptorV1, type BootstrapChunkV1, type BootstrapDocumentV1, type BootstrapManifestV1, type JsonValue } from "./types.js";

const CHUNK_TARGET_SOURCE_BYTES = 65_536;
const TASK009_COMMIT = "2cbf78adac34fab94487a7b06a782907a257303b";
const TASK009_IMPORT_REPORT_FILE_SHA256 = "bd1c8fc5efa078aea9fb5811fbc055349ac42f642103922a6dd08a564dc61490";
const TASK009_IMPORT_REPORT_OUTPUT_SHA256 = "cfae83238b91223c7f1f05b82adf406d0d69c4d8e69d155e0b028b1d617a632c";
const TASK009_PROJECTION_SHA256 = "9422631c30d13999f8b7bce42a2b12857adbee36be698ac5ba2ea0194961fa80";
const FROZEN_SOURCE_REF = "v2-phase1-content-2026-08-10";
const FROZEN_SOURCE_TAG_OBJECT = "62f715002da4ca54bb3f01d34489514fe671cdf7";
const FROZEN_SOURCE_COMMIT = "17c326c8957ac2fbe623b2de0fe91a4eb0a1b4c5";
const FROZEN_EVIDENCE_REF = "v2-phase1-evidence-2026-08-10";
const FROZEN_EVIDENCE_TAG_OBJECT = "6a758e72a54f870c574c5ee6a0e20d9fd35af5b5";
const FROZEN_EVIDENCE_COMMIT = "5ea535b53b94445084586828389f44c1a5136877";

function fail(code: BootstrapError["code"], message: string, context: Readonly<Record<string, unknown>> = {}): never {
  throw new BootstrapError(code, message, context);
}

function verifyTask009Anchor(repositoryRoot: string): void {
  try {
    execFileSync("git", ["-C", repositoryRoot, "diff", "--quiet", TASK009_COMMIT, "--", "v2/packages/read-model"], {
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    });
    const report = execFileSync("git", ["-C", repositoryRoot, "show", `${TASK009_COMMIT}:v2/packages/read-model/fixtures/current/import-report.json`], {
      encoding: "buffer",
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    });
    if (sha256(report) !== TASK009_IMPORT_REPORT_FILE_SHA256) fail("GENERATION_INVALID", "TASK-009 import report anchor mismatch");
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    fail("GENERATION_INVALID", "TASK-009 implementation differs from its reviewed commit", { detail: error instanceof Error ? error.message : String(error) });
  }
}

function apexExecutable(): string {
  try {
    const found = execFileSync("which", ["apex"], { encoding: "utf8" }).trim();
    const path = realpathSync(found);
    accessSync(path, constants.X_OK);
    return path;
  } catch (error) {
    fail("APEX_INVALID", "Apex executable is unavailable", { detail: error instanceof Error ? error.message : String(error) });
  }
}

function normalizedVersion(path: string): string {
  const output = execFileSync(path, ["--version"], { encoding: "buffer", maxBuffer: 1024 * 1024 });
  return output.toString("utf8").replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
}

function projectionOf(document: LeadSheet | SetList): JsonValue {
  const { source: _source, canonicalMarkdown: _markdown, canonicalSourceBase64: _base64, ...projection } = document;
  return projection as unknown as JsonValue;
}

function chunkDocuments(documents: readonly BootstrapDocumentV1[]): BootstrapDocumentV1[][] {
  const chunks: BootstrapDocumentV1[][] = [];
  let current: BootstrapDocumentV1[] = [];
  let sourceBytes = 0;
  for (const document of documents) {
    if (current.length > 0 && sourceBytes + document.source.bytes > CHUNK_TARGET_SOURCE_BYTES) {
      chunks.push(current);
      current = [];
      sourceBytes = 0;
    }
    current.push(document);
    sourceBytes += document.source.bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function renderLeadSheets(repositoryRoot: string, leadSheets: readonly LeadSheet[], flags: readonly string[], expectedVersion: string, expectedExecutableHash: string, rendererRecords: ReadonlyMap<string, { readonly source_sha256: string; readonly source_bytes: number; readonly rendered_html_sha256: string; readonly rendered_html_bytes: number }>): ReadonlyMap<string, { readonly source_sha256: string; readonly html: string; readonly sha256: string; readonly bytes: number }> {
  const apex = apexExecutable();
  const actualExecutableHash = sha256(readFileSync(apex));
  const actualVersion = normalizedVersion(apex);
  if (actualExecutableHash !== expectedExecutableHash || actualVersion !== expectedVersion) {
    fail("APEX_INVALID", "Apex identity drift", { expectedExecutableHash, actualExecutableHash, expectedVersion, actualVersion });
  }
  const root = mkdtempSync(join(tmpdir(), "songs-v2-bootstrap-"));
  const output = new Map<string, { source_sha256: string; html: string; sha256: string; bytes: number }>();
  try {
    for (const leadSheet of leadSheets) {
      const expected = rendererRecords.get(leadSheet.path);
      if (expected === undefined || expected.source_sha256 !== leadSheet.source.sha256 || expected.source_bytes !== leadSheet.source.bytes) {
        fail("EVIDENCE_INVALID", "renderer source binding mismatch", { path: leadSheet.path });
      }
      const path = resolve(root, leadSheet.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(leadSheet.canonicalSourceBase64, "base64"));
      let rendered: Buffer;
      try {
        rendered = execFileSync(apex, [...flags, path], { cwd: root, encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
      } catch (error) {
        fail("APEX_INVALID", "Apex rendering failed", { path: leadSheet.path, detail: error instanceof Error ? error.message : String(error) });
      }
      const digest = sha256(rendered);
      if (digest !== expected.rendered_html_sha256 || rendered.byteLength !== expected.rendered_html_bytes) {
        fail("APEX_INVALID", "Apex output drift", { path: leadSheet.path, expected: expected.rendered_html_sha256, actual: digest });
      }
      output.set(leadSheet.path, { source_sha256: leadSheet.source.sha256, html: rendered.toString("utf8"), sha256: digest, bytes: rendered.byteLength });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  if (output.size !== 339) fail("APEX_INVALID", "Apex render coverage mismatch", { actual: output.size });
  return output;
}

export function generateBootstrapArtifacts(repositoryRoot = findRepositoryRoot()): BootstrapArtifacts {
  verifyTask009Anchor(repositoryRoot);
  const input = readFrozenProjectionInput(repositoryRoot);
  const snapshot = projectReadModel(input);
  const report = buildImportReport(input, snapshot);
  if (report.verification.projectionSha256 !== TASK009_PROJECTION_SHA256 || report.verification.outputSha256 !== TASK009_IMPORT_REPORT_OUTPUT_SHA256) {
    fail("GENERATION_INVALID", "TASK-009 projection anchor mismatch", { actual: report.verification });
  }
  const evidence = loadFrozenBootstrapEvidence(repositoryRoot);
  const rendered = renderLeadSheets(repositoryRoot, snapshot.leadSheets, evidence.apex.flags, evidence.apex.version_output, evidence.apex.sha256, evidence.rendererRecords);

  const documents: BootstrapDocumentV1[] = snapshot.documents.map((document, ordinal) => {
    const projection = projectionOf(document);
    const projectionSha256 = sha256(canonicalCompactBytes(projection));
    const apex = document.kind === "lead-sheet" ? rendered.get(document.path) ?? fail("APEX_INVALID", "missing rendered lead sheet", { path: document.path }) : null;
    const fitRecords = document.kind === "lead-sheet" ? evidence.fitRecords.get(document.path) : undefined;
    const fitSourceHash = document.kind === "lead-sheet" ? evidence.fitSourceHashes.get(document.path) : undefined;
    if (document.kind === "lead-sheet" && (fitRecords === undefined || fitRecords.length !== 3 || fitSourceHash !== document.source.sha256)) {
      fail("EVIDENCE_INVALID", "fit source binding mismatch", { path: document.path });
    }
    const withoutHash: BootstrapDocumentV1 = {
      ordinal,
      id: document.id,
      kind: document.kind,
      path: document.path,
      slug: document.slug,
      source: {
        ref: document.source.ref,
        commit: document.source.commit,
        sha256: document.source.sha256,
        bytes: document.source.bytes,
        content_base64: document.canonicalSourceBase64,
      },
      projection,
      apex,
      fit: document.kind === "lead-sheet" ? { source_sha256: fitSourceHash!, profiles: fitRecords! } : null,
      verification: { projection_sha256: projectionSha256, document_sha256: null },
    };
    return {
      ...withoutHash,
      verification: { ...withoutHash.verification, document_sha256: sha256(canonicalCompactBytes(withoutHash)) },
    };
  });

  const logicalSnapshot = {
    source_baseline: { ref: FROZEN_SOURCE_REF, tag_object: FROZEN_SOURCE_TAG_OBJECT, commit: FROZEN_SOURCE_COMMIT },
    evidence_baseline: { ref: FROZEN_EVIDENCE_REF, tag_object: FROZEN_EVIDENCE_TAG_OBJECT, commit: FROZEN_EVIDENCE_COMMIT },
    read_model_anchor: {
      implementation_commit: TASK009_COMMIT,
      import_report_file_sha256: TASK009_IMPORT_REPORT_FILE_SHA256,
      import_report_output_sha256: TASK009_IMPORT_REPORT_OUTPUT_SHA256,
    },
    contract_hashes: {
      corpus_manifest: report.contractHashes.corpusManifest,
      identity_sidecars: report.contractHashes.identitySidecars,
      read_model_projection: report.verification.projectionSha256,
    },
    evidence_hashes: {
      renderer_baseline: evidence.rendererSha256,
      browser_fit_summary: evidence.fitSummarySha256,
      fit_captures: evidence.fitCaptureSha256,
    },
    apex: { version_output: evidence.apex.version_output, executable_sha256: evidence.apex.sha256, flags: evidence.apex.flags },
    physical_ipad: evidence.physicalIpad,
    slug_routes: snapshot.slugRoutes,
    document_hashes: documents.map((document) => document.verification.document_sha256),
  };
  const snapshotSha256 = sha256(canonicalCompactBytes(logicalSnapshot));
  const generation = `phase1-${snapshotSha256.slice(0, 24)}`;
  const chunks = new Map<string, Uint8Array>();
  const descriptors: BootstrapChunkDescriptorV1[] = [];
  for (const [index, entries] of chunkDocuments(documents).entries()) {
    const chunkWithoutHash: BootstrapChunkV1 = {
      schema_version: "1",
      kind: "songs-v2.bootstrap.chunk",
      generation,
      index,
      documents: entries,
      verification: {
        documents_sha256: framedSha256(entries.map((document) => document.verification.document_sha256!)),
        output_sha256: null,
      },
    };
    const chunk: BootstrapChunkV1 = {
      ...chunkWithoutHash,
      verification: { ...chunkWithoutHash.verification, output_sha256: sha256(canonicalCompactBytes(chunkWithoutHash)) },
    };
    const bytes = canonicalBytes(chunk);
    const name = `chunk-${String(index).padStart(3, "0")}.json`;
    chunks.set(name, bytes);
    descriptors.push({
      index,
      path: name,
      url: `/api/v2/bootstrap/${generation}/chunks/${name}`,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      source_bytes: entries.reduce((sum, document) => sum + document.source.bytes, 0),
      document_count: entries.length,
      first_path: entries[0]!.path,
      last_path: entries.at(-1)!.path,
    });
  }
  const manifestWithoutHash: BootstrapManifestV1 = {
    schema_version: "1",
    kind: "songs-v2.bootstrap.manifest",
    generation,
    source_baseline: logicalSnapshot.source_baseline,
    evidence_baseline: logicalSnapshot.evidence_baseline,
    read_model_anchor: logicalSnapshot.read_model_anchor,
    counts: {
      documents: documents.length,
      lead_sheets: snapshot.leadSheets.length,
      set_lists: snapshot.setLists.length,
      set_sections: snapshot.setLists.reduce((sum, setList) => sum + setList.sections.length, 0),
      set_entries: snapshot.setLists.reduce((sum, setList) => sum + setList.entries.length, 0),
      source_bytes: documents.reduce((sum, document) => sum + document.source.bytes, 0),
    },
    contract_hashes: logicalSnapshot.contract_hashes,
    evidence_hashes: logicalSnapshot.evidence_hashes,
    apex: logicalSnapshot.apex,
    physical_ipad: evidence.physicalIpad,
    slug_routes: snapshot.slugRoutes as unknown as JsonValue,
    chunks: descriptors,
    snapshot_sha256: snapshotSha256,
    verification: { output_sha256: null },
  };
  const manifest: BootstrapManifestV1 = {
    ...manifestWithoutHash,
    verification: { output_sha256: sha256(canonicalCompactBytes(manifestWithoutHash)) },
  };
  return { manifest: canonicalBytes(manifest), chunks };
}
