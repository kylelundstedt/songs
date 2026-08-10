import { fail } from "./errors.js";
import { canonicalJson, sha256Bytes } from "./hash.js";
import type { DocumentKind } from "./types.js";

export interface CorpusLinkContract {
  readonly label: string;
  readonly target: string;
  readonly classification: string;
  readonly resolved_path?: string;
}

export interface CorpusRecordContract {
  readonly kind: DocumentKind;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly newline_style: string;
  readonly title: string;
  readonly front_matter_id: string | null;
  readonly legacy_slug: string;
  readonly links: readonly CorpusLinkContract[];
}

export interface CorpusManifestContract {
  readonly schema_version: string;
  readonly baseline: { readonly ref: string; readonly commit: string };
  readonly corpus: {
    readonly counts: { readonly files: number; readonly songs: number; readonly sets: number };
    readonly bytes: { readonly total: number };
  };
  readonly records: readonly CorpusRecordContract[];
  readonly verification: { readonly record_count: number; readonly output_sha256: string };
}

export interface DocumentIdentityContract {
  readonly id: string;
  readonly kind: DocumentKind;
  readonly path: string;
  readonly source: "front-matter" | "sidecar-legacy-source";
  readonly source_sha256: string;
  readonly identity_seed?: string;
}

export interface SetEntryIdentityContract {
  readonly id: string;
  readonly set_id: string;
  readonly set_path: string;
  readonly ordinal: number;
  readonly fingerprint: string;
  readonly fingerprint_occurrence: number;
  readonly source_content: string;
  readonly label: string;
  readonly target: string;
  readonly classification: "resolved canonical file" | "unresolved: reference";
  readonly identity_seed: string;
  readonly target_path?: string;
  readonly target_document_id?: string;
}

export interface SlugRouteContract {
  readonly kind: DocumentKind;
  readonly slug: string;
  readonly path: string;
  readonly document_id: string;
}

export interface IdentitySidecarsContract {
  readonly schema_version: string;
  readonly baseline: { readonly ref: string; readonly commit: string };
  readonly namespace_uuid: string;
  readonly counts: {
    readonly documents: number;
    readonly declared_document_ids: number;
    readonly sidecar_document_ids: number;
    readonly slug_routes: number;
    readonly set_entries: number;
    readonly resolved_set_entries: number;
    readonly unresolved_set_entries: number;
  };
  readonly documents: readonly DocumentIdentityContract[];
  readonly slug_routes: readonly SlugRouteContract[];
  readonly set_entries: readonly SetEntryIdentityContract[];
  readonly verification: { readonly output_sha256: string };
}

function decodeJson(raw: Uint8Array, path: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (error) {
    fail("INVALID_UTF8", `contract is not valid UTF-8: ${path}`, { path, detail: String(error) });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail("CONTRACT_INVALID", `contract is not valid JSON: ${path}`, { path, detail: String(error) });
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("CONTRACT_INVALID", `expected object at ${path}`, { path, actual: value });
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") fail("CONTRACT_INVALID", `expected string at ${path}`, { path, actual: value });
  return value;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail("CONTRACT_INVALID", `expected integer at ${path}`, { path, actual: value });
  }
  return value;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail("CONTRACT_INVALID", `expected array at ${path}`, { path, actual: value });
  return value;
}

function verifySelfHash(value: Record<string, unknown>, path: string): string {
  const verification = object(value.verification, `${path}.verification`);
  const expected = string(verification.output_sha256, `${path}.verification.output_sha256`);
  const copy = structuredClone(value);
  object(copy.verification, `${path}.verification`).output_sha256 = null;
  const actual = sha256Bytes(canonicalJson(copy));
  if (actual !== expected) {
    fail("CONTRACT_HASH_DRIFT", `contract self-hash drift: ${path}`, { path, expected, actual });
  }
  return expected;
}

