import assert from "node:assert/strict";
import { test } from "node:test";
import { findRepositoryRoot } from "@songs-v2/read-model/git";
import { canonicalBytes, canonicalCompactBytes, framedSha256, isCanonicalJson, sha256 } from "../src/hash.js";
import { generateBootstrapArtifacts } from "../src/generate.js";
import { BootstrapError, type BootstrapArtifacts, type BootstrapChunkV1, type BootstrapManifestV1 } from "../src/types.js";
import { verifyBootstrapArtifacts } from "../src/verify.js";

const repositoryRoot = findRepositoryRoot();
const artifacts = generateBootstrapArtifacts(repositoryRoot);

function expectCode(code: BootstrapError["code"], action: () => unknown): void {
  assert.throws(action, (error) => error instanceof BootstrapError && error.code === code);
}

function manifestOf(source: BootstrapArtifacts): BootstrapManifestV1 {
  return JSON.parse(Buffer.from(source.manifest).toString("utf8")) as BootstrapManifestV1;
}

function signedManifest(manifest: BootstrapManifestV1): Uint8Array {
  const unsigned = { ...manifest, verification: { output_sha256: null } };
  return canonicalBytes({ ...unsigned, verification: { output_sha256: sha256(canonicalCompactBytes(unsigned)) } });
}

function cloneArtifacts(source: BootstrapArtifacts): { manifest: Uint8Array; chunks: Map<string, Uint8Array> } {
  return { manifest: Uint8Array.from(source.manifest), chunks: new Map([...source.chunks].map(([name, raw]) => [name, Uint8Array.from(raw)])) };
}

test("generates and verifies the complete immutable bootstrap snapshot", () => {
  const manifest = verifyBootstrapArtifacts(artifacts);
  assert.deepEqual(manifest.counts, {
    documents: 373,
    lead_sheets: 339,
    set_lists: 34,
    set_sections: 36,
    set_entries: 1076,
    source_bytes: 748034,
  });
  assert.equal(manifest.chunks.length, 12);
  assert.ok(Array.isArray(manifest.slug_routes));
  assert.equal(manifest.slug_routes.length, 373);
  assert.equal(manifest.physical_ipad.status, "pending");
});

test("repeated generation is byte deterministic", () => {
  const repeated = generateBootstrapArtifacts(repositoryRoot);
  assert.deepEqual(Buffer.from(repeated.manifest), Buffer.from(artifacts.manifest));
  assert.deepEqual([...repeated.chunks.keys()], [...artifacts.chunks.keys()]);
  for (const [name, raw] of artifacts.chunks) assert.deepEqual(Buffer.from(repeated.chunks.get(name)!), Buffer.from(raw));
});

test("rejects missing, unexpected, reordered, and unsupported chunks", () => {
  const missing = cloneArtifacts(artifacts);
  missing.chunks.delete("chunk-000.json");
  expectCode("CHUNK_MISSING", () => verifyBootstrapArtifacts(missing));

  const unexpected = cloneArtifacts(artifacts);
  unexpected.chunks.set("chunk-999.json", Buffer.from("{}\n"));
  expectCode("CHUNK_UNEXPECTED", () => verifyBootstrapArtifacts(unexpected));

  const reordered = cloneArtifacts(artifacts);
  const reorderedManifest = manifestOf(reordered);
  const descriptors = [...reorderedManifest.chunks];
  descriptors[0] = { ...descriptors[0]!, index: 1 };
  reordered.manifest = signedManifest({ ...reorderedManifest, chunks: descriptors });
  expectCode("SNAPSHOT_INVALID", () => verifyBootstrapArtifacts(reordered));

  const unsupported = cloneArtifacts(artifacts);
  const unsupportedManifest = manifestOf(unsupported);
  unsupported.manifest = signedManifest({ ...unsupportedManifest, schema_version: "2" as "1" });
  expectCode("SCHEMA_UNSUPPORTED", () => verifyBootstrapArtifacts(unsupported));
});

test("canonical JSON rejects duplicate keys and alternate number spellings", () => {
  assert.equal(isCanonicalJson(Buffer.from('{\n  "line_height": 1.24\n}\n')), true);
  assert.equal(isCanonicalJson(Buffer.from('{\n  "line_height": 124e-2\n}\n')), false);
  assert.equal(isCanonicalJson(Buffer.from('{\n  "line_height": 1.00000000000000001\n}\n')), false);
  assert.equal(isCanonicalJson(Buffer.from('{\n  "line_height": 0.000001\n}\n')), true);
  assert.equal(isCanonicalJson(Buffer.from('{\n  "line_height": 0.0000001\n}\n')), false);
  assert.equal(isCanonicalJson(Buffer.from('{\n  "line_height": 1000000000000000000000\n}\n')), false);
  assert.equal(isCanonicalJson(Buffer.from('{\n  "2": "two",\n  "10": "ten"\n}\n')), false);
  assert.equal(isCanonicalJson(Buffer.from('{\n  "𐀀": "astral",\n  "": "bmp"\n}\n')), false);
  assert.equal(isCanonicalJson(Buffer.from('{\n  "x": " "\n}\n')), true);
  assert.equal(isCanonicalJson(Buffer.from('{\n  "x": "\\u2028"\n}\n')), false);
  assert.equal(isCanonicalJson(Buffer.from('{\n  "x": "\\ud800"\n}\n')), false);
  assert.equal(isCanonicalJson(Buffer.from('{\n  "x": "😀"\n}\n')), true);
  assert.equal(isCanonicalJson(Buffer.from('{\n  "title": "first",\n  "title": "second"\n}\n')), false);
});

test("rejects duplicate documents even when chunk and manifest hashes are resigned", () => {
  const changed = cloneArtifacts(artifacts);
  const manifest = manifestOf(changed);
  const descriptor = manifest.chunks[0]!;
  const chunk = JSON.parse(Buffer.from(changed.chunks.get(descriptor.path)!).toString("utf8")) as BootstrapChunkV1;
  const documents = [...chunk.documents];
  documents[1] = documents[0]!;
  const unsignedChunk: BootstrapChunkV1 = {
    ...chunk,
    documents,
    verification: { documents_sha256: framedSha256(documents.map((document) => document.verification.document_sha256!)), output_sha256: null },
  };
  const signedChunk = { ...unsignedChunk, verification: { ...unsignedChunk.verification, output_sha256: sha256(canonicalCompactBytes(unsignedChunk)) } };
  const chunkRaw = canonicalBytes(signedChunk);
  changed.chunks.set(descriptor.path, chunkRaw);
  const descriptors = [...manifest.chunks];
  descriptors[0] = {
    ...descriptor,
    sha256: sha256(chunkRaw),
    bytes: chunkRaw.byteLength,
    source_bytes: documents.reduce((sum, document) => sum + document.source.bytes, 0),
  };
  changed.manifest = signedManifest({ ...manifest, chunks: descriptors });
  expectCode("SNAPSHOT_INVALID", () => verifyBootstrapArtifacts(changed));
});
