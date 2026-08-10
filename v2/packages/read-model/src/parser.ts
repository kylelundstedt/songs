import { posix } from "node:path";
import type {
  CorpusRecordContract,
  DocumentIdentityContract,
  SetEntryIdentityContract,
  SlugRouteContract,
} from "./contracts.js";
import { fail } from "./errors.js";
import { decodeMarkdown, h1Title, metadataBoolean, metadataString, parseMarkdownEnvelope } from "./frontmatter.js";
import { entryFingerprint, sha256Bytes, uuidV5 } from "./hash.js";
import type {
  FrozenBaseline,
  LeadSheet,
  SetEntry,
  SetList,
  SetSection,
  SetSourceNode,
  SourceEnvelope,
} from "./types.js";

export interface ProjectionContext {
  readonly sourceBaseline: FrozenBaseline;
  readonly identityNamespace: string;
  readonly record: CorpusRecordContract;
  readonly identity: DocumentIdentityContract;
  readonly route: SlugRouteContract;
  readonly raw: Uint8Array;
}

function sourceEnvelope(context: ProjectionContext): SourceEnvelope {
  return {
    ref: context.sourceBaseline.ref,
    commit: context.sourceBaseline.commit,
    path: context.record.path,
    sha256: context.record.sha256,
    bytes: context.record.bytes,
  };
}

function validateCommon(context: ProjectionContext, canonicalMarkdown: string): void {
  const actualHash = sha256Bytes(context.raw);
  if (actualHash !== context.record.sha256 || actualHash !== context.identity.source_sha256) {
    fail("SOURCE_HASH_DRIFT", `canonical source hash drift: ${context.record.path}`, {
      path: context.record.path,
      expected: context.record.sha256,
      actual: actualHash,
    });
  }
  if (context.raw.byteLength !== context.record.bytes || Buffer.byteLength(canonicalMarkdown, "utf8") !== context.record.bytes) {
    fail("SOURCE_BYTES_DRIFT", `canonical source byte count drift: ${context.record.path}`, {
      path: context.record.path,
      expected: context.record.bytes,
      actual: context.raw.byteLength,
    });
  }
  if (context.identity.path !== context.record.path || context.identity.kind !== context.record.kind) {
    fail("DOCUMENT_ID_DRIFT", `document identity contract drift: ${context.record.path}`, { path: context.record.path });
  }
  if (
    context.route.path !== context.record.path ||
    context.route.kind !== context.record.kind ||
    context.route.slug !== context.record.legacy_slug.toLowerCase() ||
    context.route.document_id !== context.identity.id
  ) {
    fail("SLUG_ROUTE_DRIFT", `slug route contract drift: ${context.record.path}`, { path: context.record.path });
  }
}

function verifyDeclaredId(context: ProjectionContext, metadata: Readonly<Record<string, import("./types.js").JsonValue>>): void {
  const declared = metadataString(metadata, "id");
  if (context.identity.source === "front-matter") {
    if (!declared || declared !== context.identity.id || declared !== context.record.front_matter_id) {
      fail("DOCUMENT_ID_DRIFT", `declared document ID drift: ${context.record.path}`, {
        path: context.record.path,
        expected: context.identity.id,
        actual: declared,
      });
    }
  } else if (declared !== undefined || context.record.front_matter_id !== null) {
    fail("DOCUMENT_ID_DRIFT", `sidecar document unexpectedly declares an ID: ${context.record.path}`, {
      path: context.record.path,
      actual: declared,
    });
  } else {
    const legacyCommit = metadataString(metadata, "legacy_source_commit");
    const legacyPath = metadataString(metadata, "legacy_source_path");
    const expectedSeed = legacyCommit && legacyPath ? `legacy-song:${legacyCommit}:${legacyPath}` : undefined;
    const seed = context.identity.identity_seed;
    const expectedId = expectedSeed === undefined ? undefined : `song-${uuidV5(context.identityNamespace, expectedSeed)}`;
    if (!seed || seed !== expectedSeed || expectedId !== context.identity.id) {
      fail("DOCUMENT_ID_DRIFT", `sidecar document ID cannot be reproduced: ${context.record.path}`, {
        path: context.record.path,
        expected: expectedId,
        actual: context.identity.id,
      });
    }
  }
}

function requiredMetadata(
  metadata: Readonly<Record<string, import("./types.js").JsonValue>>,
  key: string,
  path: string,
): string {
  const value = metadataString(metadata, key);
  if (value === undefined) fail("FRONT_MATTER_INVALID", `missing required front-matter field ${key}: ${path}`, { path });
  return value;
}

