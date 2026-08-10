import { execFileSync } from "node:child_process";
import { ReadModelError } from "./errors.js";

const MAX_GIT_OUTPUT = 32 * 1024 * 1024;

function git(repositoryRoot: string, args: readonly string[]): Buffer {
  try {
    return execFileSync("git", ["-C", repositoryRoot, ...args], {
      encoding: "buffer",
      maxBuffer: MAX_GIT_OUTPUT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ReadModelError("GIT_COMMAND_FAILED", `git ${args.join(" ")} failed`, { detail }, error);
  }
}

export class GitReader {
  constructor(readonly repositoryRoot: string) {}

  resolveObject(ref: string): string {
    return git(this.repositoryRoot, ["rev-parse", "--verify", ref]).toString("utf8").trim();
  }

  objectType(ref: string): string {
    return git(this.repositoryRoot, ["cat-file", "-t", ref]).toString("utf8").trim();
  }

  resolveCommit(ref: string): string {
    return git(this.repositoryRoot, ["rev-parse", "--verify", `${ref}^{commit}`]).toString("utf8").trim();
  }

  readArchive(ref: string, paths: readonly string[]): Buffer {
    return git(this.repositoryRoot, ["archive", "--format=tar", ref, ...paths]);
  }

  readBlob(ref: string, path: string): Buffer {
    if (path.startsWith("/") || path.includes("..")) {
      throw new ReadModelError("CONTRACT_INVALID", "refusing unsafe Git path", { path });
    }
    return git(this.repositoryRoot, ["show", `${ref}:${path}`]);
  }
}

export function findRepositoryRoot(start = process.cwd()): string {
  return git(start, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
}
