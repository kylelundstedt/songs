import { createHash } from "node:crypto";

export function sha256Bytes(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function normalizeEntryContent(value: string): string {
  return value.trim().split(/\s+/u).join(" ");
}

export function entryFingerprint(value: string): string {
  return sha256Bytes(normalizeEntryContent(value));
}

function uuidBytes(uuid: string): Buffer {
  const normalized = uuid.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/iu.test(normalized)) throw new TypeError(`invalid UUID: ${uuid}`);
  return Buffer.from(normalized, "hex");
}

export function uuidV5(namespace: string, name: string): string {
  const digest = createHash("sha1").update(uuidBytes(namespace)).update(name, "utf8").digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
