import {
  type LeadSheet,
  LeadSheetError,
  type LeadSheetId,
  requireExactLeadSheetSource,
  requireLeadSheetId,
  requireLeadSheetPath,
  validateLeadSheet,
} from "./model";

export const LEAD_SHEET_PUBLICATION_SCHEMA_VERSION = "v2publish-1" as const;

export const LEAD_SHEET_METADATA_FIELDS = [
  "title",
  "artist",
  "performance_key",
  "bpm",
  "original_key",
  "original_bpm",
] as const;

export type LeadSheetMetadataField = typeof LEAD_SHEET_METADATA_FIELDS[number];
export type LeadSheetScalarStyle = "double-quoted" | "single-quoted" | "plain";

export interface FrontMatterLine {
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly key?: string;
  readonly value?: string;
  readonly style?: LeadSheetScalarStyle;
  readonly valueStart?: number;
  readonly valueEnd?: number;
}

export interface LeadSheetFrontMatterScan {
  readonly source: string;
  readonly openingEnd: number;
  readonly contentEnd: number;
  readonly closingStart: number;
  readonly closingEnd: number;
  readonly bodyStart: number;
  readonly raw: string;
  readonly body: string;
  readonly lines: readonly FrontMatterLine[];
  readonly fields: Readonly<Partial<Record<LeadSheetMetadataField, FrontMatterLine>>>;
}

export interface LeadSheetMetadata {
  readonly title?: string;
  readonly artist?: string;
  readonly performanceKey?: string;
  readonly bpm?: string;
  readonly originalKey?: string;
  readonly originalBpm?: string;
}

export interface LeadSheetMetadataPatch {
  readonly title?: string;
  readonly artist?: string;
  readonly performanceKey?: string | null;
  readonly bpm?: string | null;
  readonly originalKey?: string | null;
  readonly originalBpm?: string | null;
}

export interface NewCanonicalLeadSheet {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly artist: string;
  readonly performanceKey?: string;
  readonly bpm?: string;
  readonly originalKey?: string;
  readonly originalBpm?: string;
  /** Markdown after the canonical H1. It may be empty. */
  readonly body?: string;
}

export interface LeadSheetPublicationPayload {
  readonly schema_version: typeof LEAD_SHEET_PUBLICATION_SCHEMA_VERSION;
  readonly kind: "lead-sheet";
  readonly path: string;
  readonly source: string;
  readonly deleted: false;
}

export type LocalValidationSeverity = "error" | "warning";
export interface LocalValidationIssue {
  readonly severity: LocalValidationSeverity;
  readonly code: string;
  readonly message: string;
  readonly line?: number;
}
export interface LocalLeadSheetValidation {
  readonly authority: "local-only";
  readonly valid: boolean;
  readonly requiresServerValidation: true;
  readonly requiresApexValidation: true;
  readonly title?: string;
  readonly metadata?: LeadSheetMetadata;
  readonly issues: readonly LocalValidationIssue[];
}

const encoder = new TextEncoder();
const MANAGED = new Set<string>(LEAD_SHEET_METADATA_FIELDS);
const BPM_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;

function fail(code: "INVALID_METADATA" | "FRONT_MATTER_INVALID" | "INVALID_SOURCE", message: string, detail?: unknown): never {
  throw new LeadSheetError(code, message, detail);
}

function sourceLines(source: string, from: number, to: number): Array<{ start: number; end: number; raw: string }> {
  const result: Array<{ start: number; end: number; raw: string }> = [];
  let start = from;
  while (start < to) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 || newline >= to ? to : newline + 1;
    result.push({ start, end, raw: source.slice(start, end).replace(/\n$/u, "") });
    start = end;
  }
  return result;
}

function quotedEnd(text: string, quote: "\"" | "'"): number {
  for (let index = 1; index < text.length; index++) {
    if (quote === "\"" && text[index] === "\\") {
      index++;
      continue;
    }
    if (text[index] !== quote) continue;
    if (quote === "'" && text[index + 1] === "'") {
      index++;
      continue;
    }
    return index;
  }
  return -1;
}

