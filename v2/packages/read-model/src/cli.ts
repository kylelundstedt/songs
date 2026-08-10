import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./hash.js";
import { findRepositoryRoot } from "./git.js";
import { projectReadModel, readFrozenProjectionInput } from "./importer.js";
import { buildImportReport, renderImportReport } from "./report.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(packageRoot, "fixtures/current");
const representativePaths = ["songs/1979.md", "songs/3-am.md", "sets/2025-10-13-9tease-stripped.md"];

function outputs(repositoryRoot: string): ReadonlyMap<string, string> {
  const input = readFrozenProjectionInput(repositoryRoot);
  const snapshot = projectReadModel(input);
  const report = buildImportReport(input, snapshot);
  const representatives = representativePaths.map((path) => {
    const document = snapshot.documents.find((candidate) => candidate.path === path);
    if (!document) throw new Error(`missing representative projection: ${path}`);
    return document;
  });
  return new Map([
    [resolve(fixtureRoot, "import-report.json"), renderImportReport(report)],
    [
      resolve(fixtureRoot, "representative-projections.json"),
      canonicalJson({
        schemaVersion: "1",
        sourceBaseline: snapshot.sourceBaseline,
        evidenceBaseline: snapshot.evidenceBaseline,
        documents: representatives,
      }),
    ],
  ]);
}

function main(): number {
  const mode = process.argv[2] ?? "check";
  if (mode !== "generate" && mode !== "check") {
    console.error("usage: cli.ts [generate|check]");
    return 2;
  }
  const generated = outputs(findRepositoryRoot());
  let changed = false;
  for (const [path, content] of generated) {
    const current = (() => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    })();
    if (current === content) continue;
    changed = true;
    if (mode === "generate") {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, "utf8");
      console.log(`wrote ${path}`);
    } else {
      console.error(`generated fixture differs: ${path}`);
    }
  }
  if (mode === "check" && changed) return 1;
  if (mode === "check") console.log("TASK-009 read-model fixtures: OK");
  return 0;
}

process.exitCode = main();