export function projectLeadSheet(context: ProjectionContext): LeadSheet {
  const canonicalMarkdown = decodeMarkdown(context.raw, context.record.path);
  validateCommon(context, canonicalMarkdown);
  const envelope = parseMarkdownEnvelope(canonicalMarkdown, context.record.path);
  verifyDeclaredId(context, envelope.frontMatter.data);
  const title = h1Title(envelope.bodyMarkdown, context.record.path);
  if (title !== context.record.title) {
    fail("TITLE_MISSING", `lead-sheet title differs from frozen manifest: ${context.record.path}`, {
      path: context.record.path,
      expected: context.record.title,
      actual: title,
    });
  }
  const optional = (key: string): string | undefined => metadataString(envelope.frontMatter.data, key);
  const performanceKey = optional("performance_key");
  const bpm = optional("bpm");
  const originalKey = optional("original_key");
  const originalBpm = optional("original_bpm");
  const sourceProvider = optional("source_provider");
  const sourceUrl = optional("source_url");
  const legacySourceCommit = optional("legacy_source_commit");
  const legacySourcePath = optional("legacy_source_path");
  return {
    id: context.identity.id,
    kind: "lead-sheet",
    path: context.record.path,
    slug: context.route.slug,
    title,
    identitySource: context.identity.source,
    source: sourceEnvelope(context),
    canonicalMarkdown,
    canonicalSourceBase64: Buffer.from(context.raw).toString("base64"),
    frontMatter: envelope.frontMatter,
    bodyMarkdown: envelope.bodyMarkdown,
    metadata: {
      artist: requiredMetadata(envelope.frontMatter.data, "artist", context.record.path),
      ...(performanceKey === undefined ? {} : { performanceKey }),
      ...(bpm === undefined ? {} : { bpm }),
      ...(originalKey === undefined ? {} : { originalKey }),
      ...(originalBpm === undefined ? {} : { originalBpm }),
      provenanceStatus: requiredMetadata(envelope.frontMatter.data, "provenance_status", context.record.path),
      ...(sourceProvider === undefined ? {} : { sourceProvider }),
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
      ...(legacySourceCommit === undefined ? {} : { legacySourceCommit }),
      ...(legacySourcePath === undefined ? {} : { legacySourcePath }),
    },
  };
}

interface MutableSection {
  readonly projectionKey: string;
  readonly setId: string;
  readonly ordinal: number;
  readonly heading?: string;
  readonly columnBreakBefore: boolean;
  readonly startLine: number;
  endLine: number;
  readonly entryIds: string[];
}

function resolveSetTarget(setPath: string, target: string, line: number): string {
  if (
    target.startsWith("/") ||
    target.startsWith("unresolved:") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(target) ||
    target.includes("?") ||
    target.includes("#")
  ) {
    fail("TARGET_MISSING", `unsupported Set Entry target: ${setPath}:${line}`, { path: setPath, line, actual: target });
  }
  const resolved = posix.normalize(posix.join(posix.dirname(setPath), target));
  if (!resolved.startsWith("songs/") || !resolved.endsWith(".md") || resolved.includes("..")) {
    fail("TARGET_MISSING", `unsafe Set Entry target: ${setPath}:${line}`, { path: setPath, line, actual: target });
  }
  return resolved;
}

function parseSetItemDetails(rawSuffix: string): { readonly singer?: string; readonly note?: string } {
  const raw = rawSuffix.trim().replace(/^[—–]+/u, "").trim();
  if (raw === "") return {};
  let singer: string | undefined;
  const notes: string[] = [];
  for (const rawSegment of raw.split("—")) {
    const segment = rawSegment.trim();
    if (segment === "") continue;
    const colon = segment.indexOf(":");
    if (colon >= 0) {
      const field = segment.slice(0, colon).trim().toLowerCase();
      const value = segment.slice(colon + 1).trim();
      if (field === "singer") {
        singer = value;
        continue;
      }
      if (field === "note") {
        if (value !== "") notes.push(value);
        continue;
      }
    }
    notes.push(segment);
  }
  return {
    ...(singer === undefined || singer === "" ? {} : { singer }),
    ...(notes.length === 0 ? {} : { note: notes.join(" — ") }),
  };
}

function freezeSection(section: MutableSection): SetSection {
  return {
    projectionKey: section.projectionKey,
    identityScope: "frozen-snapshot",
    setId: section.setId,
    ordinal: section.ordinal,
    ...(section.heading === undefined ? {} : { heading: section.heading }),
    columnBreakBefore: section.columnBreakBefore,
    startLine: section.startLine,
    endLine: section.endLine,
    entryIds: section.entryIds,
  };
}