function suffixIsComment(value: string): boolean {
  const trimmed = value.trimStart();
  return trimmed === "" || trimmed.startsWith("#");
}

function parseManagedScalar(rest: string): { value: string; style: LeadSheetScalarStyle; start: number; end: number } | undefined {
  const leading = rest.length - rest.trimStart().length;
  const scalar = rest.slice(leading);
  if (scalar === "") return { value: "", style: "plain", start: leading, end: leading };
  if (scalar[0] === "\"" || scalar[0] === "'") {
    const quote = scalar[0];
    const close = quotedEnd(scalar, quote);
    if (close < 0 || !suffixIsComment(scalar.slice(close + 1))) return undefined;
    const raw = scalar.slice(0, close + 1);
    try {
      const value = quote === "\"" ? JSON.parse(raw) as unknown : raw.slice(1, -1).replaceAll("''", "'");
      if (typeof value !== "string") return undefined;
      return { value, style: quote === "\"" ? "double-quoted" : "single-quoted", start: leading, end: leading + close + 1 };
    } catch {
      return undefined;
    }
  }
  let end = scalar.length;
  for (let index = 0; index < scalar.length; index++) {
    if (scalar[index] === "#" && index > 0 && /[ \t]/u.test(scalar[index - 1]!)) {
      end = index;
      break;
    }
  }
  while (end > 0 && /[ \t]/u.test(scalar[end - 1]!)) end--;
  return { value: scalar.slice(0, end), style: "plain", start: leading, end: leading + end };
}

function decodeYamlDoubleQuoted(value: string): string | undefined {
  let result = "";
  for (let index = 1; index < value.length - 1; index++) {
    const character = value[index]!;
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escaped = value[++index];
    const simple: Readonly<Record<string, string>> = {
      "0": "\0", a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b",
      " ": " ", "\"": "\"", "/": "/", "\\": "\\", N: "\u0085", _: "\u00a0", L: "\u2028", P: "\u2029",
    };
    if (escaped !== undefined && simple[escaped] !== undefined) {
      result += simple[escaped];
      continue;
    }
    const widths: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };
    const width = escaped === undefined ? undefined : widths[escaped];
    if (width === undefined) return undefined;
    const hex = value.slice(index + 1, index + 1 + width);
    if (hex.length !== width || !/^[a-f0-9]+$/iu.test(hex)) return undefined;
    const point = Number.parseInt(hex, 16);
    if (point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) return undefined;
    result += String.fromCodePoint(point);
    index += width;
  }
  return result;
}

function decodedTopLevelKey(raw: string): string | undefined {
  if (/^[a-z0-9_]+$/u.test(raw)) return raw;
  if (raw.length < 2 || raw[0] !== raw.at(-1)) return undefined;
  if (raw[0] === "'") return raw.slice(1, -1).replaceAll("''", "'");
  if (raw[0] === "\"") return decodeYamlDoubleQuoted(raw);
  return undefined;
}

function topLevelField(raw: string): { key: string; rest: string; restOffset: number } | undefined {
  if (/^[ \t]/u.test(raw)) return undefined;
  let quote: "\"" | "'" | undefined;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index]!;
    if (quote === "\"") {
      if (character === "\\") index++;
      else if (character === "\"") quote = undefined;
      continue;
    }
    if (quote === "'") {
      if (character === "'" && raw[index + 1] === "'") index++;
      else if (character === "'") quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character !== ":") continue;
    const keyRaw = raw.slice(0, index).trimEnd();
    const key = decodedTopLevelKey(keyRaw);
    if (key === undefined) return undefined;
    let restOffset = index + 1;
    while (raw[restOffset] === " " || raw[restOffset] === "\t") restOffset++;
    return { key, rest: raw.slice(restOffset), restOffset };
  }
  return undefined;
}