export function parseCorpusManifest(raw: Uint8Array, path: string): CorpusManifestContract {
  const root = object(decodeJson(raw, path), path);
  verifySelfHash(root, path);
  const baseline = object(root.baseline, `${path}.baseline`);
  const corpus = object(root.corpus, `${path}.corpus`);
  const counts = object(corpus.counts, `${path}.corpus.counts`);
  const bytes = object(corpus.bytes, `${path}.corpus.bytes`);
  const verification = object(root.verification, `${path}.verification`);
  const records = array(root.records, `${path}.records`).map((item, index): CorpusRecordContract => {
    const record = object(item, `${path}.records[${index}]`);
    const kind = string(record.kind, `${path}.records[${index}].kind`);
    if (kind !== "song" && kind !== "set") fail("CONTRACT_INVALID", `invalid document kind at ${path}.records[${index}]`);
    const frontMatterId = record.front_matter_id;
    if (frontMatterId !== null && typeof frontMatterId !== "string") {
      fail("CONTRACT_INVALID", `invalid front-matter ID at ${path}.records[${index}]`);
    }
    const links = array(record.links, `${path}.records[${index}].links`).map((linkValue, linkIndex): CorpusLinkContract => {
      const link = object(linkValue, `${path}.records[${index}].links[${linkIndex}]`);
      const resolved = link.resolved_path;
      if (resolved !== undefined && typeof resolved !== "string") fail("CONTRACT_INVALID", "invalid resolved path", { path });
      return {
        label: string(link.label, `${path}.records[${index}].links[${linkIndex}].label`),
        target: string(link.target, `${path}.records[${index}].links[${linkIndex}].target`),
        classification: string(link.classification, `${path}.records[${index}].links[${linkIndex}].classification`),
        ...(resolved === undefined ? {} : { resolved_path: resolved }),
      };
    });
    return {
      kind,
      path: string(record.path, `${path}.records[${index}].path`),
      sha256: string(record.sha256, `${path}.records[${index}].sha256`),
      bytes: number(record.bytes, `${path}.records[${index}].bytes`),
      newline_style: string(record.newline_style, `${path}.records[${index}].newline_style`),
      title: string(record.title, `${path}.records[${index}].title`),
      front_matter_id: frontMatterId,
      legacy_slug: string(record.legacy_slug, `${path}.records[${index}].legacy_slug`),
      links,
    };
  });
  return {
    schema_version: string(root.schema_version, `${path}.schema_version`),
    baseline: {
      ref: string(baseline.ref, `${path}.baseline.ref`),
      commit: string(baseline.commit, `${path}.baseline.commit`),
    },
    corpus: {
      counts: {
        files: number(counts.files, `${path}.corpus.counts.files`),
        songs: number(counts.songs, `${path}.corpus.counts.songs`),
        sets: number(counts.sets, `${path}.corpus.counts.sets`),
      },
      bytes: { total: number(bytes.total, `${path}.corpus.bytes.total`) },
    },
    records,
    verification: {
      record_count: number(verification.record_count, `${path}.verification.record_count`),
      output_sha256: string(verification.output_sha256, `${path}.verification.output_sha256`),
    },
  };
}

