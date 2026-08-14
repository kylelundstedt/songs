import {
  type LeadSheetId,
  type SetEntryId,
  type SetList,
  SetListError,
  type SetListId,
  type SetListSection,
  type SetSectionId,
  requireLeadSheetPath,
  requireStableId,
  validateSetList,
} from "./model";

export const SET_LIST_PUBLICATION_SCHEMA_VERSION = "v2publish-1" as const;

export interface SetListPublicationPayload {
  readonly schema_version: typeof SET_LIST_PUBLICATION_SCHEMA_VERSION;
  readonly kind: "set-list";
  readonly path: string;
  readonly source: string;
  readonly deleted: false;
}

const SECTION_MARKER_RE = /^<!-- songs-v2-section id="([a-z0-9][a-z0-9-]{0,62})" -->$/;
const ENTRY_MARKER_RE = /^<!-- songs-v2-entry id="([a-z0-9][a-z0-9-]{0,62})" lead-sheet-id="([a-z0-9][a-z0-9-]{0,62})" -->$/;
const COLUMN_BREAK = "<!-- column-break -->";
const encoder = new TextEncoder();

function codecFail(message: string, detail?: unknown): never {
  throw new SetListError("CODEC_INVALID", message, detail);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function markdownLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function unescapeMarkdownLabel(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escaped = value[++index];
    if (escaped !== "\\" && escaped !== "[" && escaped !== "]") codecFail("Set Entry label contains a non-canonical escape");
    result += escaped;
  }
  return result;
}

function entryLine(index: number, entry: SetListSection["entries"][number]): string {
  let suffix = "";
  if (entry.singer !== "") suffix += ` — singer: ${entry.singer}`;
  if (entry.note !== "") suffix += ` — note: ${entry.note}`;
  return `${index + 1}. [${markdownLabel(entry.label)}](../${entry.targetPath})${suffix}`;
}

/** Exact, deterministic Markdown bytes consumed by fenced publication. */
export function encodeCanonicalSetListSource(input: SetList): string {
  const setList = validateSetList(input);
  const lines = [
    "---",
    "schema_version: 1",
    `id: ${yamlString(setList.id)}`,
    `title: ${yamlString(setList.title)}`,
    `date: ${yamlString(setList.date)}`,
    `location: ${yamlString(setList.location)}`,
    `band: ${yamlString(setList.band)}`,
    "status: draft",
    "---",
    "",
    `# ${setList.title}`,
    "",
  ];
  for (const [sectionIndex, section] of setList.sections.entries()) {
    if (section.columnBreakBefore) lines.push(COLUMN_BREAK, "");
    lines.push(`<!-- songs-v2-section id="${section.id}" -->`, `## ${section.heading}`, "");
    for (const [entryIndex, entry] of section.entries.entries()) {
      if (entry.columnBreakBefore) lines.push(COLUMN_BREAK);
      lines.push(
        `<!-- songs-v2-entry id="${entry.id}" lead-sheet-id="${entry.leadSheetId}" -->`,
        entryLine(entryIndex, entry),
      );
    }
    if (sectionIndex < setList.sections.length - 1 || section.entries.length > 0) lines.push("");
  }
  return `${lines.join("\n").replace(/\n+$/u, "")}\n`;
}

export function buildSetListPublicationPayload(input: SetList): SetListPublicationPayload {
  const setList = validateSetList(input);
  return Object.freeze({
    schema_version: SET_LIST_PUBLICATION_SCHEMA_VERSION,
    kind: "set-list",
    path: setList.path,
    source: encodeCanonicalSetListSource(setList),
    deleted: false,
  });
}

function parseQuotedScalar(line: string, field: string): string {
  const prefix = `${field}: `;
  if (!line.startsWith(prefix)) codecFail(`Canonical Set List is missing ${field}`);
  try {
    const value: unknown = JSON.parse(line.slice(prefix.length));
    if (typeof value !== "string") codecFail(`Canonical Set List ${field} is not a string`);
    return value;
  } catch (error) {
    if (error instanceof SetListError) throw error;
    codecFail(`Canonical Set List ${field} is not a JSON-quoted string`, error);
  }
}

function parseEntryLine(line: string, expectedOrdinal: number): Readonly<{ label: string; targetPath: string; singer: string; note: string }> {
  const prefix = `${expectedOrdinal}. [`;
  if (!line.startsWith(prefix)) codecFail("Set Entry ordinal is not canonical", { line, expectedOrdinal });
  let close = -1;
  for (let index = prefix.length; index < line.length; index++) {
    if (line[index] === "\\") {
      index++;
      continue;
    }
    if (line[index] === "]") {
      close = index;
      break;
    }
  }
  if (close < 0 || line.slice(close, close + 2) !== "](") codecFail("Set Entry link label is malformed", { line });
  const targetEnd = line.indexOf(")", close + 2);
  if (targetEnd < 0) codecFail("Set Entry link target is malformed", { line });
  const target = line.slice(close + 2, targetEnd);
  if (!target.startsWith("../songs/")) codecFail("Set Entry link must target ../songs/", { target });
  const targetPath = requireLeadSheetPath(target.slice(3));
  let remainder = line.slice(targetEnd + 1);
  let singer = "";
  let note = "";
  if (remainder.startsWith(" — singer: ")) {
    remainder = remainder.slice(" — singer: ".length);
    const noteAt = remainder.indexOf(" — note: ");
    if (noteAt >= 0) {
      singer = remainder.slice(0, noteAt);
      note = remainder.slice(noteAt + " — note: ".length);
      remainder = "";
    } else {
      singer = remainder;
      remainder = "";
    }
  } else if (remainder.startsWith(" — note: ")) {
    note = remainder.slice(" — note: ".length);
    remainder = "";
  }
  if (remainder !== "") codecFail("Set Entry suffix is not canonical", { remainder });
  return Object.freeze({ label: unescapeMarkdownLabel(line.slice(prefix.length, close)), targetPath, singer, note });
}