function hasIndentedContinuation(lines: readonly { readonly raw: string }[], index: number): boolean {
  for (let next = index + 1; next < lines.length; next++) {
    const raw = lines[next]!.raw;
    if (raw === "" || raw.trimStart().startsWith("#")) continue;
    if (/^[ \t]/u.test(raw)) return true;
    return false;
  }
  return false;
}

/**
 * Locate front matter and managed top-level scalar spans without reserializing
 * YAML. Every raw byte-equivalent JS substring remains available to callers.
 */
export function scanLeadSheetFrontMatter(input: string): LeadSheetFrontMatterScan {
  const source = requireExactLeadSheetSource(input);
  if (!source.startsWith("---\n")) fail("FRONT_MATTER_INVALID", "Lead-sheet source must start with an LF front-matter delimiter");
  let closingStart = -1;
  let closingEnd = -1;
  let cursor = 4;
  while (cursor <= source.length) {
    const newline = source.indexOf("\n", cursor);
    const end = newline < 0 ? source.length : newline;
    if (source.slice(cursor, end) === "---") {
      closingStart = cursor;
      closingEnd = newline < 0 ? end : end + 1;
      break;
    }
    if (newline < 0) break;
    cursor = newline + 1;
  }
  if (closingStart < 0) fail("FRONT_MATTER_INVALID", "Lead-sheet front matter is not terminated by an exact --- line");

  const fields: Partial<Record<LeadSheetMetadataField, FrontMatterLine>> = {};
  const rawLines = sourceLines(source, 4, closingStart);
  const lines = rawLines.map((item, index): FrontMatterLine => {
    const fieldSyntax = topLevelField(item.raw);
    if (fieldSyntax === undefined) return Object.freeze({ line: index + 2, ...item });
    const { key, rest, restOffset } = fieldSyntax;
    if (!MANAGED.has(key)) return Object.freeze({ line: index + 2, ...item, key });
    const parsed = parseManagedScalar(rest);
    if (parsed === undefined || parsed.style === "plain" && (parsed.value.startsWith("|") || parsed.value.startsWith(">") || hasIndentedContinuation(rawLines, index))) {
      return Object.freeze({ line: index + 2, ...item, key });
    }
    const restStart = item.start + restOffset;
    const line = Object.freeze({
      line: index + 2,
      ...item,
      key,
      value: parsed.value,
      style: parsed.style,
      valueStart: restStart + parsed.start,
      valueEnd: restStart + parsed.end,
    });
    const field = key as LeadSheetMetadataField;
    if (fields[field] === undefined) fields[field] = line;
    return line;
  });
  const result = {
    source,
    openingEnd: 4,
    contentEnd: closingStart,
    closingStart,
    closingEnd,
    bodyStart: closingEnd,
    raw: source.slice(4, closingStart),
    body: source.slice(closingEnd),
    lines: Object.freeze(lines),
    fields: Object.freeze(fields),
  };
  return Object.freeze(result);
}

export const scanFrontMatter = scanLeadSheetFrontMatter;

function fieldName(field: keyof LeadSheetMetadataPatch): LeadSheetMetadataField {
  switch (field) {
    case "performanceKey": return "performance_key";
    case "originalKey": return "original_key";
    case "originalBpm": return "original_bpm";
    default: return field;
  }
}

function metadataName(field: LeadSheetMetadataField): keyof LeadSheetMetadata {
  switch (field) {
    case "performance_key": return "performanceKey";
    case "original_key": return "originalKey";
    case "original_bpm": return "originalBpm";
    default: return field;
  }
}

function boundedSingleLine(value: unknown, field: LeadSheetMetadataField): string {
  const maximum = field === "title" || field === "artist" ? 512 : 128;
  if (
    typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\r\n\0]/u.test(value)
    || encoder.encode(value).byteLength > maximum
  ) {
    fail("INVALID_METADATA", `${field} must be non-empty bounded single-line UTF-8 text`, { value });
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("INVALID_METADATA", `${field} contains invalid UTF-16`, { value });
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) fail("INVALID_METADATA", `${field} contains invalid UTF-16`, { value });
  }
  if ((field === "bpm" || field === "original_bpm") && (!BPM_RE.test(value) || Number(value) <= 0 || Number(value) > 1000)) {
    fail("INVALID_METADATA", `${field} must be a decimal BPM greater than 0 and at most 1000`, { value });
  }
  return value;
}

