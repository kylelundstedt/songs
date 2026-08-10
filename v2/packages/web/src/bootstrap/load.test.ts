import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadVerifiedSnapshot } from "./load";
import { BootstrapClientError } from "./types";

const dataRoot = resolve(process.cwd(), "../../../internal/v2bootstrap/data");

function fixtureFetch(options: { readonly corruptChunk?: string; readonly status?: number; readonly contentType?: string } = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (options.status !== undefined) return new Response('{"error":"fixture"}\n', { status: options.status, headers: { "Content-Type": "application/json" } });
    const path = url === "/api/v2/bootstrap/manifest" ? resolve(dataRoot, "manifest.json") : resolve(dataRoot, "chunks", basename(new URL(url, "http://v2.test").pathname));
    let raw = readFileSync(path);
    if (options.corruptChunk !== undefined && path.endsWith(options.corruptChunk)) {
      raw = Buffer.from(raw);
      const index = Math.floor(raw.length / 2);
      raw[index] = (raw[index] ?? 0) ^ 1;
    }
    return new Response(raw, { status: 200, headers: { "Content-Type": options.contentType ?? "application/json; charset=utf-8" } });
  }) as typeof fetch;
}

describe("loadVerifiedSnapshot", () => {
  it("exposes all 373 documents only after every reviewed chunk verifies", async () => {
    const progress: string[] = [];
    const snapshot = await loadVerifiedSnapshot({
      fetchImpl: fixtureFetch(),
      origin: "http://v2.test",
      onProgress: (value) => progress.push(`${value.phase}:${value.completed}/${value.total}`),
    });
    expect(snapshot.documents).toHaveLength(373);
    expect(snapshot.leadSheets).toHaveLength(339);
    expect(snapshot.setLists).toHaveLength(34);
    expect(snapshot.manifest.counts.set_entries).toBe(1076);
    expect(snapshot.routeByKey.size).toBe(373);
    expect(progress).toContain("chunks:12/12");
    expect(progress.at(-1)).toBe("verifying:373/373");
  }, 20_000);

  it("fails closed on a corrupt chunk", async () => {
    await expect(loadVerifiedSnapshot({ fetchImpl: fixtureFetch({ corruptChunk: "chunk-004.json" }), origin: "http://v2.test" })).rejects.toMatchObject({ code: "CHUNK_HASH_MISMATCH" });
  });

  it("stops progress after the first corrupt chunk terminal failure", async () => {
    const base = fixtureFetch({ corruptChunk: "chunk-004.json" });
    const progress: string[] = [];
    const delayed = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("chunk-004.json") || String(input).includes("manifest")) return base(input, init);
      await new Promise((resolve) => setTimeout(resolve, 40));
      return base(input, init);
    }) as typeof fetch;
    await expect(loadVerifiedSnapshot({ fetchImpl: delayed, origin: "http://v2.test", onProgress: (value) => progress.push(`${value.phase}:${value.completed}`) })).rejects.toMatchObject({ code: "CHUNK_HASH_MISMATCH" });
    const terminalProgress = progress.at(-1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(progress.at(-1)).toBe(terminalProgress);
  });

  it("reports the explicit offline-first limitation without exposing a partial snapshot", async () => {
    const previous = navigator.onLine;
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    const unavailable = (async () => { throw new TypeError("offline"); }) as typeof fetch;
    try {
      await expect(loadVerifiedSnapshot({ fetchImpl: unavailable, origin: "http://v2.test" })).rejects.toMatchObject({ code: "NETWORK_OFFLINE" });
    } finally {
      Object.defineProperty(navigator, "onLine", { configurable: true, value: previous });
    }
  });

  it("maps authentication and protocol failures to typed client errors", async () => {
    await expect(loadVerifiedSnapshot({ fetchImpl: fixtureFetch({ status: 401 }), origin: "http://v2.test" })).rejects.toEqual(expect.objectContaining<Partial<BootstrapClientError>>({ code: "UNAUTHENTICATED" }));
    await expect(loadVerifiedSnapshot({ fetchImpl: fixtureFetch({ status: 307 }), origin: "http://v2.test" })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const opaqueRedirect = (async () => {
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, "type", { configurable: true, value: "opaqueredirect" });
      Object.defineProperty(response, "status", { configurable: true, value: 0 });
      return response;
    }) as typeof fetch;
    await expect(loadVerifiedSnapshot({ fetchImpl: opaqueRedirect, origin: "http://v2.test" })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(loadVerifiedSnapshot({ fetchImpl: fixtureFetch({ contentType: "text/html" }), origin: "http://v2.test" })).rejects.toMatchObject({ code: "API_PROTOCOL_INVALID" });
  });
});
