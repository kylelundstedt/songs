import { execFileSync } from "node:child_process";
import { sha256 } from "./hash.js";
import { BootstrapError, type FitResult } from "./types.js";

const FROZEN_EVIDENCE_COMMIT = "5ea535b53b94445084586828389f44c1a5136877";

function readFrozenEvidenceBlob(repositoryRoot: string, path: string): Buffer {
  try {
    return execFileSync("git", ["-C", repositoryRoot, "show", `${FROZEN_EVIDENCE_COMMIT}:${path}`], {
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    });
  } catch (error) {
    fail("unable to read frozen evidence", { path, detail: error instanceof Error ? error.message : String(error) });
  }
}

const RENDERER_PATH = "migration/v2/current/renderer/renderer-baseline.json";
const FIT_SUMMARY_PATH = "migration/v2/current/renderer/browser-fit-summary.json";
const FIT_CAPTURE_PATHS = [
  "migration/v2/current/renderer/browser-fit/ipad-portrait.json",
  "migration/v2/current/renderer/browser-fit/ipad-landscape.json",
  "migration/v2/current/renderer/browser-fit/phone.json",
] as const;
const PROFILES = ["ipad-portrait", "ipad-landscape", "phone"] as const;

interface RendererRecord {
  readonly path: string;
  readonly source_sha256: string;
  readonly source_bytes: number;
  readonly rendered_html_sha256: string;
  readonly rendered_html_bytes: number;
  readonly success: boolean;
  readonly error: null;
}

interface RawFitResult {
  readonly path: string;
  readonly source_hash: string;
  readonly status: "fit" | "needs-editing" | "scrollable";
  readonly body_px: number;
  readonly auto_body_px: number;
  readonly line_height: number;
  readonly column_count: number;
  readonly viewport: { readonly client_width: number; readonly client_height: number; readonly scroll_width: number; readonly scroll_height: number };
  readonly columns: readonly { readonly client_width: number; readonly client_height: number; readonly scroll_width: number; readonly scroll_height: number }[];
}

export interface FrozenBootstrapEvidence {
  readonly rendererSha256: string;
  readonly fitSummarySha256: string;
  readonly fitCaptureSha256: Readonly<Record<string, string>>;
  readonly rendererRecords: ReadonlyMap<string, RendererRecord>;
  readonly fitRecords: ReadonlyMap<string, readonly FitResult[]>;
  readonly fitSourceHashes: ReadonlyMap<string, string>;
  readonly apex: { readonly version_output: string; readonly sha256: string; readonly flags: readonly string[] };
  readonly physicalIpad: { readonly status: "pending"; readonly note: string };
}

