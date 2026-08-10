import { createHash } from "node:crypto";

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function sorted(value: unknown): unknown {
  if (typeof value === "string") {
    if (hasUnpairedSurrogate(value)) throw new Error("unpaired surrogate is outside the canonical JSON domain");
    return value;
  }
  if (typeof value === "number") {
    const text = String(value);
    const fractionalDigits = text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
    if (
      !Number.isFinite(value) || Object.is(value, -0) || /e/i.test(text) ||
      (Number.isInteger(value) ? !Number.isSafeInteger(value) : Math.abs(value) >= 1_000_000 || fractionalDigits < 1 || fractionalDigits > 6)
    ) throw new Error("number is outside the canonical JSON domain");
    return value;
  }
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.some(([key]) => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key))) throw new Error("object key is outside the canonical JSON domain");
    return Object.fromEntries(entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, sorted(item)]));
  }
  return value;
}

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(sorted(value), null, 2)}\n`, "utf8");
}

export function isCanonicalJson(raw: Uint8Array): boolean {
  try {
    const value = JSON.parse(Buffer.from(raw).toString("utf8")) as unknown;
    return Buffer.from(raw).equals(canonicalBytes(value));
  } catch {
    return false;
  }
}

export function canonicalCompactBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(sorted(value)), "utf8");
}

export function framedSha256(parts: readonly (Uint8Array | string)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = typeof part === "string" ? Buffer.from(part, "utf8") : Buffer.from(part);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length).update(bytes);
  }
  return hash.digest("hex");
}

export function verifySelfHash(value: Record<string, unknown>, expected: string, path: readonly string[]): boolean {
  const clone = structuredClone(value);
  let cursor: Record<string, unknown> = clone;
  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment];
    if (next === null || typeof next !== "object" || Array.isArray(next)) return false;
    cursor = next as Record<string, unknown>;
  }
  const last = path.at(-1);
  if (last === undefined) return false;
  cursor[last] = null;
  return sha256(canonicalBytes(clone)) === expected;
}
