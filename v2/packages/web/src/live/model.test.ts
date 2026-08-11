import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadVerifiedSnapshot } from "../bootstrap/load";
import type { SetListDocument, VerifiedSnapshot } from "../bootstrap/types";
import { buildLibraryIndex, type LibraryIndex } from "../library";
import {
  PerformanceSetError,
  buildPerformanceSet,
  clampOccurrenceIndex,
  nextOccurrenceIndex,
  previousOccurrenceIndex,
} from "./model";

const dataRoot = resolve(process.cwd(), "../../../internal/v2bootstrap/data");
let snapshot: VerifiedSnapshot;
let index: LibraryIndex;

beforeAll(async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = url === "/api/v2/bootstrap/manifest"
      ? resolve(dataRoot, "manifest.json")
      : resolve(dataRoot, "chunks", basename(new URL(url, "http://v2.test").pathname));
    return new Response(readFileSync(path), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
  }) as typeof fetch;
  snapshot = await loadVerifiedSnapshot({ fetchImpl, origin: "http://v2.test" });
  index = buildLibraryIndex(snapshot);
}, 20_000);

describe("PerformanceSet", () => {
  it("resolves all 34 reviewed Set Lists and all 1,076 occurrence identities", () => {
    const performanceSets = index.sets.map((set) => buildPerformanceSet(index, set));
    const entries = performanceSets.flatMap((performanceSet) => performanceSet.entries);

    expect(performanceSets).toHaveLength(34);
    expect(entries).toHaveLength(1_076);
    expect(new Set(performanceSets.map((performanceSet) => performanceSet.id)).size).toBe(34);
    expect(new Set(entries.map((entry) => entry.entryId)).size).toBe(1_076);
    expect(entries.every((entry) => entry.song.document.kind === "lead-sheet")).toBe(true);
    expect(entries.every((entry) => entry.targetPath === entry.leadSheet.path)).toBe(true);
    expect(entries.every((entry) => performanceSets.some((performanceSet) => performanceSet.id === entry.section.setId))).toBe(true);
    expect(entries.every((entry) => entry.fit.portrait.profile === "ipad-portrait")).toBe(true);
    expect(entries.every((entry) => entry.fit.landscape.profile === "ipad-landscape")).toBe(true);
    expect(entries.every((entry) => entry.fit.phone.profile === "phone")).toBe(true);
  });

  it("keeps duplicate song occurrences distinct and in authored order", () => {
    const set = index.setById("2021-05-15-murphy-s-lc-acoustic")!;
    const performanceSet = buildPerformanceSet(index, set);
    const duplicateTarget = "song-09f736c7-57e9-59a5-91f8-7327f399cbb7";
    const duplicateOccurrences = performanceSet.entries.filter((entry) => entry.targetLeadSheetId === duplicateTarget);

    expect(duplicateOccurrences).toHaveLength(2);
    expect(duplicateOccurrences[0]!.entryId).not.toBe(duplicateOccurrences[1]!.entryId);
    expect(duplicateOccurrences[0]!.ordinal).toBeLessThan(duplicateOccurrences[1]!.ordinal);
    expect(duplicateOccurrences[0]!.entry).not.toBe(duplicateOccurrences[1]!.entry);
    expect(performanceSet.entries.map((entry) => entry.ordinal)).toEqual(
      [...performanceSet.entries.keys()].map((position) => position + 1),
    );
  });

  it("exposes the latest 58-entry set and its exact Can't Stop warning occurrence", () => {
    const latest = buildPerformanceSet(index, index.recentSets[0]!);
    const cantStop = latest.entries.find((entry) => entry.song.slug === "can-t-stop");

    expect(latest.id).toBe("2025-10-13-9tease-stripped");
    expect(latest.entries).toHaveLength(58);
    expect(cantStop).toBeDefined();
    expect(cantStop).toMatchObject({
      label: "Can’t Stop",
      warning: "landscape-needs-editing",
      landscapeWarning: true,
      sectionHeading: "Set 2 - Medium",
      fit: {
        portrait: { profile: "ipad-portrait", status: "fit" },
        landscape: { profile: "ipad-landscape", status: "needs-editing" },
        phone: { profile: "phone", status: "scrollable" },
      },
    });
    expect(latest.warningOccurrences).toEqual([cantStop]);
  });

  it("preserves the five current warning fit records and marks only their set occurrences", () => {
    const performanceSets = index.sets.map((set) => buildPerformanceSet(index, set));
    const warningSlugs = new Set(index.songs.filter((song) => song.document.fit.profiles.find((fit) => fit.profile === "ipad-landscape")?.status === "needs-editing").map((song) => song.slug));

    expect(warningSlugs).toEqual(new Set(["can-t-stop", "father-of-mine", "love-shack", "paradise-city", "troublemaker"]));
    expect(new Set(performanceSets.flatMap((performanceSet) => performanceSet.warningOccurrences).map((entry) => entry.song.slug))).toEqual(new Set(["can-t-stop", "father-of-mine", "love-shack"]));
    expect(performanceSets.flatMap((performanceSet) => performanceSet.warningOccurrences)).toHaveLength(14);
  });

  it("clamps previous and next navigation to occurrence bounds", () => {
    const latest = buildPerformanceSet(index, index.recentSets[0]!);
    const last = latest.entries.length - 1;

    expect(clampOccurrenceIndex(-100, latest.length)).toBe(0);
    expect(clampOccurrenceIndex(100, latest.length)).toBe(last);
    expect(clampOccurrenceIndex(0, 0)).toBe(-1);
    expect(previousOccurrenceIndex(0, latest.length)).toBe(0);
    expect(nextOccurrenceIndex(last, latest.length)).toBe(last);
    expect(latest.previousIndex(0)).toBe(0);
    expect(latest.nextIndex(last)).toBe(last);
    expect(latest.previous(0)).toBe(latest.entries[0]);
    expect(latest.next(last)).toBe(latest.entries[last]);
    expect(latest.occurrenceAt(-1)).toBe(latest.entries[0]);
    expect(latest.occurrenceAt(999)).toBe(latest.entries[last]);
  });

  it("is immutable and accepts a VerifiedSnapshot directly", () => {
    const latest = buildPerformanceSet(snapshot, "2025-10-13-9tease-stripped");

    expect(Object.isFrozen(latest)).toBe(true);
    expect(Object.isFrozen(latest.entries)).toBe(true);
    expect(Object.isFrozen(latest.entries[0])).toBe(true);
    expect(Object.isFrozen(latest.entries[0]!.entry)).toBe(true);
    expect(Object.isFrozen(latest.entries[0]!.section)).toBe(true);
    expect(Object.isFrozen(latest.entries[0]!.fit)).toBe(true);
    expect(Object.isFrozen(latest.entries[0]!.fit.landscape)).toBe(true);
    expect(latest.entries[0]!.leadSheet.apex.html).toBe(latest.entries[0]!.apexHtml);
    expect(buildPerformanceSet(latest.set, index).id).toBe(latest.id);
  });

  it("fails closed with a typed error when an entry target path is changed", () => {
    const sourceSet = snapshot.setLists.find((set) => set.id === "2025-10-13-9tease-stripped")!;
    const changedEntry = { ...sourceSet.projection.entries[0]!, targetPath: "songs/not-the-target.md" };
    const changedDocument: SetListDocument = {
      ...sourceSet,
      projection: {
        ...sourceSet.projection,
        entries: [changedEntry, ...sourceSet.projection.entries.slice(1)],
      },
    };
    const documents = snapshot.documents.map((document) => document.id === changedDocument.id ? changedDocument : document);
    const altered: VerifiedSnapshot = {
      ...snapshot,
      documents,
      setLists: snapshot.setLists.map((set) => set.id === changedDocument.id ? changedDocument : set),
      documentsById: new Map(snapshot.documentsById).set(changedDocument.id, changedDocument),
    };

    expect(() => buildPerformanceSet(altered, changedDocument.id)).toThrow(PerformanceSetError);
    try {
      buildPerformanceSet(altered, changedDocument.id);
    } catch (error) {
      expect(error).toMatchObject({ code: "TARGET_PATH_MISMATCH" });
    }
  });
});