function renderInStyle(value: string, style: LeadSheetScalarStyle, field: LeadSheetMetadataField): string {
  if (style === "double-quoted") return JSON.stringify(value);
  if (style === "single-quoted") return `'${value.replaceAll("'", "''")}'`;
  const yamlIndicator = "-?:,[]{}#&*!|>'\"%@`".includes(value[0] ?? "");
  const yamlTyped = /^(?:null|true|false|~|[-+]?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[-+]?\d+)?|[-+]?\.(?:inf|nan)|\d{4}-\d{1,2}-\d{1,2})$/iu.test(value);
  const numericMetadata = field === "bpm" || field === "original_bpm";
  if (
    value === "" || value.trim() !== value || yamlIndicator || yamlTyped && !numericMetadata || /:\s|\s#/u.test(value)
  ) {
    fail("INVALID_METADATA", "The updated value cannot be represented without changing its plain YAML quoting style", { value });
  }
  return value;
}

function uniqueManagedField(scan: LeadSheetFrontMatterScan, field: LeadSheetMetadataField): FrontMatterLine | undefined {
  const matches = scan.lines.filter((line) => line.key === field);
  if (matches.length > 1) fail("FRONT_MATTER_INVALID", `Cannot surgically update duplicate ${field} fields`);
  const line = matches[0];
  if (line !== undefined && (line.value === undefined || line.style === undefined || line.valueStart === undefined || line.valueEnd === undefined)) {
    fail("FRONT_MATTER_INVALID", `Cannot surgically update non-scalar ${field}`);
  }
  return line;
}

function markdownH1(source: string, bodyStart: number): Array<{ start: number; end: number; title: string }> {
  const result: Array<{ start: number; end: number; title: string }> = [];
  let fence: { readonly marker: "`" | "~"; readonly length: number } | undefined;
  let cursor = bodyStart;
  while (cursor <= source.length) {
    const newline = source.indexOf("\n", cursor);
    const end = newline < 0 ? source.length : newline;
    const raw = source.slice(cursor, end);
    const indentation = /^ */u.exec(raw)![0].length;
    const candidate = indentation <= 3 ? raw.slice(indentation) : "";
    if (fence === undefined) {
      const opening = /^(`{3,}|~{3,})/u.exec(candidate)?.[1];
      if (opening !== undefined) fence = { marker: opening[0] as "`" | "~", length: opening.length };
      else if (raw.startsWith("# ")) {
        const title = raw.slice(2).trim();
        if (title !== "") result.push({ start: cursor + 2, end, title });
      }
    } else {
      const closing = new RegExp(`^${fence.marker}{${fence.length},}[ \\t]*$`, "u");
      if (closing.test(candidate)) fence = undefined;
    }
    if (newline < 0) break;
    cursor = newline + 1;
  }
  return result;
}

function patchEntries(patch: LeadSheetMetadataPatch): Array<readonly [LeadSheetMetadataField, string | null]> {
  const entries: Array<readonly [LeadSheetMetadataField, string | null]> = [];
  for (const key of Object.keys(patch) as Array<keyof LeadSheetMetadataPatch>) {
    const value = patch[key];
    if (value === undefined) continue;
    const field = fieldName(key);
    if (value === null && (field === "title" || field === "artist")) fail("INVALID_METADATA", `${field} cannot be removed`);
    entries.push([field, value === null ? null : boundedSingleLine(value, field)]);
  }
  if (entries.length === 0) fail("INVALID_METADATA", "Metadata patch must contain at least one field");
  entries.sort(([left], [right]) => LEAD_SHEET_METADATA_FIELDS.indexOf(left) - LEAD_SHEET_METADATA_FIELDS.indexOf(right));
  return entries;
}

/**
 * Rewrite only requested scalar spans (and the sole H1 for title). Unknown YAML,
 * comments, ordering, quote styles, and every untouched body substring survive.
 */
export function updateLeadSheetMetadataSource(source: string, patch: LeadSheetMetadataPatch): string {
  const scan = scanLeadSheetFrontMatter(source);
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const insertions: string[] = [];
  for (const [field, value] of patchEntries(patch)) {
    const line = uniqueManagedField(scan, field);
    if (value === null) {
      if (line !== undefined) replacements.push({ start: line.start, end: line.end, value: "" });
      continue;
    }
    if (line === undefined) insertions.push(`${field}: ${JSON.stringify(value)}\n`);
    else if (line.value !== value) replacements.push({ start: line.valueStart!, end: line.valueEnd!, value: renderInStyle(value, line.style!, field) });

    if (field === "title") {
      const headings = markdownH1(source, scan.bodyStart);
      if (headings.length !== 1) fail("INVALID_SOURCE", "A title update requires exactly one non-empty H1 outside fenced blocks", { count: headings.length });
      if (headings[0]!.title !== value) replacements.push({ start: headings[0]!.start, end: headings[0]!.end, value });
    }
  }
  if (insertions.length > 0) replacements.push({ start: scan.closingStart, end: scan.closingStart, value: insertions.join("") });
  replacements.sort((left, right) => right.start - left.start || right.end - left.end);
  let result = source;
  for (const replacement of replacements) result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end);
  return requireExactLeadSheetSource(result);
}