function fail(message: string, context: Readonly<Record<string, unknown>> = {}): never {
  throw new BootstrapError("EVIDENCE_INVALID", message, context);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function parse(raw: Uint8Array, label: string): Record<string, unknown> {
  try {
    return object(JSON.parse(Buffer.from(raw).toString("utf8")) as unknown, label);
  } catch (error) {
    fail(`invalid ${label} JSON`, { detail: error instanceof Error ? error.message : String(error) });
  }
}

function evidenceSelfHash(value: Record<string, unknown>, expected: string): boolean {
  const clone = structuredClone(value);
  const verification = object(clone.verification, "evidence verification");
  verification.output_sha256 = null;
  return sha256(Buffer.from(`${JSON.stringify(clone, null, 2)}\n`, "utf8")) === expected;
}

export function loadFrozenBootstrapEvidence(repositoryRoot: string): FrozenBootstrapEvidence {
  const rendererRaw = readFrozenEvidenceBlob(repositoryRoot, RENDERER_PATH);
  const renderer = parse(rendererRaw, "renderer baseline");
  const rendererVerification = object(renderer.verification, "renderer verification");
  const rendererOutput = rendererVerification.output_sha256;
  if (typeof rendererOutput !== "string" || !evidenceSelfHash(renderer, rendererOutput)) {
    fail("renderer baseline self-hash mismatch");
  }
  const baseline = object(renderer.baseline, "renderer baseline source");
  if (baseline.ref !== "v2-phase1-content-2026-08-10" || baseline.commit !== "17c326c8957ac2fbe623b2de0fe91a4eb0a1b4c5") {
    fail("renderer baseline source drift");
  }
  const apexRaw = object(renderer.apex, "renderer Apex identity");
  if (typeof apexRaw.version_output !== "string" || typeof apexRaw.sha256 !== "string" || !Array.isArray(apexRaw.flags) || !apexRaw.flags.every((flag) => typeof flag === "string")) {
    fail("renderer Apex identity is malformed");
  }
  const corpus = object(renderer.corpus, "renderer corpus");
  if (corpus.song_count !== 339 || corpus.render_count !== 339 || corpus.success_count !== 339 || !Array.isArray(corpus.renders)) {
    fail("renderer corpus cardinality mismatch");
  }
  const rendererRecords = new Map<string, RendererRecord>();
  for (const item of corpus.renders) {
    const record = object(item, "renderer record") as unknown as RendererRecord;
    if (typeof record.path !== "string" || typeof record.source_sha256 !== "string" || typeof record.source_bytes !== "number" || typeof record.rendered_html_sha256 !== "string" || typeof record.rendered_html_bytes !== "number" || record.success !== true || record.error !== null || rendererRecords.has(record.path)) {
      fail("invalid or duplicate renderer record", { path: record.path });
    }
    rendererRecords.set(record.path, record);
  }

  const summaryRaw = readFrozenEvidenceBlob(repositoryRoot, FIT_SUMMARY_PATH);
  const summary = parse(summaryRaw, "browser fit summary");
  const summaryVerification = object(summary.verification, "fit summary verification");
  const summaryOutput = summaryVerification.output_sha256;
  if (typeof summaryOutput !== "string" || !evidenceSelfHash(summary, summaryOutput)) fail("fit summary self-hash mismatch");
  const physical = object(summary.physical_ipad, "physical iPad status");
  if (physical.status !== "pending" || typeof physical.note !== "string") fail("physical iPad gate was unexpectedly changed");
  const captures = Array.isArray(summary.captures) ? summary.captures.map((capture) => object(capture, "fit capture descriptor")) : fail("fit capture descriptors missing");

  const fitRecords = new Map<string, FitResult[]>();
  const fitSourceHashes = new Map<string, string>();
  const fitCaptureSha256: Record<string, string> = {};
  for (const capturePath of FIT_CAPTURE_PATHS) {
    const raw = readFrozenEvidenceBlob(repositoryRoot, capturePath);
    const descriptor = captures.find((capture) => capture.path === capturePath);
    const digest = sha256(raw);
    if (descriptor === undefined || descriptor.sha256 !== digest || descriptor.bytes !== raw.byteLength) fail("fit capture descriptor mismatch", { path: capturePath });
    const capture = parse(raw, "fit capture");
    const profile = object(capture.profile, "fit profile").name;
    if (!PROFILES.includes(profile as typeof PROFILES[number]) || !Array.isArray(capture.results) || capture.results.length !== 339) fail("fit capture cardinality mismatch", { path: capturePath });
    fitCaptureSha256[String(profile)] = digest;
    for (const item of capture.results) {
      const rawResult = object(item, "fit result") as unknown as RawFitResult;
      if (typeof rawResult.path !== "string" || typeof rawResult.source_hash !== "string" || !Array.isArray(rawResult.columns)) fail("malformed fit result");
      const result: FitResult = {
        profile: profile as FitResult["profile"],
        status: rawResult.status,
        body_px: rawResult.body_px,
        auto_body_px: rawResult.auto_body_px,
        line_height: rawResult.line_height,
        column_count: rawResult.column_count,
        client_width: rawResult.viewport.client_width,
        client_height: rawResult.viewport.client_height,
        scroll_width: rawResult.viewport.scroll_width,
        scroll_height: rawResult.viewport.scroll_height,
        columns: rawResult.columns,
      };
      const previousSourceHash = fitSourceHashes.get(rawResult.path);
      if (previousSourceHash !== undefined && previousSourceHash !== rawResult.source_hash) fail("fit source hash drift", { path: rawResult.path });
      fitSourceHashes.set(rawResult.path, rawResult.source_hash);
      const records = fitRecords.get(rawResult.path) ?? [];
      if (records.some((candidate) => candidate.profile === profile)) fail("duplicate fit profile", { path: rawResult.path, profile });
      records.push(result);
      fitRecords.set(rawResult.path, records);
    }
  }
  if (fitRecords.size !== 339 || [...fitRecords.values()].some((records) => records.length !== PROFILES.length)) fail("fit record path coverage mismatch");

  return {
    rendererSha256: sha256(rendererRaw),
    fitSummarySha256: sha256(summaryRaw),
    fitCaptureSha256,
    rendererRecords,
    fitRecords,
    fitSourceHashes,
    apex: { version_output: apexRaw.version_output, sha256: apexRaw.sha256, flags: apexRaw.flags as string[] },
    physicalIpad: { status: "pending", note: physical.note },
  };
}
