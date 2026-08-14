function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) && (!Number.isFinite(value) || Math.abs(value) >= 1_000_000 || value.toString().includes("e"))) throw new Error("Noncanonical JSON number");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, normalize(record[key])]));
  }
  throw new Error("Unsupported JSON value");
}

export function canonicalJSON(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