export const updateLeadSheetMetadata = updateLeadSheetMetadataSource;

export function readLeadSheetMetadata(source: string): LeadSheetMetadata {
  const scan = scanLeadSheetFrontMatter(source);
  const result: Partial<Record<keyof LeadSheetMetadata, string>> = {};
  for (const field of LEAD_SHEET_METADATA_FIELDS) {
    const line = uniqueManagedField(scan, field);
    if (line?.value !== undefined) result[metadataName(field)] = line.value;
  }
  return Object.freeze(result);
}

function canonicalBody(body: string | undefined): string {
  if (body === undefined || body === "") return "";
  requireExactLeadSheetSource(body);
  return body.replace(/^\n+/u, "").replace(/\n*$/u, "");
}

/** Create deterministic authored source; legacy source is never routed here. */
export function encodeCanonicalLeadSheetSource(input: NewCanonicalLeadSheet): string {
  const id = requireLeadSheetId(input.id);
  requireLeadSheetPath(input.path);
  const values: Array<readonly [LeadSheetMetadataField, string | undefined]> = [
    ["title", boundedSingleLine(input.title, "title")],
    ["artist", boundedSingleLine(input.artist, "artist")],
    ["performance_key", input.performanceKey === undefined ? undefined : boundedSingleLine(input.performanceKey, "performance_key")],
    ["bpm", input.bpm === undefined ? undefined : boundedSingleLine(input.bpm, "bpm")],
    ["original_key", input.originalKey === undefined ? undefined : boundedSingleLine(input.originalKey, "original_key")],
    ["original_bpm", input.originalBpm === undefined ? undefined : boundedSingleLine(input.originalBpm, "original_bpm")],
  ];
  const lines = ["---", "schema_version: 1", `id: ${JSON.stringify(id)}`];
  for (const [field, value] of values) if (value !== undefined) lines.push(`${field}: ${JSON.stringify(value)}`);
  lines.push('provenance_status: "authored-pending-review"', "---", "", `# ${input.title}`, "");
  const body = canonicalBody(input.body);
  if (body !== "") lines.push(body, "");
  return requireExactLeadSheetSource(lines.join("\n"));
}

export function createCanonicalLeadSheet(input: NewCanonicalLeadSheet): LeadSheet {
  return validateLeadSheet({ id: input.id, path: input.path, source: encodeCanonicalLeadSheetSource(input) });
}

