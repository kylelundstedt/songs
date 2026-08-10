import {
  parseCorpusManifest,
  parseIdentitySidecars,
  type CorpusManifestContract,
  type IdentitySidecarsContract,
} from "./contracts.js";
import { fail, type ReadModelErrorCode } from "./errors.js";
import {
  CORPUS_MANIFEST_PATH,
  FROZEN_EVIDENCE_COMMIT,
  FROZEN_EVIDENCE_REF,
  FROZEN_EVIDENCE_TAG_OBJECT,
  FROZEN_SOURCE_COMMIT,
  FROZEN_SOURCE_REF,
  FROZEN_SOURCE_TAG_OBJECT,
  IDENTITY_SIDECARS_PATH,
} from "./frozen.js";
import { GitReader } from "./git.js";
import { projectLeadSheet, projectSetList } from "./parser.js";
import { parseGitArchive } from "./tar.js";
import type { LeadSheet, ReadModelSnapshot, SetList, SlugRoute } from "./types.js";

export interface FrozenSourceBlob {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface FrozenProjectionInput {
  readonly sourceRef: string;
  readonly sourceCommit: string;
  readonly evidenceRef: string;
  readonly evidenceCommit: string;
  readonly corpusManifest: CorpusManifestContract;
  readonly identitySidecars: IdentitySidecarsContract;
  readonly sourceBlobs: readonly FrozenSourceBlob[];
}

export function readFrozenProjectionInput(repositoryRoot: string): FrozenProjectionInput {
  const git = new GitReader(repositoryRoot);
  const sourceObject = git.resolveObject(FROZEN_SOURCE_REF);
  const sourceCommit = git.resolveCommit(FROZEN_SOURCE_REF);
  if (git.objectType(FROZEN_SOURCE_REF) !== "tag" || sourceObject !== FROZEN_SOURCE_TAG_OBJECT || sourceCommit !== FROZEN_SOURCE_COMMIT) {
    fail("SOURCE_REF_DRIFT", "frozen source tag drift", {
      expected: { object: FROZEN_SOURCE_TAG_OBJECT, commit: FROZEN_SOURCE_COMMIT },
      actual: { object: sourceObject, commit: sourceCommit },
    });
  }
  const evidenceObject = git.resolveObject(FROZEN_EVIDENCE_REF);
  const evidenceCommit = git.resolveCommit(FROZEN_EVIDENCE_REF);
  if (
    git.objectType(FROZEN_EVIDENCE_REF) !== "tag" ||
    evidenceObject !== FROZEN_EVIDENCE_TAG_OBJECT ||
    evidenceCommit !== FROZEN_EVIDENCE_COMMIT
  ) {
    fail("EVIDENCE_REF_DRIFT", "frozen evidence tag drift", {
      expected: { object: FROZEN_EVIDENCE_TAG_OBJECT, commit: FROZEN_EVIDENCE_COMMIT },
      actual: { object: evidenceObject, commit: evidenceCommit },
    });
  }

  const corpusManifest = parseCorpusManifest(
    git.readBlob(FROZEN_EVIDENCE_COMMIT, CORPUS_MANIFEST_PATH),
    CORPUS_MANIFEST_PATH,
  );
  const identitySidecars = parseIdentitySidecars(
    git.readBlob(FROZEN_EVIDENCE_COMMIT, IDENTITY_SIDECARS_PATH),
    IDENTITY_SIDECARS_PATH,
  );
  const sourceBlobs = parseGitArchive(
    git.readArchive(FROZEN_SOURCE_COMMIT, ["songs", "sets"]),
    FROZEN_SOURCE_COMMIT,
  );
  return {
    sourceRef: FROZEN_SOURCE_REF,
    sourceCommit,
    evidenceRef: FROZEN_EVIDENCE_REF,
    evidenceCommit,
    corpusManifest,
    identitySidecars,
    sourceBlobs,
  };
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string, code: ReadModelErrorCode, label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) fail(code, `duplicate ${label}: ${value}`, { id: value });
    seen.add(value);
  }
}