/**
 * Decode only the authored canonical format. Legacy source must first pass
 * through the reviewed projection/import path so IDs are never guessed.
 */
export function decodeCanonicalSetListSource(source: string, path: string): SetList {
  if (source.includes("\r") || !source.endsWith("\n")) codecFail("Canonical Set List must use LF and end with one newline");
  const lines = source.slice(0, -1).split("\n");
  if (lines.length < 14 || lines[0] !== "---" || lines[1] !== "schema_version: 1" || lines[7] !== "status: draft" || lines[8] !== "---" || lines[9] !== "") {
    codecFail("Canonical Set List front matter is invalid");
  }
  const id = requireStableId<SetListId>(parseQuotedScalar(lines[2]!, "id"), "Set List ID");
  const title = parseQuotedScalar(lines[3]!, "title");
  const date = parseQuotedScalar(lines[4]!, "date");
  const location = parseQuotedScalar(lines[5]!, "location");
  const band = parseQuotedScalar(lines[6]!, "band");
  if (lines[10] !== `# ${title}` || lines[11] !== "") codecFail("Canonical Set List H1 does not match its title");

  const sections: Array<{ id: SetSectionId; heading: string; columnBreakBefore: boolean; entries: Array<{ id: SetEntryId; leadSheetId: LeadSheetId; targetPath: string; label: string; singer: string; note: string; columnBreakBefore: boolean }> }> = [];
  let index = 12;
  let pendingColumnBreak = false;
  while (index < lines.length) {
    if (lines[index] === "") {
      index++;
      continue;
    }
    if (lines[index] === COLUMN_BREAK) {
      if (pendingColumnBreak) codecFail("Consecutive column breaks are not canonical");
      pendingColumnBreak = true;
      index++;
      if (lines[index] === "") index++;
    }
    const sectionMatch = SECTION_MARKER_RE.exec(lines[index] ?? "");
    if (sectionMatch === null) codecFail("Set section ID marker is missing", { line: lines[index] });
    const sectionId = requireStableId<SetSectionId>(sectionMatch[1]!, "Set section ID");
    index++;
    const headingLine = lines[index++] ?? "";
    if (!headingLine.startsWith("## ") || headingLine.length === 3) codecFail("Set section heading is invalid", { headingLine });
    const section = { id: sectionId, heading: headingLine.slice(3), columnBreakBefore: pendingColumnBreak, entries: [] as Array<{ id: SetEntryId; leadSheetId: LeadSheetId; targetPath: string; label: string; singer: string; note: string; columnBreakBefore: boolean }> };
    pendingColumnBreak = false;
    if (lines[index] === "") index++;
    while (index < lines.length) {
      let entryColumnBreak = false;
      if (lines[index] === COLUMN_BREAK) {
        entryColumnBreak = true;
        index++;
      }
      const entryMatch = ENTRY_MARKER_RE.exec(lines[index] ?? "");
      if (entryMatch === null) {
        if (entryColumnBreak) codecFail("Column break is not followed by a Set Entry");
        break;
      }
      index++;
      const parsed = parseEntryLine(lines[index++] ?? "", section.entries.length + 1);
      section.entries.push({
        id: requireStableId<SetEntryId>(entryMatch[1]!, "Set Entry ID"),
        leadSheetId: requireStableId<LeadSheetId>(entryMatch[2]!, "Lead-sheet ID"),
        ...parsed,
        columnBreakBefore: entryColumnBreak,
      });
    }
    sections.push(section);
  }
  if (pendingColumnBreak) codecFail("Trailing column break is not canonical");
  const setList = validateSetList({ id, path, title, date, location, band, sections });
  if (encodeCanonicalSetListSource(setList) !== source) codecFail("Set List source is not in exact canonical form");
  return setList;
}

function compareCanonicalKeys(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index]! - rightBytes[index]!;
  }
  return leftBytes.length - rightBytes.length;
}

function canonicalString(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    // Go encoding/json escapes these runes even inside otherwise valid UTF-8.
    return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (character) => {
      const code = character.codePointAt(0)!;
      return `\\u${code.toString(16).padStart(4, "0")}`;
    });
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) codecFail("Number is outside the canonical JSON domain");
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) codecFail("Integer is outside the canonical JSON domain");
      return String(value);
    }
    const text = String(value);
    const dot = text.indexOf(".");
    const fractionalDigits = dot < 0 ? 0 : text.length - dot - 1;
    if (Math.abs(value) >= 1_000_000 || /[eE]/.test(text) || fractionalDigits < 1 || fractionalDigits > 6 || Number(text) !== value) {
      codecFail("Number is outside the canonical JSON domain");
    }
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.some(([, item]) => item === undefined)) codecFail("Undefined is outside the canonical JSON domain");
    entries.sort(([left], [right]) => compareCanonicalKeys(left, right));
    return `{${entries.map(([key, item]) => `${canonicalString(key)}:${canonicalString(item)}`).join(",")}}`;
  }
  codecFail("Value is outside the canonical JSON domain");
}

/** Canonical JSON bytes compatible with Go's TASK-017 HashPayload domain. */
export function canonicalJson(value: unknown): string {
  return canonicalString(value);
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle === undefined) codecFail("WebCrypto SHA-256 is unavailable");
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
