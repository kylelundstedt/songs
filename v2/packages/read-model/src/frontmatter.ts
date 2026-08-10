import { parseDocument } from "yaml";
import { ReadModelError, fail } from "./errors.js";
import type { FrontMatterProjection, JsonValue } from "./types.js";

export interface ParsedMarkdownEnvelope {
  readonly canonicalMarkdown: string;
  readonly frontMatter: FrontMatterProjection;
  readonly bodyMarkdown: string;
  readonly bodyStartLine: number;
}

function jsonValue(value: unknown, path: string, ancestors = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") {
    fail("FRONT_MATTER_INVALID", `unsupported YAML value at ${path}`, { path, actual: value });
  }
  if (ancestors.has(value)) fail("FRONT_MATTER_INVALID", `recursive YAML alias at ${path}`, { path });
  ancestors.add(value);
  let result: JsonValue;
  if (Array.isArray(value)) {
    result = value.map((item, index) => jsonValue(item, `${path}[${index}]`, ancestors));
  } else {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      fail("FRONT_MATTER_INVALID", `unsupported YAML object at ${path}`, { path });
    }
    const objectResult = Object.create(null) as Record<string, JsonValue>;
    for (const [key, child] of Object.entries(value)) objectResult[key] = jsonValue(child, `${path}.${key}`, ancestors);
    result = objectResult;
  }
  ancestors.delete(value);
  return result;
}

export function decodeMarkdown(raw: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (error) {
    throw new ReadModelError("INVALID_UTF8", `canonical Markdown is not valid UTF-8: ${path}`, { path }, error);
  }
}

export function parseMarkdownEnvelope(canonicalMarkdown: string, path: string): ParsedMarkdownEnvelope {
  const match = /^---(?:\r\n|\n|\r)(.*?)(?:\r\n|\n|\r)---(?:(?:\r\n|\n|\r)|$)/su.exec(canonicalMarkdown);
  if (!match || match[1] === undefined) {
    fail("FRONT_MATTER_INVALID", `canonical Markdown lacks valid front matter: ${path}`, { path });
  }
  const raw = match[1];
  const bodyMarkdown = canonicalMarkdown.slice(match[0].length);
  const bodyStartLine = (match[0].match(/\r\n|\n|\r/gu) ?? []).length + 1;
  const document = (() => {
    try {
      return parseDocument(raw, { prettyErrors: false, uniqueKeys: true, schema: "failsafe" });
    } catch (error) {
      fail("FRONT_MATTER_INVALID", `invalid YAML front matter: ${path}`, { path, detail: String(error) });
    }
  })();
  const diagnostics = [...document.errors, ...document.warnings];
  if (diagnostics.length > 0) {
    fail("FRONT_MATTER_INVALID", `invalid YAML front matter: ${path}`, {
      path,
      detail: diagnostics.map((error) => error.message).join("; "),
    });
  }
  const value = (() => {
    try {
      return document.toJS({ mapAsMap: false, maxAliasCount: 100 }) as unknown;
    } catch (error) {
      fail("FRONT_MATTER_INVALID", `invalid YAML aliases: ${path}`, { path, detail: String(error) });
    }
  })();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("FRONT_MATTER_INVALID", `front matter must be a mapping: ${path}`, { path, actual: value });
  }
  const data = jsonValue(value, path);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    fail("FRONT_MATTER_INVALID", `front matter must be a mapping: ${path}`, { path });
  }
  return {
    canonicalMarkdown,
    frontMatter: { raw, data },
    bodyMarkdown,
    bodyStartLine,
  };
}

export function metadataString(metadata: Readonly<Record<string, JsonValue>>, key: string): string | undefined {
  const value = metadata[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  fail("FRONT_MATTER_INVALID", `front-matter field ${key} must be scalar`, { detail: key, actual: value });
}

export function metadataBoolean(metadata: Readonly<Record<string, JsonValue>>, key: string): boolean {
  const value = metadata[key];
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^(true|false)$/iu.test(value)) return value.toLowerCase() === "true";
  fail("FRONT_MATTER_INVALID", `front-matter field ${key} must be boolean`, { detail: key, actual: value });
}

export function h1Title(bodyMarkdown: string, path: string): string {
  for (const line of bodyMarkdown.split("\n")) {
    const match = /^#\s+(.+?)\s*$/u.exec(line);
    if (match?.[1]) return match[1].replace(/\s{2,}$/u, "").trim();
  }
  fail("TITLE_MISSING", `canonical Markdown lacks an H1 title: ${path}`, { path });
}
