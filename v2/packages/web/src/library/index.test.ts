import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadVerifiedSnapshot } from "../bootstrap/load";
import type { VerifiedSnapshot } from "../bootstrap/types";
import {
  CURRENT_LIBRARY_CONTRACT,
  LibraryIndexError,
  buildLibraryIndex,
  compareCodePoints,
  normalizeSearchText,
} from "./index";

const dataRoot = resolve(process.cwd(), "../../../internal/v2bootstrap/data");
let snapshot: VerifiedSnapshot;

beforeAll(async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = url === "/api/v2/bootstrap/manifest"
      ? resolve(dataRoot, "manifest.json")
      : resolve(dataRoot, "chunks", basename(new URL(url, "http://v2.test").pathname));
    return new Response(readFileSync(path), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
  }) as typeof fetch;
  snapshot = await loadVerifiedSnapshot({ fetchImpl, origin: "http://v2.test" });
}, 20_000);

function resultIds(index: ReturnType<typeof buildLibraryIndex>, query: string): readonly string[] {
  return index.searchSongs(query).map(({ song, score, matchedFields }) => `${song.id}:${score}:${matchedFields.join(",")}`);
}

describe("LibraryIndex", () => {
  it("is deterministic over the real reviewed 373-document fixture", () => {
    const first = buildLibraryIndex(snapshot);
    const second = buildLibraryIndex(snapshot);

    expect(first.songs.map((song) => song.id)).toEqual(second.songs.map((song) => song.id));
    expect(first.sets.map((set) => set.id)).toEqual(second.sets.map((set) => set.id));
    expect(first.recentSets.map((set) => set.id)).toEqual(second.recentSets.map((set) => set.id));
    expect(resultIds(first, "tom petty")).toEqual(resultIds(second, "tom petty"));
    expect(first.diagnostics).toEqual(second.diagnostics);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.songs)).toBe(true);
    expect(Object.isFrozen(first.songs[0]!)).toBe(true);
    expect(Object.isFrozen(first.diagnostics)).toBe(true);
  });

  it("uses stable code-point ordering and only normalizes comparison text", () => {
    expect(compareCodePoints("\uE000", "\u{10000}")).toBeLessThan(0);
    expect(normalizeSearchText("Beyoncé—Live!")) .toBe("beyonce live");

    const index = buildLibraryIndex(snapshot);
    const song = index.songBySlug("can-t-stop")!;
    expect(song.title).toBe(snapshot.documentsById.get(song.id)!.projection.title);
    expect(index.searchSongs("can’t stop").map((result) => result.song.id)).toContain(song.id);
    expect(index.searchSongs("cant stop").map((result) => result.song.id)).toContain(song.id);
    expect(index.searchSongs("can t stop").map((result) => result.song.id)).toContain(song.id);
  });

  it("searches title, artist, slug, and reviewed song metadata with all tokens", () => {
    const index = buildLibraryIndex(snapshot);

    const title = index.searchSongs("3 am").find((result) => result.song.slug === "3-am")!;
    expect(title.matchedFields).toContain("title");

    const artist = index.searchSongs("matchbox twenty").find((result) => result.song.slug === "3-am")!;
    expect(artist.matchedFields).toContain("artist");

    const slug = index.searchSongs("can-t-stop").find((result) => result.song.slug === "can-t-stop")!;
    expect(slug.matchedFields).toContain("slug");

    const provider = index.searchSongs("lrclib").find((result) => result.song.slug === "3-am")!;
    expect(provider.matchedFields).toContain("sourceProvider");
    const bpm = index.searchSongs("108").find((result) => result.song.slug === "3-am")!;
    expect(bpm.matchedFields).toContain("bpm");
    expect(index.searchSongs("f sharp").map((result) => result.song.slug)).toContain("all-these-things-that-i-ve-done");
    expect(index.searchSongs("e flat").map((result) => result.song.slug)).toContain("1979");

    expect(index.searchSongs("3 matchbox").map((result) => result.song.slug)).toContain("3-am");
    expect(index.searchSongs("3 nonexistent-token")).toEqual([]);
  });

  it("searches reviewed Set List fields without searching or changing Set Entry identity", () => {
    const index = buildLibraryIndex(snapshot);
    const jackLondon = index.searchSets("jack london lodge");
    expect(jackLondon.length).toBeGreaterThan(0);
    expect(jackLondon.every((result) => result.matchedFields.includes("location") || result.matchedFields.includes("title"))).toBe(true);

    const latest = index.searchSets("2026 08 05").find((result) => result.set.id === "2025-10-13-9tease-stripped")!;
    expect(latest.matchedFields).toContain("date");
    expect(index.searchSets("2026 08 missing-token")).toEqual([]);
  });

  it("reports exact current counts, fit distributions, and deleted-baseline exclusions", () => {
    const index = buildLibraryIndex(snapshot);
    expect(index.songs).toHaveLength(339);
    expect(index.sets).toHaveLength(34);
    expect(index.diagnostics).toMatchObject({
      generation: "phase1-f9634173e25ef4ca4b8330a3",
      frozenDate: "2026-08-10",
      routeCount: 373,
      documents: { total: 373, songs: 339, sets: 34 },
      references: { total: 1076, resolved: 1076, unresolved: 0 },
      fit: {
        portrait: { total: 339, fit: 339, needsEditing: 0, scrollable: 0 },
        landscape: { total: 339, fit: 334, needsEditing: 5, scrollable: 0 },
        phone: { total: 339, fit: 0, needsEditing: 0, scrollable: 339 },
      },
    });
    expect(index.diagnostics.landscapeWarningSlugs).toEqual([
      "can-t-stop",
      "father-of-mine",
      "love-shack",
      "paradise-city",
      "troublemaker",
    ]);
    expect(index.diagnostics.excludedDeletedSetPaths).toEqual(CURRENT_LIBRARY_CONTRACT.deletedSetPaths);
    expect(index.diagnostics.excludedDeletedSetPaths).toHaveLength(26);
    for (const path of index.diagnostics.excludedDeletedSetPaths) {
      expect(index.sets.some((set) => set.path === path)).toBe(false);
    }
  });

  it("uses a configured active Set List or a deterministic latest-date fallback", () => {
    const index = buildLibraryIndex(snapshot);
    expect(index.recentSets[0]).toMatchObject({ id: "2025-10-13-9tease-stripped", date: "2026-08-05" });
    for (let indexPosition = 1; indexPosition < index.recentSets.length; indexPosition += 1) {
      const previous = index.recentSets[indexPosition - 1]!;
      const current = index.recentSets[indexPosition]!;
      expect(previous.date >= current.date).toBe(true);
      if (previous.date === current.date) expect(compareCodePoints(previous.path, current.path)).toBeLessThanOrEqual(0);
    }
    expect(index.selectPinnedSet(null)).toBe(index.recentSets[0]);
    expect(index.activeSetSelection(null)).toMatchObject({ reason: "latest-date", configuredSetId: null, set: { id: "2025-10-13-9tease-stripped" } });
    expect(index.activeSetSelection("2021-02-20-murphys")).toMatchObject({ reason: "reviewed-pin", configuredSetId: "2021-02-20-murphys", set: { id: "2021-02-20-murphys" } });
    expect(index.selectActiveSet("2021-02-20-murphys")).toMatchObject({ id: "2021-02-20-murphys" });
    expect(index.selectPinnedSet("missing-set")).toBeNull();
  });

  it("keeps an already-reviewed predecessor shape indexable when it is the active pointer", () => {
    const predecessor = {
      ...snapshot,
      manifest: {
        ...snapshot.manifest,
        generation: "phase1-reviewed-predecessor",
        snapshot_sha256: "1".repeat(64),
        read_model_anchor: { ...snapshot.manifest.read_model_anchor, implementation_commit: "1".repeat(40) },
        verification: { output_sha256: "2".repeat(64) },
      },
    } as VerifiedSnapshot;
    const index = buildLibraryIndex(predecessor);
    expect(index.diagnostics.generation).toBe("phase1-reviewed-predecessor");
    expect(index.diagnostics.contractKind).toBe("reviewed-predecessor");
    expect(index.diagnostics.excludedDeletedSetPaths).toEqual([]);
    expect(index.searchSongs("cant stop").map((result) => result.song.slug)).toEqual(["can-t-stop"]);
    expect(index.searchSets("Castello Golightly").map((result) => result.set.id)).toContain("2025-10-13-9tease-stripped");
  });

  it("fails closed when a supplied snapshot no longer satisfies the exact current contract", () => {
    const broken = {
      ...snapshot,
      manifest: { ...snapshot.manifest, counts: { ...snapshot.manifest.counts, documents: 372 } },
    } as VerifiedSnapshot;
    let error: unknown;
    try {
      buildLibraryIndex(broken);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LibraryIndexError);
    expect(error).toMatchObject({ code: "CONTRACT_MISMATCH" });
  });
});
