import type { VerifiedSnapshot } from "../bootstrap/types";

export type LibraryIndexErrorCode = "CONTRACT_MISMATCH" | "INVALID_FROZEN_DATE";

/** A fail-closed boundary between the reviewed bootstrap snapshot and library UI. */
export class LibraryIndexError extends Error {
  constructor(readonly code: LibraryIndexErrorCode, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "LibraryIndexError";
  }
}

export interface CurrentLibraryContract {
  readonly generation: string;
  readonly sourceBaseline: { readonly ref: string; readonly commit: string; readonly tagObject: string };
  readonly evidenceBaseline: { readonly ref: string; readonly commit: string; readonly tagObject: string };
  readonly counts: {
    readonly documents: number;
    readonly leadSheets: number;
    readonly setLists: number;
    readonly setSections: number;
    readonly setEntries: number;
    readonly routes: number;
    readonly resolvedSetEntries: number;
    readonly unresolvedSetEntries: number;
  };
  readonly snapshotSha256: string;
  readonly manifestSha256: string;
  readonly contractHashes: Readonly<Record<"corpus_manifest" | "identity_sidecars" | "read_model_projection", string>>;
  readonly evidenceHashes: Readonly<{
    readonly browserFitSummary: string;
    readonly rendererBaseline: string;
    readonly fitCaptures: Readonly<Record<"ipad-portrait" | "ipad-landscape" | "phone", string>>;
  }>;
  readonly readModelImplementationCommit: string;
  readonly landscapeWarningSlugs: readonly string[];
  readonly deletedSetPaths: readonly string[];
}

export const CURRENT_LIBRARY_CONTRACT: CurrentLibraryContract = Object.freeze({
  generation: "phase1-f9634173e25ef4ca4b8330a3",
  sourceBaseline: Object.freeze({
    ref: "v2-phase1-content-2026-08-10",
    commit: "17c326c8957ac2fbe623b2de0fe91a4eb0a1b4c5",
    tagObject: "62f715002da4ca54bb3f01d34489514fe671cdf7",
  }),
  evidenceBaseline: Object.freeze({
    ref: "v2-phase1-evidence-2026-08-10",
    commit: "5ea535b53b94445084586828389f44c1a5136877",
    tagObject: "6a758e72a54f870c574c5ee6a0e20d9fd35af5b5",
  }),
  counts: Object.freeze({
    documents: 373,
    leadSheets: 339,
    setLists: 34,
    setSections: 36,
    setEntries: 1_076,
    routes: 373,
    resolvedSetEntries: 1_076,
    unresolvedSetEntries: 0,
  }),
  snapshotSha256: "f9634173e25ef4ca4b8330a343ac1e2bf493880a2ad6ef4239e3540ee8400a49",
  manifestSha256: "9a5d98aa411d2e5d4c589fc161b88d057eeab6c15c7c1032d8fce6a1a1c734e0",
  contractHashes: Object.freeze({
    corpus_manifest: "a3989f52ab23d8d3be31c9df258faa6a564c82ceadb1bee6f0b8e03dce0f1a35",
    identity_sidecars: "0a4b95ae549aaf41286d41754d08cb4f66256abf84f39b30015d656014d640b6",
    read_model_projection: "9422631c30d13999f8b7bce42a2b12857adbee36be698ac5ba2ea0194961fa80",
  }),
  evidenceHashes: Object.freeze({
    browserFitSummary: "d80941d7fea462e32d1fdea0306d616c06b349562ad90836457a91794356b77d",
    rendererBaseline: "bc1c68fa4c691cff8678aafcfaaa25b2ed2a2ad2a4b0405e3228d8dad5a6371e",
    fitCaptures: Object.freeze({
      "ipad-portrait": "c47a54149645a8c416117ab91b955e630ca03ef78e45496e335b0381d8aa5332",
      "ipad-landscape": "8fb3163f1730f919f3158077a053ac65333da637d77c71d522d861993afbcb7e",
      phone: "e212471dba2066a7a3849bc0bd0aaebced10935886d012187bf5434e00673a6f",
    }),
  }),
  readModelImplementationCommit: "2cbf78adac34fab94487a7b06a782907a257303b",
  landscapeWarningSlugs: Object.freeze(["can-t-stop", "father-of-mine", "love-shack", "paradise-city", "troublemaker"]),
  deletedSetPaths: Object.freeze([
    "sets/2018-02-24-20180224-bv.md",
    "sets/2021-07-10-mattmere-wedding-ff.md",
    "sets/2021-08-05-berry-bros-guitar-notes.md",
    "sets/2021-08-05-city-party-ff.md",
    "sets/2021-08-07-banned.md",
    "sets/2021-10-02-ff-sarah-s-50th-candidate.md",
    "sets/2021-10-02-oktoberfest-2021-lc-electric.md",
    "sets/2021-10-02-oktoberfest-ff.md",
    "sets/2021-12-31-nye-2021-sz-ideas.md",
    "sets/2022-07-08-acoustic-90s-ish-list-for-ted.md",
    "sets/2022-07-09-ff-nicholson-pigs-n-pinot-7-9.md",
    "sets/2022-08-04-sleazzy-tom.md",
    "sets/2022-08-27-ff-red-white-ball-8-27.md",
    "sets/2022-08-28-last-sunday-r-b-lc-electric-7-28.md",
    "sets/2022-09-22-nye-22-print.md",
    "sets/2022-09-25-last-sunday-r-b-lc-electric-set-up-inside.md",
    "sets/2022-10-01-ff-crooked-goat-campo-fina.md",
    "sets/2022-10-09-lc-elec-glen-ellen-fair.md",
    "sets/2022-12-20-gde-holiday-jam.md",
    "sets/2022-12-31-nye-22.md",
    "sets/2023-09-21-jll-lc-electric-6-27.md",
    "sets/2023-09-24-lc-acou-bv-xmas.md",
    "sets/2023-10-07-oktoberfest-10-7-2023.md",
    "sets/2023-11-25-ff-vintage-space.md",
    "sets/2023-12-01-sf-12-13-25.md",
    "sets/2023-12-03-lc-acou-bv-party.md",
  ]),
});

