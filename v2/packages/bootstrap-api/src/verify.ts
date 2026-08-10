import { canonicalCompactBytes, framedSha256, isCanonicalJson, sha256 } from "./hash.js";
import { BootstrapError, type BootstrapArtifacts, type BootstrapChunkV1, type BootstrapDocumentV1, type BootstrapManifestV1 } from "./types.js";

const TASK009_COMMIT = "2cbf78adac34fab94487a7b06a782907a257303b";
const TASK009_IMPORT_REPORT_FILE_SHA256 = "bd1c8fc5efa078aea9fb5811fbc055349ac42f642103922a6dd08a564dc61490";
const TASK009_IMPORT_REPORT_OUTPUT_SHA256 = "cfae83238b91223c7f1f05b82adf406d0d69c4d8e69d155e0b028b1d617a632c";
const TASK009_PROJECTION_SHA256 = "9422631c30d13999f8b7bce42a2b12857adbee36be698ac5ba2ea0194961fa80";
const EXPECTED_CORPUS_MANIFEST_SHA256 = "a3989f52ab23d8d3be31c9df258faa6a564c82ceadb1bee6f0b8e03dce0f1a35";
const EXPECTED_IDENTITY_SIDECARS_SHA256 = "0a4b95ae549aaf41286d41754d08cb4f66256abf84f39b30015d656014d640b6";
const EXPECTED_RENDERER_SHA256 = "bc1c68fa4c691cff8678aafcfaaa25b2ed2a2ad2a4b0405e3228d8dad5a6371e";
const EXPECTED_FIT_SUMMARY_SHA256 = "d80941d7fea462e32d1fdea0306d616c06b349562ad90836457a91794356b77d";
const EXPECTED_MANIFEST_RAW_SHA256 = "a81aafbdef0de15e192c960ed32703f2c6216f3c4eb531a86d5e0cb1d7411c5f";

function fail(code: BootstrapError["code"], message: string, context: Readonly<Record<string, unknown>> = {}): never {
  throw new BootstrapError(code, message, context);
}

function parse<T>(raw: Uint8Array, label: string): T {
  try {
    const value = JSON.parse(Buffer.from(raw).toString("utf8")) as T;
    if (!isCanonicalJson(raw)) fail("GENERATION_INVALID", `${label} is not canonical JSON`);
    return value;
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    fail("GENERATION_INVALID", `invalid ${label} JSON`, { detail: error instanceof Error ? error.message : String(error) });
  }
}

function selfHash(value: { readonly verification: { readonly output_sha256: string | null } }): string {
  return sha256(canonicalCompactBytes({ ...value, verification: { ...value.verification, output_sha256: null } }));
}

function documentSelfHash(document: BootstrapDocumentV1): string {
  return sha256(canonicalCompactBytes({ ...document, verification: { ...document.verification, document_sha256: null } }));
}