export function buildLeadSheetPublicationPayload(input: LeadSheet): LeadSheetPublicationPayload {
  const leadSheet = validateLeadSheet(input);
  return Object.freeze({
    schema_version: LEAD_SHEET_PUBLICATION_SCHEMA_VERSION,
    kind: "lead-sheet",
    path: leadSheet.path,
    source: leadSheet.source,
    deleted: false,
  });
}

function issue(severity: LocalValidationSeverity, code: string, message: string, line?: number): LocalValidationIssue {
  return Object.freeze({ severity, code, message, ...(line === undefined ? {} : { line }) });
}

/** Fast offline checks only. Publication still requires authoritative server/Apex validation. */
export function validateLeadSheetLocally(input: LeadSheet): LocalLeadSheetValidation {
  const issues: LocalValidationIssue[] = [];
  let metadata: LeadSheetMetadata | undefined;
  let title: string | undefined;
  try {
    const leadSheet = validateLeadSheet(input);
    const scan = scanLeadSheetFrontMatter(leadSheet.source);
    const duplicateKeys = new Map<string, number[]>();
    for (const line of scan.lines) if (line.key !== undefined) duplicateKeys.set(line.key, [...(duplicateKeys.get(line.key) ?? []), line.line]);
    for (const [key, lines] of duplicateKeys) if (lines.length > 1) issues.push(issue("error", "DUPLICATE_FRONT_MATTER_KEY", `Duplicate top-level front-matter key ${key}`, lines[1]));
    try {
      metadata = readLeadSheetMetadata(leadSheet.source);
    } catch (error) {
      issues.push(issue("error", "MANAGED_METADATA_INVALID", error instanceof Error ? error.message : String(error)));
    }
    const schema = scan.lines.find((line) => line.key === "schema_version");
    if (schema !== undefined) {
      const parsed = parseManagedScalar(schema.raw.slice(schema.raw.indexOf(":") + 1));
      if (parsed?.value !== "1") issues.push(issue("error", "SCHEMA_VERSION_INVALID", "schema_version must be 1", schema.line));
    }
    const declaredId = scan.lines.find((line) => line.key === "id");
    if (declaredId !== undefined) {
      const parsed = parseManagedScalar(declaredId.raw.slice(declaredId.raw.indexOf(":") + 1));
      if (parsed?.value !== leadSheet.id) issues.push(issue("error", "DOCUMENT_ID_MISMATCH", "Front-matter id does not match immutable lead-sheet identity", declaredId.line));
    }
    const headings = markdownH1(leadSheet.source, scan.bodyStart);
    if (headings.length !== 1) issues.push(issue("error", "H1_INVALID", `Source must contain exactly one non-empty H1; found ${headings.length}`));
    else title = headings[0]!.title;
    if (metadata?.artist === undefined || metadata.artist === "") issues.push(issue("error", "ARTIST_REQUIRED", "artist is required"));
    if (metadata?.title !== undefined && title !== undefined && metadata.title !== title) issues.push(issue("error", "TITLE_MISMATCH", "Front-matter title must match the H1 title"));
    for (const field of ["bpm", "originalBpm"] as const) {
      const value = metadata?.[field];
      if (value !== undefined && (!BPM_RE.test(value) || Number(value) <= 0 || Number(value) > 1000)) issues.push(issue("error", "BPM_INVALID", `${field} must be a decimal BPM greater than 0 and at most 1000`));
    }
  } catch (error) {
    issues.push(issue("error", "SOURCE_INVALID", error instanceof Error ? error.message : String(error)));
  }
  issues.push(issue("warning", "APEX_VALIDATION_REQUIRED", "Local checks are provisional; authoritative server and Apex validation are still required before publication"));
  return Object.freeze({
    authority: "local-only",
    valid: !issues.some((item) => item.severity === "error"),
    requiresServerValidation: true,
    requiresApexValidation: true,
    ...(title === undefined ? {} : { title }),
    ...(metadata === undefined ? {} : { metadata }),
    issues: Object.freeze(issues),
  });
}