export function projectSetList(context: ProjectionContext, entryContracts: readonly SetEntryIdentityContract[]): SetList {
  const canonicalMarkdown = decodeMarkdown(context.raw, context.record.path);
  validateCommon(context, canonicalMarkdown);
  const envelope = parseMarkdownEnvelope(canonicalMarkdown, context.record.path);
  verifyDeclaredId(context, envelope.frontMatter.data);
  const title = h1Title(envelope.bodyMarkdown, context.record.path);
  if (title !== context.record.title) {
    fail("TITLE_MISSING", `Set List title differs from frozen manifest: ${context.record.path}`, {
      path: context.record.path,
      expected: context.record.title,
      actual: title,
    });
  }

  const sourceNodes: SetSourceNode[] = [];
  const entries: SetEntry[] = [];
  const sections: MutableSection[] = [];
  const fingerprintOccurrences = new Map<string, number>();
  const bodyLines = envelope.bodyMarkdown.split("\n");
  let pendingColumnBreak = false;
  let pendingColumnBreakLine: number | undefined;
  let pendingHeading: string | undefined;
  let pendingHeadingLine: number | undefined;
  let currentSection: MutableSection | undefined;

  for (let index = 0; index < bodyLines.length; index += 1) {
    const raw = bodyLines[index] ?? "";
    const line = envelope.bodyStartLine + index;
    if (raw.trim() === "") {
      sourceNodes.push({ kind: "blank", line, raw });
      continue;
    }
    const h1 = /^#\s+(.+?)\s*$/u.exec(raw);
    if (h1?.[1]) {
      sourceNodes.push({ kind: "heading", level: 1, line, raw, text: h1[1].replace(/\s{2,}$/u, "").trim() });
      continue;
    }
    if (raw.trim().toLowerCase() === "<!-- column-break -->") {
      if (entries.length === 0 || pendingColumnBreak) {
        fail("SET_SECTION_INVALID", `invalid Set List column break: ${context.record.path}:${line}`, {
          path: context.record.path,
          line,
        });
      }
      pendingColumnBreak = true;
      pendingColumnBreakLine = line;
      sourceNodes.push({ kind: "column-break", line, raw });
      continue;
    }
    const h2 = /^\s*##\s+(.+?)\s*$/u.exec(raw);
    if (h2?.[1]) {
      if ((entries.length > 0 && !pendingColumnBreak) || pendingHeading !== undefined) {
        fail("SET_SECTION_INVALID", `Set heading is not attached to a new section: ${context.record.path}:${line}`, {
          path: context.record.path,
          line,
        });
      }
      pendingHeading = h2[1].trim();
      pendingHeadingLine = line;
      currentSection = undefined;
      sourceNodes.push({ kind: "heading", level: 2, line, raw, text: pendingHeading });
      continue;
    }
    const item = /^\s*(\d+)\.\s+\[([^\]]+)\]\(([^)]+)\)\s*(.*)$/u.exec(raw);
    if (!item?.[1] || item[2] === undefined || item[3] === undefined || item[4] === undefined) {
      if (/^\s*\d+[.)]\s+/u.test(raw)) {
        fail("SET_ENTRY_INVALID", `malformed Set Entry: ${context.record.path}:${line}`, { path: context.record.path, line });
      }
      sourceNodes.push({ kind: "other", line, raw });
      continue;
    }

    const ordinal = entries.length + 1;
    if (Number(item[1]) !== ordinal) {
      fail("SET_ENTRY_INVALID", `Set Entry numbering drift: ${context.record.path}:${line}`, {
        path: context.record.path,
        line,
        expected: ordinal,
        actual: Number(item[1]),
      });
    }
    const contract = entryContracts[ordinal - 1];
    if (!contract) {
      fail("SET_ENTRY_CONTRACT_DRIFT", `missing Set Entry identity: ${context.record.path}:${line}`, {
        path: context.record.path,
        line,
      });
    }
    const sourceContent = raw.replace(/^\s*\d+\.\s+/u, "").trim();
    const fingerprint = entryFingerprint(sourceContent);
    const fingerprintOccurrence = (fingerprintOccurrences.get(fingerprint) ?? 0) + 1;
    fingerprintOccurrences.set(fingerprint, fingerprintOccurrence);
    const identitySeed = `set-entry:${context.identity.id}:${fingerprint}:${fingerprintOccurrence}`;
    const expectedEntryId = `entry-${uuidV5(context.identityNamespace, identitySeed)}`;
    const label = item[2];
    const target = item[3].trim();
    const suffix = item[4].trim();
    const resolvedTargetPath = resolveSetTarget(context.record.path, target, line);
    const manifestLink = context.record.links[ordinal - 1];
    if (
      !manifestLink ||
      manifestLink.label !== label ||
      manifestLink.target !== target ||
      manifestLink.classification !== "resolved canonical file" ||
      manifestLink.resolved_path !== resolvedTargetPath
    ) {
      fail("TARGET_MISSING", `Set Entry differs from frozen manifest link: ${context.record.path}:${line}`, {
        path: context.record.path,
        line,
        expected: resolvedTargetPath,
        actual: manifestLink,
      });
    }
    if (
      contract.set_id !== context.identity.id ||
      contract.set_path !== context.record.path ||
      contract.ordinal !== ordinal ||
      contract.source_content !== sourceContent ||
      contract.fingerprint !== fingerprint ||
      contract.fingerprint_occurrence !== fingerprintOccurrence ||
      contract.identity_seed !== identitySeed ||
      contract.id !== expectedEntryId ||
      contract.label !== label ||
      contract.target !== target ||
      contract.classification !== "resolved canonical file" ||
      contract.target_path !== resolvedTargetPath
    ) {
      fail("SET_ENTRY_CONTRACT_DRIFT", `Set Entry differs from frozen identity contract: ${context.record.path}:${line}`, {
        path: context.record.path,
        line,
        id: contract.id,
      });
    }
    if (
      contract.classification !== "resolved canonical file" ||
      contract.target_path === undefined ||
      contract.target_document_id === undefined
    ) {
      fail("TARGET_MISSING", `Set Entry lacks a frozen target: ${context.record.path}:${line}`, {
        path: context.record.path,
        line,
        id: contract.id,
      });
    }

    if (!currentSection) {
      const sectionOrdinal = sections.length + 1;
      const sectionSeed = `set-section-projection:${context.identity.id}:${sectionOrdinal}:${pendingHeading ?? "implicit"}:${line}`;
      currentSection = {
        projectionKey: `section-${uuidV5(context.identityNamespace, sectionSeed)}`,
        setId: context.identity.id,
        ordinal: sectionOrdinal,
        ...(pendingHeading === undefined ? {} : { heading: pendingHeading }),
        columnBreakBefore: pendingColumnBreak,
        startLine: pendingHeadingLine ?? pendingColumnBreakLine ?? line,
        endLine: line,
        entryIds: [],
      };
      sections.push(currentSection);
    }
    const details = parseSetItemDetails(suffix);
    const entry: SetEntry = {
      id: contract.id,
      setId: context.identity.id,
      sectionProjectionKey: currentSection.projectionKey,
      ordinal,
      sourceLine: line,
      columnBreakBefore: pendingColumnBreak,
      sourceContent,
      fingerprint,
      fingerprintOccurrence,
      label,
      target,
      targetPath: resolvedTargetPath,
      targetLeadSheetId: contract.target_document_id,
      ...details,
      suffix,
    };
    entries.push(entry);
    currentSection.entryIds.push(entry.id);
    currentSection.endLine = line;
    sourceNodes.push({ kind: "entry", line, raw, entryId: entry.id });
    pendingColumnBreak = false;
    pendingColumnBreakLine = undefined;
    pendingHeading = undefined;
    pendingHeadingLine = undefined;
  }

  if (pendingColumnBreak || pendingHeading !== undefined) {
    fail("SET_SECTION_INVALID", `Set List ends with an incomplete section: ${context.record.path}`, {
      path: context.record.path,
    });
  }
  if (entries.length !== entryContracts.length || entries.length !== context.record.links.length) {
    fail("SET_ENTRY_CONTRACT_DRIFT", `Set Entry count drift: ${context.record.path}`, {
      path: context.record.path,
      expected: entryContracts.length,
      actual: entries.length,
    });
  }

  const optional = (key: string): string | undefined => metadataString(envelope.frontMatter.data, key);
  const datePrecision = optional("date_precision");
  const band = optional("band");
  const sourceType = optional("source_type");
  const sourceId = optional("source_id");
  return {
    id: context.identity.id,
    kind: "set-list",
    path: context.record.path,
    slug: context.route.slug,
    title,
    identitySource: context.identity.source,
    source: sourceEnvelope(context),
    canonicalMarkdown,
    canonicalSourceBase64: Buffer.from(context.raw).toString("base64"),
    frontMatter: envelope.frontMatter,
    bodyMarkdown: envelope.bodyMarkdown,
    metadata: {
      date: requiredMetadata(envelope.frontMatter.data, "date", context.record.path),
      ...(datePrecision === undefined ? {} : { datePrecision }),
      location: requiredMetadata(envelope.frontMatter.data, "location", context.record.path),
      ...(band === undefined ? {} : { band }),
      status: requiredMetadata(envelope.frontMatter.data, "status", context.record.path),
      reviewRequired: metadataBoolean(envelope.frontMatter.data, "review_required"),
      ...(sourceType === undefined ? {} : { sourceType }),
      ...(sourceId === undefined ? {} : { sourceId }),
    },
    sections: sections.map(freezeSection),
    entries,
    sourceNodes,
  };
}
