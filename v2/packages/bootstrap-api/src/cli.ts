import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepositoryRoot } from "@songs-v2/read-model/git";
import { generateBootstrapArtifacts } from "./generate.js";
import { verifyBootstrapArtifacts } from "./verify.js";

const command = process.argv[2] ?? "check";
const repositoryRoot = findRepositoryRoot();
const dataRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../internal/v2bootstrap/data");
const chunkRoot = join(dataRoot, "chunks");
const artifacts = generateBootstrapArtifacts(repositoryRoot);
verifyBootstrapArtifacts(artifacts);

const expected = new Map<string, Uint8Array>([[join(dataRoot, "manifest.json"), artifacts.manifest]]);
for (const [name, raw] of artifacts.chunks) expected.set(join(chunkRoot, name), raw);
const actualChunks = existsSync(chunkRoot) ? readdirSync(chunkRoot).filter((name) => name.startsWith("chunk-") && name.endsWith(".json")) : [];
const stale = actualChunks.filter((name) => !artifacts.chunks.has(name)).map((name) => join(chunkRoot, name));

if (command === "check") {
  const changed = [...expected].filter(([path, raw]) => !existsSync(path) || !readFileSync(path).equals(Buffer.from(raw))).map(([path]) => path);
  if (changed.length > 0 || stale.length > 0) {
    console.error(`generated bootstrap artifacts differ:\n${[...changed, ...stale].join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("TASK-010 bootstrap artifacts: OK");
  }
} else if (command === "generate") {
  mkdirSync(chunkRoot, { recursive: true });
  for (const path of stale) rmSync(path);
  for (const [path, raw] of expected) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path) || !readFileSync(path).equals(Buffer.from(raw))) {
      writeFileSync(path, raw);
      console.log(`wrote ${path}`);
    }
  }
} else {
  console.error("usage: cli.ts [check|generate]");
  process.exitCode = 2;
}
