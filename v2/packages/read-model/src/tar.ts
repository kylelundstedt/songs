import { fail } from "./errors.js";

const BLOCK = 512;

function field(block: Uint8Array, start: number, length: number, label = "header"): string {
  const end = block.subarray(start, start + length).indexOf(0);
  const bytes = block.subarray(start, end < 0 ? start + length : start + end);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch (error) {
    fail("CONTRACT_INVALID", `invalid UTF-8 in tar ${label}`, { detail: String(error) });
  }
}

function octal(block: Uint8Array, start: number, length: number, label: string): number {
  const raw = field(block, start, length, label).replaceAll("\0", "").trim();
  if (raw === "") return 0;
  if (!/^[0-7]+$/u.test(raw)) fail("CONTRACT_INVALID", `invalid tar ${label}`, { actual: raw });
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail("CONTRACT_INVALID", `unsafe tar ${label}`, { actual: raw });
  return value;
}

function verifyChecksum(block: Uint8Array, path: string): void {
  const expected = octal(block, 148, 8, "checksum");
  let actual = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : (block[index] ?? 0);
  }
  if (actual !== expected) fail("CONTRACT_INVALID", `tar checksum drift: ${path}`, { path, expected, actual });
}

function safePath(path: string): boolean {
  if (path === "" || path.startsWith("/")) return false;
  const parts = path.split("/");
  return !parts.includes("") && !parts.includes(".") && !parts.includes("..");
}

function parsePax(payload: Uint8Array): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  let offset = 0;
  while (offset < payload.byteLength) {
    const space = payload.indexOf(32, offset);
    if (space < 0) fail("CONTRACT_INVALID", "invalid PAX record length");
    const lengthText = new TextDecoder("ascii", { fatal: true }).decode(payload.subarray(offset, space));
    if (!/^[1-9][0-9]*$/u.test(lengthText)) fail("CONTRACT_INVALID", "invalid PAX record length", { actual: lengthText });
    const length = Number.parseInt(lengthText, 10);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > payload.byteLength || payload[end - 1] !== 10) {
      fail("CONTRACT_INVALID", "truncated PAX record");
    }
    let record: string;
    try {
      record = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(space + 1, end - 1));
    } catch (error) {
      fail("CONTRACT_INVALID", "invalid UTF-8 in PAX record", { detail: String(error) });
    }
    const equals = record.indexOf("=");
    if (equals <= 0) fail("CONTRACT_INVALID", "invalid PAX key/value record", { actual: record });
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (fields.has(key)) fail("CONTRACT_INVALID", `duplicate PAX field: ${key}`);
    fields.set(key, value);
    offset = end;
  }
  return fields;
}

export function parseGitArchive(
  raw: Uint8Array,
  expectedGlobalComment?: string,
): readonly { readonly path: string; readonly bytes: Uint8Array }[] {
  const files: { path: string; bytes: Uint8Array }[] = [];
  const seen = new Set<string>();
  let sawGlobalHeader = false;
  let offset = 0;
  let terminated = false;
  while (offset + BLOCK <= raw.byteLength) {
    const header = raw.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      if (offset + 2 * BLOCK > raw.byteLength || !raw.subarray(offset).every((byte) => byte === 0)) {
        fail("CONTRACT_INVALID", "invalid tar terminator");
      }
      terminated = true;
      break;
    }
    const name = field(header, 0, 100, "name");
    const prefix = field(header, 345, 155, "prefix");
    const path = prefix === "" ? name : `${prefix}/${name}`;
    verifyChecksum(header, path);
    const size = octal(header, 124, 12, "size");
    const type = String.fromCharCode(header[156] ?? 0);
    const contentStart = offset + BLOCK;
    const contentEnd = contentStart + size;
    if (contentEnd > raw.byteLength) fail("CONTRACT_INVALID", `truncated tar entry: ${path}`, { path });
    if (type === "\0" || type === "0") {
      if (!safePath(path) || (!path.startsWith("songs/") && !path.startsWith("sets/"))) {
        fail("CONTRACT_INVALID", `unsafe corpus archive path: ${path}`, { path });
      }
      if (seen.has(path)) fail("CONTRACT_INVALID", `duplicate corpus archive path: ${path}`, { path });
      seen.add(path);
      files.push({ path, bytes: raw.slice(contentStart, contentEnd) });
    } else if (type === "g") {
      if (sawGlobalHeader || files.length > 0 || path !== "pax_global_header") {
        fail("CONTRACT_INVALID", `unexpected PAX global header: ${path}`, { path });
      }
      const fields = parsePax(raw.subarray(contentStart, contentEnd));
      const comment = fields.get("comment");
      if (fields.size !== 1 || comment === undefined || (expectedGlobalComment !== undefined && comment !== expectedGlobalComment)) {
        fail("CONTRACT_INVALID", "unexpected PAX global metadata", {
          expected: expectedGlobalComment,
          actual: Object.fromEntries(fields),
        });
      }
      sawGlobalHeader = true;
    } else if (type !== "5") {
      fail("CONTRACT_INVALID", `unsupported corpus archive entry type: ${path}`, { path, actual: type });
    }
    offset = contentStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  if (!terminated) fail("CONTRACT_INVALID", "tar archive lacks a complete terminator");
  if (expectedGlobalComment !== undefined && !sawGlobalHeader) {
    fail("CONTRACT_INVALID", "tar archive lacks the pinned global commit comment", { expected: expectedGlobalComment });
  }
  return files;
}
