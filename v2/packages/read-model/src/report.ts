import { canonicalJson, sha256Bytes } from "./hash.js";
import type { FrozenProjectionInput } from "./importer.js";
import type { ImportReport, ReadModelSnapshot } from "./types.js";

export function buildImportReport(input: FrozenProjectionInput, snapshot: ReadModelSnapshot): ImportReport {
  const documents = snapshot.documents.map((document) => ({
    id: document.id,
    kind: document.kind,
    path: document.path,
    slug: document.slug,
    title: document.title,
    sourceSha256: document.source.sha256,
    sourceBytes: document.source.bytes,
    identitySource: document.identitySource,
  }));
  const sections = snapshot.setLists.flatMap((setList) =>
    setList.sections.map((section) => ({
      projectionKey: section.projectionKey,
      identityScope: section.identityScope,
      setId: setList.id,
      ordinal: section.ordinal,
      ...(section.heading === undefined ? {} : { heading: section.heading }),
      entryCount: section.entryIds.length,
    })),
  );
  const setEntries = snapshot.setLists.flatMap((setList) =>
    setList.entries.map((entry) => ({
      id: entry.id,
      setId: setList.id,
      sectionProjectionKey: entry.sectionProjectionKey,
      ordinal: entry.ordinal,
      targetPath: entry.targetPath,
      targetLeadSheetId: entry.targetLeadSheetId,
      fingerprint: entry.fingerprint,
    })),
  );
  const projectionSha256 = sha256Bytes(canonicalJson(snapshot));
  const reportWithoutHash = {
    schemaVersion: "1" as const,
    sourceBaseline: snapshot.sourceBaseline,
    evidenceBaseline: snapshot.evidenceBaseline,
    contractHashes: {
      corpusManifest: input.corpusManifest.verification.output_sha256,
      identitySidecars: input.identitySidecars.verification.output_sha256,
    },
    counts: {
      documents: snapshot.documents.length,
      leadSheets: snapshot.leadSheets.length,
      setLists: snapshot.setLists.length,
      setSections: sections.length,
      setEntries: setEntries.length,
      resolvedSetEntries: setEntries.length,
      canonicalSourceBytes: snapshot.documents.reduce((sum, document) => sum + document.source.bytes, 0),
    },
    documents,
    sections,
    setEntries,
    verification: {
      projectionSha256,
      outputSha256: "",
    },
  };
  const outputSha256 = sha256Bytes(canonicalJson(reportWithoutHash));
  return {
    ...reportWithoutHash,
    verification: { projectionSha256, outputSha256 },
  };
}

export function renderImportReport(report: ImportReport): string {
  return canonicalJson(report);
}

export function verifyImportReport(report: ImportReport): boolean {
  const copy = {
    ...report,
    verification: { ...report.verification, outputSha256: "" },
  };
  return sha256Bytes(canonicalJson(copy)) === report.verification.outputSha256;
}