export function parseIdentitySidecars(raw: Uint8Array, path: string): IdentitySidecarsContract {
  const root = object(decodeJson(raw, path), path);
  verifySelfHash(root, path);
  const baseline = object(root.baseline, `${path}.baseline`);
  const counts = object(root.counts, `${path}.counts`);
  const verification = object(root.verification, `${path}.verification`);
  const documents = array(root.documents, `${path}.documents`).map((item, index): DocumentIdentityContract => {
    const record = object(item, `${path}.documents[${index}]`);
    const kind = string(record.kind, `${path}.documents[${index}].kind`);
    const source = string(record.source, `${path}.documents[${index}].source`);
    if (kind !== "song" && kind !== "set") fail("CONTRACT_INVALID", "invalid identity document kind", { path });
    if (source !== "front-matter" && source !== "sidecar-legacy-source") fail("CONTRACT_INVALID", "invalid identity source", { path });
    const seed = record.identity_seed;
    if (seed !== undefined && typeof seed !== "string") fail("CONTRACT_INVALID", "invalid identity seed", { path });
    return {
      id: string(record.id, `${path}.documents[${index}].id`),
      kind,
      path: string(record.path, `${path}.documents[${index}].path`),
      source,
      source_sha256: string(record.source_sha256, `${path}.documents[${index}].source_sha256`),
      ...(seed === undefined ? {} : { identity_seed: seed }),
    };
  });
  const slugRoutes = array(root.slug_routes, `${path}.slug_routes`).map((item, index): SlugRouteContract => {
    const record = object(item, `${path}.slug_routes[${index}]`);
    const kind = string(record.kind, `${path}.slug_routes[${index}].kind`);
    if (kind !== "song" && kind !== "set") fail("CONTRACT_INVALID", "invalid slug route kind", { path });
    return {
      kind,
      slug: string(record.slug, `${path}.slug_routes[${index}].slug`),
      path: string(record.path, `${path}.slug_routes[${index}].path`),
      document_id: string(record.document_id, `${path}.slug_routes[${index}].document_id`),
    };
  });
  const entries = array(root.set_entries, `${path}.set_entries`).map((item, index): SetEntryIdentityContract => {
    const record = object(item, `${path}.set_entries[${index}]`);
    const classification = string(record.classification, `${path}.set_entries[${index}].classification`);
    if (classification !== "resolved canonical file" && classification !== "unresolved: reference") {
      fail("CONTRACT_INVALID", "invalid Set Entry classification", { path });
    }
    const targetPath = record.target_path;
    const targetDocumentId = record.target_document_id;
    if (targetPath !== undefined && typeof targetPath !== "string") fail("CONTRACT_INVALID", "invalid target path", { path });
    if (targetDocumentId !== undefined && typeof targetDocumentId !== "string") fail("CONTRACT_INVALID", "invalid target document ID", { path });
    return {
      id: string(record.id, `${path}.set_entries[${index}].id`),
      set_id: string(record.set_id, `${path}.set_entries[${index}].set_id`),
      set_path: string(record.set_path, `${path}.set_entries[${index}].set_path`),
      ordinal: number(record.ordinal, `${path}.set_entries[${index}].ordinal`),
      fingerprint: string(record.fingerprint, `${path}.set_entries[${index}].fingerprint`),
      fingerprint_occurrence: number(record.fingerprint_occurrence, `${path}.set_entries[${index}].fingerprint_occurrence`),
      source_content: string(record.source_content, `${path}.set_entries[${index}].source_content`),
      label: string(record.label, `${path}.set_entries[${index}].label`),
      target: string(record.target, `${path}.set_entries[${index}].target`),
      classification,
      identity_seed: string(record.identity_seed, `${path}.set_entries[${index}].identity_seed`),
      ...(targetPath === undefined ? {} : { target_path: targetPath }),
      ...(targetDocumentId === undefined ? {} : { target_document_id: targetDocumentId }),
    };
  });
  return {
    schema_version: string(root.schema_version, `${path}.schema_version`),
    baseline: {
      ref: string(baseline.ref, `${path}.baseline.ref`),
      commit: string(baseline.commit, `${path}.baseline.commit`),
    },
    namespace_uuid: string(root.namespace_uuid, `${path}.namespace_uuid`),
    counts: {
      documents: number(counts.documents, `${path}.counts.documents`),
      declared_document_ids: number(counts.declared_document_ids, `${path}.counts.declared_document_ids`),
      sidecar_document_ids: number(counts.sidecar_document_ids, `${path}.counts.sidecar_document_ids`),
      slug_routes: number(counts.slug_routes, `${path}.counts.slug_routes`),
      set_entries: number(counts.set_entries, `${path}.counts.set_entries`),
      resolved_set_entries: number(counts.resolved_set_entries, `${path}.counts.resolved_set_entries`),
      unresolved_set_entries: number(counts.unresolved_set_entries, `${path}.counts.unresolved_set_entries`),
    },
    documents,
    slug_routes: slugRoutes,
    set_entries: entries,
    verification: { output_sha256: string(verification.output_sha256, `${path}.verification.output_sha256`) },
  };
}