function mismatch(label: string, expected: unknown, actual: unknown): never {
  throw new LibraryIndexError("CONTRACT_MISMATCH", `Library snapshot does not satisfy the reviewed current contract: ${label}`, { expected, actual });
}

function expectEqual(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) mismatch(label, expected, actual);
}

function equalCodePointArrays(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

/** Extracts the immutable content-freeze day encoded in the reviewed source ref. */
export function parseFrozenDate(sourceRef: string): string {
  const match = /^v2-phase1-content-(\d{4})-(\d{2})-(\d{2})$/.exec(sourceRef);
  if (match === null) {
    throw new LibraryIndexError("INVALID_FROZEN_DATE", "Reviewed source ref does not encode a frozen calendar date", { sourceRef });
  }
  const [, year, month, day] = match;
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);
  const leap = numericYear % 4 === 0 && (numericYear % 100 !== 0 || numericYear % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (numericMonth < 1 || numericMonth > 12 || numericDay < 1 || numericDay > monthDays[numericMonth - 1]!) {
    throw new LibraryIndexError("INVALID_FROZEN_DATE", "Reviewed source ref encodes an invalid frozen calendar date", { sourceRef });
  }
  return `${year}-${month}-${day}`;
}

/**
 * Validates the projection/map invariants required to index any snapshot that
 * the runtime has already accepted cryptographically. This keeps reviewed
 * predecessor generations browseable without treating their content as the
 * exact current TASK-008 contract.
 */
export function assertVerifiedLibraryShape(snapshot: VerifiedSnapshot): void {
  const { manifest } = snapshot;
  expectEqual("snapshot document count", snapshot.documents.length, manifest.counts.documents);
  expectEqual("snapshot lead-sheet count", snapshot.leadSheets.length, manifest.counts.lead_sheets);
  expectEqual("snapshot set-list count", snapshot.setLists.length, manifest.counts.set_lists);
  expectEqual("documentsById size", snapshot.documentsById.size, manifest.counts.documents);
  expectEqual("routeByKey size", snapshot.routeByKey.size, manifest.slug_routes.length);
  expectEqual("songRouteById size", snapshot.songRouteById.size, manifest.counts.lead_sheets);

  const documentIds = new Set<string>();
  const documentPaths = new Set<string>();
  let leadSheets = 0;
  let setLists = 0;
  let sections = 0;
  let entries = 0;
  for (const document of snapshot.documents) {
    if (documentIds.has(document.id)) mismatch("unique document IDs", "no duplicate IDs", document.id);
    if (documentPaths.has(document.path)) mismatch("unique document paths", "no duplicate paths", document.path);
    if (snapshot.documentsById.get(document.id) !== document) mismatch(`documentsById binding for ${document.id}`, document, snapshot.documentsById.get(document.id));
    documentIds.add(document.id);
    documentPaths.add(document.path);
    const routeKind = document.kind === "lead-sheet" ? "song" : "set";
    const route = snapshot.routeByKey.get(`${routeKind}:${document.slug}`);
    if (route === undefined || route.documentId !== document.id || route.path !== document.path) mismatch(`route for ${document.path}`, document.id, route);
    if (document.kind === "lead-sheet") {
      leadSheets += 1;
      if (snapshot.songRouteById.get(document.id) !== route) mismatch(`song route binding for ${document.id}`, route, snapshot.songRouteById.get(document.id));
      const profiles = new Set(document.fit.profiles.map((profile) => profile.profile));
      if (profiles.size !== 3 || !["ipad-portrait", "ipad-landscape", "phone"].every((profile) => profiles.has(profile as "ipad-portrait"))) {
        mismatch(`fit profile coverage for ${document.id}`, ["ipad-portrait", "ipad-landscape", "phone"], [...profiles]);
      }
    } else {
      setLists += 1;
      sections += document.projection.sections.length;
      entries += document.projection.entries.length;
      for (const entry of document.projection.entries) {
        if (entry.setId !== document.id) mismatch(`Set Entry owner for ${entry.id}`, document.id, entry.setId);
        const target = snapshot.documentsById.get(entry.targetLeadSheetId);
        if (target?.kind !== "lead-sheet" || target.path !== entry.targetPath) mismatch(`resolved Set Entry target for ${entry.id}`, entry.targetPath, target);
      }
    }
  }
  expectEqual("lead-sheet documents", leadSheets, manifest.counts.lead_sheets);
  expectEqual("set-list documents", setLists, manifest.counts.set_lists);
  expectEqual("projected Set section count", sections, manifest.counts.set_sections);
  expectEqual("projected Set Entry count", entries, manifest.counts.set_entries);

  const typedLeadIds = new Set(snapshot.leadSheets.map((document) => document.id));
  const typedSetIds = new Set(snapshot.setLists.map((document) => document.id));
  if (typedLeadIds.size !== snapshot.leadSheets.length || typedSetIds.size !== snapshot.setLists.length) mismatch("unique typed snapshot arrays", "no duplicate IDs", { leadSheets: snapshot.leadSheets.length, setLists: snapshot.setLists.length });
  for (const document of snapshot.documents) {
    if (document.kind === "lead-sheet" ? !typedLeadIds.has(document.id) : !typedSetIds.has(document.id)) mismatch(`typed snapshot membership for ${document.id}`, document.kind, "missing");
  }

  const routeKeys = new Set<string>();
  for (const route of manifest.slug_routes) {
    const key = `${route.kind}:${route.slug}`;
    if (routeKeys.has(key)) mismatch("unique manifest routes", "no duplicate kind/slug routes", key);
    routeKeys.add(key);
    const document = snapshot.documentsById.get(route.documentId);
    const expectedKind = route.kind === "song" ? "lead-sheet" : "set-list";
    if (document?.kind !== expectedKind || document.path !== route.path || document.slug !== route.slug || snapshot.routeByKey.get(key) !== route) mismatch(`manifest route binding for ${key}`, route, document);
  }
  expectEqual("manifest route coverage", routeKeys.size, manifest.slug_routes.length);
  parseFrozenDate(manifest.source_baseline.ref);
}

/** Validates either the exact current contract or an already-reviewed predecessor shape. */
export function assertLibrarySnapshotContract(snapshot: VerifiedSnapshot): void {
  if (snapshot.manifest.generation === CURRENT_LIBRARY_CONTRACT.generation) assertCurrentLibraryContract(snapshot);
  else assertVerifiedLibraryShape(snapshot);
}

/**
 * Validates the exact TASK-008/010 contract needed by the library.  This is
 * deliberately narrower than bootstrap's cryptographic verification and is
 * intentionally fail-closed rather than accepting a similarly shaped future
 * generation.
 */
export function assertCurrentLibraryContract(snapshot: VerifiedSnapshot): void {
  const { manifest } = snapshot;
  const contract = CURRENT_LIBRARY_CONTRACT;

  expectEqual("manifest.schema_version", manifest.schema_version, "1");
  expectEqual("manifest.kind", manifest.kind, "songs-v2.bootstrap.manifest");
  expectEqual("manifest.generation", manifest.generation, contract.generation);
  expectEqual("manifest.snapshot_sha256", manifest.snapshot_sha256, contract.snapshotSha256);
  expectEqual("manifest.verification.output_sha256", manifest.verification.output_sha256, contract.manifestSha256);

  expectEqual("source baseline ref", manifest.source_baseline.ref, contract.sourceBaseline.ref);
  expectEqual("source baseline commit", manifest.source_baseline.commit, contract.sourceBaseline.commit);
  expectEqual("source baseline tag object", manifest.source_baseline.tag_object, contract.sourceBaseline.tagObject);
  expectEqual("evidence baseline ref", manifest.evidence_baseline.ref, contract.evidenceBaseline.ref);
  expectEqual("evidence baseline commit", manifest.evidence_baseline.commit, contract.evidenceBaseline.commit);
  expectEqual("evidence baseline tag object", manifest.evidence_baseline.tag_object, contract.evidenceBaseline.tagObject);
  parseFrozenDate(manifest.source_baseline.ref);

  expectEqual("document count", manifest.counts.documents, contract.counts.documents);
  expectEqual("lead-sheet count", manifest.counts.lead_sheets, contract.counts.leadSheets);
  expectEqual("set-list count", manifest.counts.set_lists, contract.counts.setLists);
  expectEqual("Set section count", manifest.counts.set_sections, contract.counts.setSections);
  expectEqual("Set Entry count", manifest.counts.set_entries, contract.counts.setEntries);
  expectEqual("route count", manifest.slug_routes.length, contract.counts.routes);
  expectEqual("snapshot document count", snapshot.documents.length, contract.counts.documents);
  expectEqual("snapshot lead-sheet count", snapshot.leadSheets.length, contract.counts.leadSheets);
  expectEqual("snapshot set-list count", snapshot.setLists.length, contract.counts.setLists);
  expectEqual("documentsById size", snapshot.documentsById.size, contract.counts.documents);
  expectEqual("routeByKey size", snapshot.routeByKey.size, contract.counts.routes);
  expectEqual("songRouteById size", snapshot.songRouteById.size, contract.counts.leadSheets);

  for (const [field, expected] of Object.entries(contract.contractHashes)) {
    expectEqual(`contract hash ${field}`, manifest.contract_hashes[field as keyof typeof manifest.contract_hashes], expected);
  }
  expectEqual("read-model implementation commit", manifest.read_model_anchor.implementation_commit, contract.readModelImplementationCommit);
  expectEqual("browser-fit summary hash", manifest.evidence_hashes.browser_fit_summary, contract.evidenceHashes.browserFitSummary);
  expectEqual("renderer baseline hash", manifest.evidence_hashes.renderer_baseline, contract.evidenceHashes.rendererBaseline);
  for (const profile of ["ipad-portrait", "ipad-landscape", "phone"] as const) {
    expectEqual(`fit capture ${profile}`, manifest.evidence_hashes.fit_captures[profile], contract.evidenceHashes.fitCaptures[profile]);
  }

  const documentIds = new Set<string>();
  const documentPaths = new Set<string>();
  let leadSheetDocuments = 0;
  let setListDocuments = 0;
  let sections = 0;
  let entries = 0;
  let resolvedEntries = 0;
  for (const document of snapshot.documents) {
    if (documentIds.has(document.id)) mismatch("unique document IDs", "no duplicate IDs", document.id);
    if (documentPaths.has(document.path)) mismatch("unique document paths", "no duplicate paths", document.path);
    if (snapshot.documentsById.get(document.id) !== document) mismatch(`documentsById binding for ${document.id}`, document, snapshot.documentsById.get(document.id));
    documentIds.add(document.id);
    documentPaths.add(document.path);
    const expectedKind = document.kind === "lead-sheet" ? "song" : "set";
    const route = snapshot.routeByKey.get(`${expectedKind}:${document.slug}`);
    if (route === undefined || route.documentId !== document.id || route.path !== document.path) {
      mismatch(`route for ${document.path}`, { documentId: document.id, path: document.path }, route);
    }
    if (document.kind === "lead-sheet") leadSheetDocuments += 1;
    else {
      setListDocuments += 1;
      sections += document.projection.sections.length;
      entries += document.projection.entries.length;
      for (const entry of document.projection.entries) {
        if (entry.setId !== document.id) mismatch(`Set Entry owner for ${entry.id}`, document.id, entry.setId);
        const target = snapshot.documentsById.get(entry.targetLeadSheetId);
        if (target?.kind !== "lead-sheet" || target.path !== entry.targetPath) {
          mismatch(`resolved Set Entry target for ${entry.id}`, { kind: "lead-sheet", path: entry.targetPath }, target);
        }
        resolvedEntries += 1;
      }
    }
  }
  expectEqual("lead-sheet documents", leadSheetDocuments, contract.counts.leadSheets);
  expectEqual("set-list documents", setListDocuments, contract.counts.setLists);
  const indexedLeadIds = new Set(snapshot.leadSheets.map((document) => document.id));
  const indexedSetIds = new Set(snapshot.setLists.map((document) => document.id));
  if (indexedLeadIds.size !== snapshot.leadSheets.length || indexedSetIds.size !== snapshot.setLists.length) {
    mismatch("unique typed snapshot arrays", "no duplicate IDs", { leadSheets: snapshot.leadSheets.length, setLists: snapshot.setLists.length });
  }
  for (const document of snapshot.documents) {
    if (document.kind === "lead-sheet" ? !indexedLeadIds.has(document.id) : !indexedSetIds.has(document.id)) {
      mismatch(`typed snapshot array membership for ${document.id}`, document.kind, "missing");
    }
  }
  const manifestRouteKeys = new Set<string>();
  for (const route of manifest.slug_routes) {
    const key = `${route.kind}:${route.slug}`;
    if (manifestRouteKeys.has(key)) mismatch("unique manifest routes", "no duplicate kind/slug routes", key);
    manifestRouteKeys.add(key);
    const document = snapshot.documentsById.get(route.documentId);
    const expectedKind = route.kind === "song" ? "lead-sheet" : "set-list";
    if (document?.kind !== expectedKind || document.path !== route.path || document.slug !== route.slug || snapshot.routeByKey.get(key) !== route) {
      mismatch(`manifest route binding for ${key}`, { kind: expectedKind, path: route.path, slug: route.slug }, document);
    }
  }
  expectEqual("manifest route coverage", manifestRouteKeys.size, contract.counts.routes);
  expectEqual("projected Set section count", sections, contract.counts.setSections);
  expectEqual("projected Set Entry count", entries, contract.counts.setEntries);
  expectEqual("resolved Set Entry count", resolvedEntries, contract.counts.resolvedSetEntries);
  expectEqual("unresolved Set Entry count", entries - resolvedEntries, contract.counts.unresolvedSetEntries);

  for (const deletedPath of contract.deletedSetPaths) {
    if (documentPaths.has(deletedPath)) mismatch("deleted frozen-v1 Set exclusion", "excluded", deletedPath);
  }

  const landscapeWarningSlugs: string[] = [];
  const profileCounts = {
    "ipad-portrait": { fit: 0, "needs-editing": 0, scrollable: 0 },
    "ipad-landscape": { fit: 0, "needs-editing": 0, scrollable: 0 },
    phone: { fit: 0, "needs-editing": 0, scrollable: 0 },
  };
  for (const song of snapshot.leadSheets) {
    if (song.fit === null) mismatch(`fit payload for ${song.id}`, "present", null);
    const profiles = new Set(song.fit.profiles.map((profile) => profile.profile));
    if (profiles.size !== 3 || !["ipad-portrait", "ipad-landscape", "phone"].every((profile) => profiles.has(profile as "ipad-portrait"))) {
      mismatch(`fit profile coverage for ${song.id}`, ["ipad-portrait", "ipad-landscape", "phone"], [...profiles]);
    }
    for (const profile of song.fit.profiles) {
      profileCounts[profile.profile][profile.status] += 1;
      if (profile.profile === "ipad-landscape" && profile.status === "needs-editing") {
        const route = snapshot.songRouteById.get(song.id);
        if (route === undefined) mismatch(`song route for landscape warning ${song.id}`, "route", undefined);
        landscapeWarningSlugs.push(route.slug);
      }
    }
  }
  const expectedWarnings = [...contract.landscapeWarningSlugs];
  if (!equalCodePointArrays(landscapeWarningSlugs.sort(), expectedWarnings.sort())) {
    mismatch("landscape warning slugs", expectedWarnings, landscapeWarningSlugs);
  }
  expectEqual("portrait fit count", profileCounts["ipad-portrait"].fit, contract.counts.leadSheets);
  expectEqual("portrait needs-editing count", profileCounts["ipad-portrait"]["needs-editing"], 0);
  expectEqual("portrait scrollable count", profileCounts["ipad-portrait"].scrollable, 0);
  expectEqual("landscape fit count", profileCounts["ipad-landscape"].fit, 334);
  expectEqual("landscape needs-editing count", profileCounts["ipad-landscape"]["needs-editing"], expectedWarnings.length);
  expectEqual("landscape scrollable count", profileCounts["ipad-landscape"].scrollable, 0);
  expectEqual("phone fit count", profileCounts.phone.fit, 0);
  expectEqual("phone needs-editing count", profileCounts.phone["needs-editing"], 0);
  expectEqual("phone scrollable count", profileCounts.phone.scrollable, contract.counts.leadSheets);
}
