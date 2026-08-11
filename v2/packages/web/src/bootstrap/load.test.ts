import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCEPTED_BOOTSTRAP_TRUST,
  fetchReviewedManifest,
  loadVerifiedSnapshot,
  PREFERRED_BOOTSTRAP_TRUST,
  preflightManifestTrust,
  verifyReviewedArtifacts,
  type ReviewedBootstrapTrust,
} from "./load";
import { BootstrapClientError } from "./types";

const dataRoot = resolve(process.cwd(), "../../../internal/v2bootstrap/data");
const encoder = new TextEncoder();

function canonicalFixtureValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalFixtureValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, canonicalFixtureValue(item)]),
    );
  }
  return value;
}

function canonicalFixtureBytes(value: unknown, compact = false): Uint8Array {
  return encoder.encode(compact ? JSON.stringify(canonicalFixtureValue(value)) : `${JSON.stringify(canonicalFixtureValue(value), null, 2)}\n`);
}

function fixtureSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeSecondReviewedFixture(): { readonly manifest: Uint8Array; readonly chunks: readonly Uint8Array[]; readonly trust: ReviewedBootstrapTrust } {
  const manifest = JSON.parse(readFileSync(resolve(dataRoot, "manifest.json"), "utf8")) as any;
  const chunks = manifest.chunks.map((descriptor: any) => JSON.parse(readFileSync(resolve(dataRoot, "chunks", descriptor.path), "utf8")) as any);

  // Model a reviewed immediate predecessor with another pinned read-model commit.
  // The source documents remain unchanged, while every transitive envelope hash
  // affected by the logical snapshot generation is re-signed for this test only.
  manifest.read_model_anchor.implementation_commit = "1".repeat(40);
  const logicalSnapshot = {
    source_baseline: manifest.source_baseline,
    evidence_baseline: manifest.evidence_baseline,
    read_model_anchor: manifest.read_model_anchor,
    contract_hashes: manifest.contract_hashes,
    evidence_hashes: manifest.evidence_hashes,
    apex: manifest.apex,
    physical_ipad: manifest.physical_ipad,
    slug_routes: manifest.slug_routes,
    document_hashes: chunks.flatMap((chunk: any) => chunk.documents.map((document: any) => document.verification.document_sha256)),
  };
  manifest.snapshot_sha256 = fixtureSha256(canonicalFixtureBytes(logicalSnapshot, true));
  manifest.generation = `phase1-${manifest.snapshot_sha256.slice(0, 24)}`;

  const rawChunks = chunks.map((chunk: any, index: number) => {
    chunk.generation = manifest.generation;
    chunk.verification.output_sha256 = null;
    chunk.verification.output_sha256 = fixtureSha256(canonicalFixtureBytes(chunk, true));
    const raw = canonicalFixtureBytes(chunk);
    const descriptor = manifest.chunks[index] as any;
    descriptor.url = `/api/v2/bootstrap/${manifest.generation}/chunks/${descriptor.path}`;
    descriptor.bytes = raw.byteLength;
    descriptor.sha256 = fixtureSha256(raw);
    return raw;
  });
  manifest.verification.output_sha256 = null;
  manifest.verification.output_sha256 = fixtureSha256(canonicalFixtureBytes(manifest, true));
  const rawManifest = canonicalFixtureBytes(manifest);
  return {
    manifest: rawManifest,
    chunks: rawChunks,
    trust: Object.freeze({ manifestSha256: fixtureSha256(rawManifest), generation: manifest.generation as string }),
  };
}

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

  it("reuses a verified manifest, awaits sequential staging, and reverifies persisted raw bytes", async () => {
    const base = fixtureFetch();
    const events: string[] = [];
    const tracked = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      events.push(url.includes("manifest") ? "fetch:manifest" : `fetch:${basename(new URL(url, "http://v2.test").pathname)}`);
      return base(input, init);
    }) as typeof fetch;
    const payload = await fetchReviewedManifest({ fetchImpl: tracked, origin: "http://v2.test" });
    expect(payload.manifestSha256).toBe(PREFERRED_BOOTSTRAP_TRUST.manifestSha256);
    expect(payload.trust).toEqual(PREFERRED_BOOTSTRAP_TRUST);
    expect(ACCEPTED_BOOTSTRAP_TRUST).toEqual([PREFERRED_BOOTSTRAP_TRUST]);
    await expect(preflightManifestTrust(payload.raw)).resolves.toEqual(PREFERRED_BOOTSTRAP_TRUST);
    const chunks: Uint8Array[] = [];
    const snapshot = await loadVerifiedSnapshot({
      fetchImpl: tracked,
      origin: "http://v2.test",
      verifiedManifest: payload,
      staging: {
        begin: async (manifest, raw) => {
          expect(manifest.generation).toBe(payload.manifest.generation);
          expect(raw).not.toBe(payload.raw);
          expect(raw).toEqual(payload.raw);
          events.push("begin:start");
          await Promise.resolve();
          events.push("begin:end");
        },
        chunk: async (descriptor, raw, documents) => {
          events.push(`stage:${descriptor.path}:start`);
          expect(documents).toHaveLength(descriptor.document_count);
          chunks.push(raw);
          await Promise.resolve();
          events.push(`stage:${descriptor.path}:end`);
        },
      },
    });
    expect(events.filter((event) => event === "fetch:manifest")).toHaveLength(1);
    expect(events.indexOf("begin:end")).toBeLessThan(events.indexOf("fetch:chunk-000.json"));
    expect(events.indexOf("stage:chunk-000.json:end")).toBeLessThan(events.indexOf("fetch:chunk-001.json"));
    expect(chunks).toHaveLength(12);
    const manifestBuffer = payload.raw.buffer.slice(payload.raw.byteOffset, payload.raw.byteOffset + payload.raw.byteLength) as ArrayBuffer;
    const persisted = await verifyReviewedArtifacts(manifestBuffer, chunks, "http://v2.test");
    expect(persisted.documents).toHaveLength(snapshot.documents.length);
    expect(persisted.manifest.generation).toBe(snapshot.manifest.generation);
  }, 20_000);

  it("reports an unknown raw manifest as unsupported while network remains preferred-only", async () => {
    const current = new Uint8Array(readFileSync(resolve(dataRoot, "manifest.json")));
    const unknown = new Uint8Array(current.byteLength + 1);
    unknown.set(current);
    unknown[unknown.byteLength - 1] = 0x20;
    await expect(preflightManifestTrust(unknown)).rejects.toMatchObject({ code: "MANIFEST_UNSUPPORTED" });
    await expect(verifyReviewedArtifacts(unknown, [], "http://v2.test")).rejects.toMatchObject({ code: "MANIFEST_UNSUPPORTED" });

    const base = fixtureFetch();
    const unpreferredNetwork = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v2/bootstrap/manifest") return new Response(unknown, { status: 200, headers: { "Content-Type": "application/json" } });
      return base(input, init);
    }) as typeof fetch;
    await expect(fetchReviewedManifest({ fetchImpl: unpreferredNetwork, origin: "http://v2.test" })).rejects.toMatchObject({ code: "MANIFEST_HASH_MISMATCH" });
  });

  it("allows an injected second reviewed trust only for persisted verification", async () => {
    const retained = makeSecondReviewedFixture();
    expect(retained.trust).not.toEqual(PREFERRED_BOOTSTRAP_TRUST);
    await expect(verifyReviewedArtifacts(retained.manifest, retained.chunks, "http://v2.test")).rejects.toMatchObject({ code: "MANIFEST_UNSUPPORTED" });

    const acceptedForTest = Object.freeze([...ACCEPTED_BOOTSTRAP_TRUST, retained.trust]);
    await expect(preflightManifestTrust(retained.manifest, acceptedForTest)).resolves.toEqual(retained.trust);
    const wrongGenerationTrust = Object.freeze([{ ...retained.trust, generation: PREFERRED_BOOTSTRAP_TRUST.generation }]);
    await expect(verifyReviewedArtifacts(retained.manifest, retained.chunks, "http://v2.test", wrongGenerationTrust)).rejects.toMatchObject({ code: "MANIFEST_UNSUPPORTED" });
    const snapshot = await verifyReviewedArtifacts(retained.manifest, retained.chunks, "http://v2.test", acceptedForTest);
    expect(snapshot.documents).toHaveLength(373);
    expect(snapshot.manifest.generation).toBe(retained.trust.generation);
    expect(snapshot.manifest.read_model_anchor.implementation_commit).toBe("1".repeat(40));
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

  it("does not start staging when progress cancellation aborts after manifest verification", async () => {
    const controller = new AbortController();
    let began = false;
    await expect(loadVerifiedSnapshot({
      fetchImpl: fixtureFetch(),
      origin: "http://v2.test",
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.phase === "manifest" && progress.completed === 1) controller.abort();
      },
      staging: {
        begin: () => { began = true; },
        chunk: () => undefined,
      },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(began).toBe(false);
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