export function verifyBootstrapArtifacts(artifacts: BootstrapArtifacts): BootstrapManifestV1 {
  const manifest = parse<BootstrapManifestV1>(artifacts.manifest, "manifest");
  if (manifest.schema_version !== "1" || manifest.kind !== "songs-v2.bootstrap.manifest") fail("SCHEMA_UNSUPPORTED", "unsupported manifest schema");
  if (sha256(artifacts.manifest) !== EXPECTED_MANIFEST_RAW_SHA256) fail("SNAPSHOT_INVALID", "manifest does not match the reviewed runtime trust anchor");
  if (
    manifest.read_model_anchor.implementation_commit !== TASK009_COMMIT ||
    manifest.read_model_anchor.import_report_file_sha256 !== TASK009_IMPORT_REPORT_FILE_SHA256 ||
    manifest.read_model_anchor.import_report_output_sha256 !== TASK009_IMPORT_REPORT_OUTPUT_SHA256 ||
    manifest.contract_hashes.read_model_projection !== TASK009_PROJECTION_SHA256 ||
    manifest.contract_hashes.corpus_manifest !== EXPECTED_CORPUS_MANIFEST_SHA256 ||
    manifest.contract_hashes.identity_sidecars !== EXPECTED_IDENTITY_SIDECARS_SHA256 ||
    manifest.evidence_hashes.renderer_baseline !== EXPECTED_RENDERER_SHA256 ||
    manifest.evidence_hashes.browser_fit_summary !== EXPECTED_FIT_SUMMARY_SHA256
  ) fail("SNAPSHOT_INVALID", "TASK-009 trust anchor mismatch");
  if (manifest.verification.output_sha256 === null || selfHash(manifest) !== manifest.verification.output_sha256) fail("GENERATION_INVALID", "manifest self-hash mismatch");
  const expectedChunkNames = new Set(manifest.chunks.map((chunk) => chunk.path));
  for (const name of artifacts.chunks.keys()) if (!expectedChunkNames.has(name)) fail("CHUNK_UNEXPECTED", "unreferenced chunk", { path: name });
  if (expectedChunkNames.size !== manifest.chunks.length) fail("CHUNK_ORDER_INVALID", "duplicate chunk path");

  const documents: BootstrapDocumentV1[] = [];
  for (const [expectedIndex, descriptor] of manifest.chunks.entries()) {
    if (descriptor.index !== expectedIndex || descriptor.path !== `chunk-${String(expectedIndex).padStart(3, "0")}.json` || descriptor.url !== `/api/v2/bootstrap/${manifest.generation}/chunks/${descriptor.path}`) {
      fail("CHUNK_ORDER_INVALID", "chunk descriptor order mismatch", { expectedIndex, actual: descriptor.index });
    }
    const raw = artifacts.chunks.get(descriptor.path);
    if (raw === undefined) fail("CHUNK_MISSING", "referenced chunk is missing", { path: descriptor.path });
    if (raw.byteLength !== descriptor.bytes || sha256(raw) !== descriptor.sha256) fail("CHUNK_HASH_MISMATCH", "chunk raw hash mismatch", { path: descriptor.path });
    const chunk = parse<BootstrapChunkV1>(raw, descriptor.path);
    if (chunk.schema_version !== "1" || chunk.kind !== "songs-v2.bootstrap.chunk") fail("SCHEMA_UNSUPPORTED", "unsupported chunk schema", { path: descriptor.path });
    if (chunk.generation !== manifest.generation || chunk.index !== expectedIndex || chunk.documents.length !== descriptor.document_count) fail("CHUNK_ORDER_INVALID", "chunk identity mismatch", { path: descriptor.path });
    if (chunk.verification.output_sha256 === null || selfHash(chunk) !== chunk.verification.output_sha256) fail("CHUNK_HASH_MISMATCH", "chunk self-hash mismatch", { path: descriptor.path });
    if (framedSha256(chunk.documents.map((document) => document.verification.document_sha256 ?? "")) !== chunk.verification.documents_sha256) fail("CHUNK_HASH_MISMATCH", "chunk document hash mismatch", { path: descriptor.path });
    if (chunk.documents.length === 0 || chunk.documents[0]!.path !== descriptor.first_path || chunk.documents.at(-1)!.path !== descriptor.last_path || chunk.documents.reduce((sum, document) => sum + document.source.bytes, 0) !== descriptor.source_bytes) fail("CHUNK_ORDER_INVALID", "chunk descriptor contents mismatch", { path: descriptor.path });
    documents.push(...chunk.documents);
  }

  const ids = new Set<string>();
  const paths = new Set<string>();
  const entryIds = new Set<string>();
  const documentsById = new Map<string, BootstrapDocumentV1>();
  let leadSheets = 0;
  let setLists = 0;
  let setSections = 0;
  let setEntries = 0;
  let sourceBytes = 0;
  let previousPath = "";
  for (const [ordinal, document] of documents.entries()) {
    if (document.ordinal !== ordinal || (ordinal > 0 && document.path <= previousPath) || ids.has(document.id) || paths.has(document.path)) fail("DOCUMENT_INVALID", "document identity/order mismatch", { path: document.path });
    previousPath = document.path;
    ids.add(document.id);
    documentsById.set(document.id, document);
    paths.add(document.path);
    sourceBytes += document.source.bytes;
    const source = Buffer.from(document.source.content_base64, "base64");
    if (source.byteLength !== document.source.bytes || sha256(source) !== document.source.sha256 || document.source.ref !== manifest.source_baseline.ref || document.source.commit !== manifest.source_baseline.commit) fail("DOCUMENT_INVALID", "document source binding mismatch", { path: document.path });
    if (sha256(canonicalCompactBytes(document.projection)) !== document.verification.projection_sha256 || document.verification.document_sha256 === null || documentSelfHash(document) !== document.verification.document_sha256) fail("DOCUMENT_INVALID", "document projection/hash mismatch", { path: document.path });
    if (document.projection === null || typeof document.projection !== "object" || Array.isArray(document.projection)) fail("DOCUMENT_INVALID", "document projection is malformed", { path: document.path });
    const projection = document.projection as Record<string, unknown>;
    if (projection.id !== document.id || projection.kind !== document.kind || projection.path !== document.path || projection.slug !== document.slug) fail("DOCUMENT_INVALID", "document envelope/projection mismatch", { path: document.path });
    if (document.kind === "lead-sheet") {
      leadSheets += 1;
      if (document.apex === null || document.apex.source_sha256 !== document.source.sha256 || Buffer.byteLength(document.apex.html, "utf8") !== document.apex.bytes || sha256(document.apex.html) !== document.apex.sha256) fail("DOCUMENT_INVALID", "Apex binding mismatch", { path: document.path });
      if (document.fit === null || document.fit.source_sha256 !== document.source.sha256 || document.fit.profiles.length !== 3 || new Set(document.fit.profiles.map((profile) => profile.profile)).size !== 3) fail("DOCUMENT_INVALID", "fit binding mismatch", { path: document.path });
      for (const profile of document.fit.profiles) {
        const expectedStatus = profile.profile === "phone" ? "scrollable" : profile.status;
        if (
          !["ipad-portrait", "ipad-landscape", "phone"].includes(profile.profile) ||
          !["fit", "needs-editing", "scrollable"].includes(profile.status) ||
          profile.status !== expectedStatus ||
          (profile.profile !== "phone" && profile.status === "scrollable") ||
          profile.body_px <= 0 || profile.auto_body_px <= 0 || profile.line_height <= 0 ||
          profile.column_count !== profile.columns.length || profile.column_count < 1
        ) fail("DOCUMENT_INVALID", "fit result is outside the frozen schema", { path: document.path, profile: profile.profile });
      }
    } else if (document.kind === "set-list") {
      setLists += 1;
      if (document.apex !== null || document.fit !== null || !Array.isArray(projection.sections) || !Array.isArray(projection.entries)) fail("DOCUMENT_INVALID", "Set List projection mismatch", { path: document.path });
      setSections += projection.sections.length;
      setEntries += projection.entries.length;
      const localEntryIds = new Set<string>();
      for (const [index, item] of projection.entries.entries()) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) fail("DOCUMENT_INVALID", "Set Entry malformed", { path: document.path });
        const entry = item as Record<string, unknown>;
        if (typeof entry.id !== "string" || entryIds.has(entry.id) || entry.setId !== document.id || entry.ordinal !== index + 1 || typeof entry.targetPath !== "string" || typeof entry.targetLeadSheetId !== "string") fail("DOCUMENT_INVALID", "duplicate or malformed Set Entry", { path: document.path, id: entry.id });
        entryIds.add(entry.id);
        localEntryIds.add(entry.id);
      }
      const sectionEntryIds: string[] = [];
      for (const [index, item] of projection.sections.entries()) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) fail("DOCUMENT_INVALID", "Set section malformed", { path: document.path });
        const section = item as Record<string, unknown>;
        if (section.identityScope !== "frozen-snapshot" || section.setId !== document.id || section.ordinal !== index + 1 || !Array.isArray(section.entryIds) || !section.entryIds.every((id) => typeof id === "string" && localEntryIds.has(id))) fail("DOCUMENT_INVALID", "Set section identity mismatch", { path: document.path });
        sectionEntryIds.push(...section.entryIds as string[]);
      }
      if (sectionEntryIds.length !== localEntryIds.size || new Set(sectionEntryIds).size !== localEntryIds.size) fail("DOCUMENT_INVALID", "Set sections do not cover entries exactly once", { path: document.path });
    } else fail("DOCUMENT_INVALID", "unsupported document kind", { path: document.path });
  }
  for (const document of documents.filter((candidate) => candidate.kind === "set-list")) {
    const projection = document.projection as Record<string, unknown>;
    for (const item of projection.entries as unknown[]) {
      const entry = item as Record<string, unknown>;
      const target = typeof entry.targetLeadSheetId === "string" ? documentsById.get(entry.targetLeadSheetId) : undefined;
      if (target === undefined || target.kind !== "lead-sheet" || entry.targetPath !== target.path) fail("DOCUMENT_INVALID", "Set Entry target is missing or mismatched", { id: entry.id });
    }
  }
  const counts = manifest.counts;
  if (documents.length !== counts.documents || leadSheets !== counts.lead_sheets || setLists !== counts.set_lists || setSections !== counts.set_sections || setEntries !== counts.set_entries || sourceBytes !== counts.source_bytes) fail("SNAPSHOT_INVALID", "manifest counts mismatch");

  if (!Array.isArray(manifest.slug_routes) || manifest.slug_routes.length !== documents.length) fail("SNAPSHOT_INVALID", "slug route coverage mismatch");
  const routeKeys = new Set<string>();
  for (const item of manifest.slug_routes) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) fail("SNAPSHOT_INVALID", "slug route malformed");
    const route = item as Record<string, unknown>;
    const key = `${route.kind}:${route.slug}`;
    const document = typeof route.documentId === "string" ? documentsById.get(route.documentId) : undefined;
    const expectedKind = document?.kind === "lead-sheet" ? "song" : document?.kind === "set-list" ? "set" : undefined;
    if (document === undefined || route.kind !== expectedKind || route.slug !== document.slug || route.path !== document.path || routeKeys.has(key)) fail("SNAPSHOT_INVALID", "slug route identity mismatch", { key });
    routeKeys.add(key);
  }
  const logicalSnapshot = {
    source_baseline: manifest.source_baseline,
    evidence_baseline: manifest.evidence_baseline,
    read_model_anchor: manifest.read_model_anchor,
    contract_hashes: manifest.contract_hashes,
    evidence_hashes: manifest.evidence_hashes,
    apex: manifest.apex,
    physical_ipad: manifest.physical_ipad,
    slug_routes: manifest.slug_routes,
    document_hashes: documents.map((document) => document.verification.document_sha256),
  };
  const snapshotSha256 = sha256(canonicalCompactBytes(logicalSnapshot));
  if (snapshotSha256 !== manifest.snapshot_sha256 || manifest.generation !== `phase1-${snapshotSha256.slice(0, 24)}`) fail("SNAPSHOT_INVALID", "snapshot generation mismatch");
  return manifest;
}