function exactPathSet(label: string, expected: readonly string[], actual: readonly string[]): void {
  const expectedSorted = [...expected].sort();
  const actualSorted = [...actual].sort();
  if (expectedSorted.length !== actualSorted.length || expectedSorted.some((path, index) => path !== actualSorted[index])) {
    fail("CONTRACT_INVALID", `${label} path set drift`, { expected: expectedSorted, actual: actualSorted });
  }
}

export function projectReadModel(input: FrozenProjectionInput): ReadModelSnapshot {
  const { corpusManifest: manifest, identitySidecars: identity } = input;
  if (input.sourceRef !== FROZEN_SOURCE_REF || input.sourceCommit !== FROZEN_SOURCE_COMMIT) {
    fail("SOURCE_REF_DRIFT", "projection input is not the frozen source baseline", {
      expected: { ref: FROZEN_SOURCE_REF, commit: FROZEN_SOURCE_COMMIT },
      actual: { ref: input.sourceRef, commit: input.sourceCommit },
    });
  }
  if (input.evidenceRef !== FROZEN_EVIDENCE_REF || input.evidenceCommit !== FROZEN_EVIDENCE_COMMIT) {
    fail("EVIDENCE_REF_DRIFT", "projection input is not the frozen evidence baseline", {
      expected: { ref: FROZEN_EVIDENCE_REF, commit: FROZEN_EVIDENCE_COMMIT },
      actual: { ref: input.evidenceRef, commit: input.evidenceCommit },
    });
  }
  if (manifest.schema_version !== "1" || identity.schema_version !== "1") {
    fail("CONTRACT_INVALID", "unsupported frozen contract schema", {
      expected: "1",
      actual: { corpus: manifest.schema_version, identity: identity.schema_version },
    });
  }
  const expectedSource = { ref: input.sourceRef, commit: input.sourceCommit };
  if (
    manifest.baseline.ref !== expectedSource.ref ||
    manifest.baseline.commit !== expectedSource.commit ||
    identity.baseline.ref !== expectedSource.ref ||
    identity.baseline.commit !== expectedSource.commit
  ) {
    fail("SOURCE_REF_DRIFT", "evidence contracts name a different source baseline", {
      expected: expectedSource,
      actual: { manifest: manifest.baseline, identity: identity.baseline },
    });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(identity.namespace_uuid)) {
    fail("CONTRACT_INVALID", "invalid identity namespace UUID", { actual: identity.namespace_uuid });
  }
  if (
    manifest.records.length !== manifest.verification.record_count ||
    manifest.records.length !== manifest.corpus.counts.files ||
    identity.documents.length !== identity.counts.documents ||
    identity.slug_routes.length !== identity.counts.slug_routes ||
    identity.set_entries.length !== identity.counts.set_entries
  ) {
    fail("CONTRACT_INVALID", "frozen contract counts do not match their records");
  }

  exactPathSet("manifest/identity", manifest.records.map((record) => record.path), identity.documents.map((item) => item.path));
  exactPathSet("manifest/slug-route", manifest.records.map((record) => record.path), identity.slug_routes.map((item) => item.path));
  exactPathSet("manifest/source-blob", manifest.records.map((record) => record.path), input.sourceBlobs.map((item) => item.path));
  uniqueBy(identity.documents, (item) => item.id, "DOCUMENT_ID_DUPLICATE", "document ID");
  uniqueBy(identity.set_entries, (item) => item.id, "SET_ENTRY_ID_DUPLICATE", "Set Entry ID");
  uniqueBy(identity.slug_routes, (item) => `${item.kind}:${item.slug}`, "SLUG_ROUTE_DRIFT", "slug route");

  const identityByPath = new Map(identity.documents.map((item) => [item.path, item]));
  const routeByPath = new Map(identity.slug_routes.map((item) => [item.path, item]));
  const blobByPath = new Map(input.sourceBlobs.map((item) => [item.path, item.bytes]));
  const entryContractsBySet = new Map<string, typeof identity.set_entries>();
  for (const entry of identity.set_entries) {
    const existing = entryContractsBySet.get(entry.set_path) ?? [];
    entryContractsBySet.set(entry.set_path, [...existing, entry]);
  }
  for (const entries of entryContractsBySet.values()) {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry?.ordinal !== index + 1) {
        fail("SET_ENTRY_CONTRACT_DRIFT", "Set Entry contracts are not in ordinal order", {
          ...(entry?.set_path === undefined ? {} : { path: entry.set_path }),
          expected: index + 1,
          actual: entry?.ordinal,
        });
      }
    }
  }

  const documents: (LeadSheet | SetList)[] = [];
  for (const record of manifest.records) {
    const documentIdentity = identityByPath.get(record.path);
    const route = routeByPath.get(record.path);
    const raw = blobByPath.get(record.path);
    if (!documentIdentity) fail("DOCUMENT_ID_MISSING", `missing document identity: ${record.path}`, { path: record.path });
    if (!route) fail("SLUG_ROUTE_DRIFT", `missing slug route: ${record.path}`, { path: record.path });
    if (!raw) fail("SOURCE_BYTES_DRIFT", `missing source blob: ${record.path}`, { path: record.path });
    const context = {
      sourceBaseline: expectedSource,
      identityNamespace: identity.namespace_uuid,
      record,
      identity: documentIdentity,
      route,
      raw,
    };
    documents.push(
      record.kind === "song"
        ? projectLeadSheet(context)
        : projectSetList(context, entryContractsBySet.get(record.path) ?? []),
    );
  }

  const leadSheets = documents.filter((document): document is LeadSheet => document.kind === "lead-sheet");
  const setLists = documents.filter((document): document is SetList => document.kind === "set-list");
  const leadSheetByPath = new Map(leadSheets.map((document) => [document.path, document]));
  const seenEntryIds = new Set<string>();
  for (const setList of setLists) {
    for (const entry of setList.entries) {
      if (seenEntryIds.has(entry.id)) fail("SET_ENTRY_ID_DUPLICATE", `duplicate projected Set Entry ID: ${entry.id}`, { id: entry.id });
      seenEntryIds.add(entry.id);
      const target = leadSheetByPath.get(entry.targetPath);
      if (!target || target.id !== entry.targetLeadSheetId) {
        fail("TARGET_MISSING", `Set Entry target does not resolve: ${setList.path}:${entry.sourceLine}`, {
          path: setList.path,
          line: entry.sourceLine,
          id: entry.id,
          expected: entry.targetLeadSheetId,
          actual: target?.id,
        });
      }
    }
  }
  if (seenEntryIds.size !== identity.set_entries.length) {
    fail("SET_ENTRY_CONTRACT_DRIFT", "not every frozen Set Entry projected exactly once", {
      expected: identity.set_entries.length,
      actual: seenEntryIds.size,
    });
  }
  const totalBytes = documents.reduce((sum, document) => sum + document.source.bytes, 0);
  if (totalBytes !== manifest.corpus.bytes.total) {
    fail("SOURCE_BYTES_DRIFT", "projected source byte total drift", {
      expected: manifest.corpus.bytes.total,
      actual: totalBytes,
    });
  }

  const slugRoutes: SlugRoute[] = identity.slug_routes.map((route) => ({
    kind: route.kind,
    slug: route.slug,
    path: route.path,
    documentId: route.document_id,
  }));
  return {
    schemaVersion: "1",
    sourceBaseline: expectedSource,
    evidenceBaseline: { ref: input.evidenceRef, commit: input.evidenceCommit },
    identityNamespace: identity.namespace_uuid,
    documents,
    leadSheets,
    setLists,
    slugRoutes,
  };
}

export function loadFrozenReadModel(repositoryRoot: string): ReadModelSnapshot {
  return projectReadModel(readFrozenProjectionInput(repositoryRoot));
}
