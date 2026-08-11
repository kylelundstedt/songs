import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import axe from "axe-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReadyApp, type ServiceWorkerState } from "./App";
import { buildLibraryIndex } from "./library";
import { loadVerifiedSnapshot } from "./bootstrap/load";
import type { BootstrapRuntimeStatus } from "./bootstrap/runtime";
import type { VerifiedSnapshot } from "./bootstrap/types";

const dataRoot = resolve(process.cwd(), "../../../internal/v2bootstrap/data");
const update: ServiceWorkerState = { state: "current", canApply: false, apply: vi.fn(async () => undefined) };
const runtime: BootstrapRuntimeStatus = {
  source: "indexeddb",
  database: "available",
  activeGeneration: "phase1-f9634173e25ef4ca4b8330a3",
  activeStorageGeneration: "phase1-f9634173e25ef4ca4b8330a3@a81aafbdef0d",
  retainedGeneration: null,
  transitions: 1,
  chunks: { completed: 12, total: 12 },
  docs: { completed: 373, total: 373 },
  chunkCount: 12,
  docCount: 373,
  documents: { completed: 373, total: 373 },
  offlineReady: true,
  update: "current",
  persistence: "denied",
  usage: 6_000_000,
  quota: 10_000_000_000,
  headroom: 9_994_000_000,
  warning: null,
};
const matchingActiveGeneration = vi.fn(async () => runtime.activeStorageGeneration ?? null);
let snapshot: VerifiedSnapshot;

function runtimeWith(patch: Partial<BootstrapRuntimeStatus>): BootstrapRuntimeStatus {
  return { ...runtime, ...patch };
}

beforeAll(async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = url === "/api/v2/bootstrap/manifest" ? resolve(dataRoot, "manifest.json") : resolve(dataRoot, "chunks", basename(new URL(url, "http://v2.test").pathname));
    return new Response(readFileSync(path), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
  }) as typeof fetch;
  snapshot = await loadVerifiedSnapshot({ fetchImpl, origin: "http://v2.test" });
}, 20_000);

describe("read-only shell", () => {
  it("renders accessible landmarks and no authoring controls", async () => {
    window.location.hash = "#/";
    const { container } = render(<ReadyApp snapshot={snapshot} online update={update} runtime={runtime} />);
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your gig book, without the edit controls" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit|save|add|delete|publish|sync/i })).not.toBeInTheDocument();
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });

  it("navigates to reviewed Apex HTML and Set List projections", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/";
    render(<ReadyApp snapshot={snapshot} online update={update} runtime={runtime} />);
    const firstSong = snapshot.leadSheets[0]!;
    await user.click(screen.getByRole("link", { name: new RegExp(firstSong.projection.title, "i") }));
    await waitFor(() => expect(screen.getAllByRole("heading", { name: firstSong.projection.title, level: 1 }).length).toBeGreaterThanOrEqual(1));
    expect(document.querySelector('[data-authority="apex"]')).toBeInTheDocument();
    expect(screen.getByText(/No browser Markdown renderer is present/)).toBeInTheDocument();
    expect((await axe.run(document.body)).violations).toEqual([]);

    window.location.hash = `#/sets/${snapshot.setLists[0]!.slug}`;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitFor(() => expect(screen.getByRole("heading", { name: snapshot.setLists[0]!.projection.title, level: 1 })).toBeInTheDocument());
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(snapshot.setLists[0]!.projection.entries.length - 1);
    expect((await axe.run(document.body)).violations).toEqual([]);
  });

  it("opens every resolved Set List detail into a locked local Live route", async () => {
    const user = userEvent.setup();
    const index = buildLibraryIndex(snapshot);
    const latest = index.recentSets[0]!;
    window.location.hash = `#/sets/${latest.slug}`;
    const { container, rerender } = render(<ReadyApp snapshot={snapshot} online update={update} runtime={runtime} inspectActiveGeneration={matchingActiveGeneration} />);
    expect(screen.getByRole("link", { name: /Open locked Live/i })).toBeInTheDocument();
    expect(container.querySelectorAll("[data-entry-id]")).toHaveLength(latest.document.projection.entries.length);
    expect(screen.getByText(/explicit iPad landscape fit warning/i)).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: /Open locked Live/i }));
    await waitFor(() => expect(screen.getByLabelText("Locked Live mode")).toBeInTheDocument());
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(screen.queryByText(/Physical iPad: pending/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Exit Live" })).toHaveAttribute("href", `#/sets/${latest.slug}`);
    expect(screen.getByText(new RegExp(`Live progress: 1/${latest.document.projection.entries.length}`))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(new RegExp(`Live progress: 2/${latest.document.projection.entries.length}`))).toBeInTheDocument();
    rerender(<ReadyApp snapshot={snapshot} online={false} update={update} runtime={runtime} inspectActiveGeneration={matchingActiveGeneration} />);
    expect(screen.getByText(new RegExp(`Live progress: 2/${latest.document.projection.entries.length}`))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit|save|add|delete|publish|sync|provider|shelley/i })).not.toBeInTheDocument();
  });

  it("uses exact Live routes and keeps them closed without a matching active pointer", () => {
    const latest = buildLibraryIndex(snapshot).recentSets[0]!;
    window.location.hash = `#/sets/${latest.slug}/live/extra`;
    const first = render(<ReadyApp snapshot={snapshot} online update={update} runtime={runtime} />);
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    first.unmount();

    window.location.hash = `#/sets/${latest.slug}/live?unexpected=1`;
    const query = render(<ReadyApp snapshot={snapshot} online update={update} runtime={runtime} />);
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    query.unmount();

    window.location.hash = `#https://example.test/sets/${latest.slug}/live`;
    const absolute = render(<ReadyApp snapshot={snapshot} online update={update} runtime={runtime} />);
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    absolute.unmount();

    const inactive = runtimeWith({ source: "network", update: "memory-only", activeGeneration: null, offlineReady: false });
    window.location.hash = `#/sets/${latest.slug}/live`;
    render(<ReadyApp snapshot={snapshot} online update={update} runtime={inactive} />);
    expect(screen.getByRole("heading", { name: /waits for an active saved snapshot/i })).toBeInTheDocument();
    expect(screen.queryByLabelText("Locked Live mode")).not.toBeInTheDocument();
  });

  it("checks the exact physical pointer before exposing locked Live and stops on mismatch", async () => {
    const latest = buildLibraryIndex(snapshot).recentSets[0]!;
    window.location.hash = `#/sets/${latest.slug}/live`;
    const mismatched = vi.fn(async () => "phase1-other@000000000000");
    render(<ReadyApp snapshot={snapshot} online update={update} runtime={runtime} inspectActiveGeneration={mismatched} />);

    expect(screen.getByLabelText("Locked Live mode checking")).toBeInTheDocument();
    expect(screen.queryByText(/Live progress:/i)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Locked Live mode stopped")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "Exit Live" })).not.toBeInTheDocument();
    expect(mismatched).toHaveBeenCalled();
  });

  it("stops a mounted Live sequence when the physical active pointer changes", async () => {
    const latest = buildLibraryIndex(snapshot).recentSets[0]!;
    let activeGeneration = runtime.activeStorageGeneration ?? null;
    const inspect = vi.fn(async () => activeGeneration);
    window.location.hash = `#/sets/${latest.slug}/live`;
    render(<ReadyApp snapshot={snapshot} online update={update} runtime={runtime} inspectActiveGeneration={inspect} />);
    await waitFor(() => expect(screen.getByLabelText("Locked Live mode")).toBeInTheDocument());

    activeGeneration = "phase1-other@000000000000";
    window.dispatchEvent(new PageTransitionEvent("pageshow"));
    await waitFor(() => expect(screen.getByLabelText("Locked Live mode stopped")).toBeInTheDocument());
    expect(screen.queryByText(/Live progress:/i)).not.toBeInTheDocument();

    activeGeneration = runtime.activeStorageGeneration ?? null;
    window.dispatchEvent(new PageTransitionEvent("pageshow"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByLabelText("Locked Live mode stopped")).toBeInTheDocument();
    expect(screen.queryByText(/Live progress:/i)).not.toBeInTheDocument();
  });

  it("keeps locked Live available after a failed update retains the matching active pointer", async () => {
    const latest = buildLibraryIndex(snapshot).recentSets[0]!;
    const retained = runtimeWith({ update: "failed-retained", warning: "preferred update unavailable" });
    window.location.hash = `#/sets/${latest.slug}/live`;
    render(<ReadyApp snapshot={snapshot} online update={update} runtime={retained} inspectActiveGeneration={matchingActiveGeneration} />);
    await waitFor(() => expect(screen.getByLabelText("Locked Live mode")).toBeInTheDocument());
    expect(screen.getByText(new RegExp(`Live progress: 1/${latest.document.projection.entries.length}`))).toBeInTheDocument();
  });

  it("keeps reviewed internal Apex links inside the isolated V2 router", async () => {
    const user = userEvent.setup();
    const linkedSong = snapshot.leadSheets.find((song) => song.apex.html.includes('href="/song/'))!;
    window.location.hash = `#/songs/${linkedSong.slug}`;
    render(<ReadyApp snapshot={snapshot} online update={update} runtime={runtime} />);
    const apex = document.querySelector<HTMLElement>('[data-authority="apex"]')!;
    const link = within(apex).getAllByRole("link")[0]!;
    const original = link.getAttribute("href")!;
    await user.click(link);
    await waitFor(() => expect(window.location.hash).toBe(`#${original.replace("/song/", "/songs/")}`));
    expect(window.location.pathname).toBe("/");
  });

  it("routes malformed percent encodings to the explicit V2 not-found page", () => {
    window.location.hash = "#/songs/%";
    render(<ReadyApp snapshot={snapshot} online update={update} runtime={runtime} />);
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByText(/does not fall through to v1/i)).toBeInTheDocument();
  });

  it("uses deterministic dashboard highlights and a latest-date active Set List without a pin control", () => {
    const index = buildLibraryIndex(snapshot);
    window.location.hash = "#/";
    render(<ReadyApp snapshot={snapshot} online update={update} runtime={runtime} />);
    expect(screen.getByRole("heading", { name: "Active Set List", level: 2 })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /9Tease Stripped/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("link", { name: new RegExp(index.songs[0]!.title, "i") })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: new RegExp(index.recentSets[0]!.title, "i") }).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: /pin|activate set/i })).not.toBeInTheDocument();
  });

  it("searches songs locally across title, key, provider, and BPM and reports no results", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/songs";
    render(<ReadyApp snapshot={snapshot} online update={update} runtime={runtime} />);
    const search = screen.getByRole("searchbox", { name: /Search songs in this local verified snapshot/i });

    await user.type(search, "cant stop");
    expect(screen.getByRole("link", { name: /Can't Stop/i })).toBeInTheDocument();
    expect(screen.getByText(/Matched fields:/i)).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "f sharp");
    expect(screen.getByRole("link", { name: /All These Things That I've Done/i })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "lrclib");
    expect(screen.getByRole("link", { name: /3 AM/i })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "108");
    expect(screen.getByRole("link", { name: /3 AM/i })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "not-a-reviewed-song");
    expect(screen.getByRole("heading", { name: "No songs found", level: 2 })).toBeInTheDocument();
    expect(screen.getByText(/No songs matched “not-a-reviewed-song”/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Clear song search/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Clear song search/i }));
    await waitFor(() => expect(search).toHaveFocus());
    expect(screen.getByText(/Showing all 339 songs/i)).toBeInTheDocument();
  });

  it("searches Set Lists locally by date and location", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/sets";
    render(<ReadyApp snapshot={snapshot} online update={update} runtime={runtime} />);
    const search = screen.getByRole("searchbox", { name: /Search Set Lists in this local verified snapshot/i });
    await user.type(search, "2026-08-05");
    expect(screen.getByRole("link", { name: /9Tease Stripped/i })).toBeInTheDocument();
    expect(screen.getByText(/Matched fields: Date/i)).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "Castello Golightly");
    expect(screen.getByRole("link", { name: /9Tease Stripped/i })).toBeInTheDocument();
    expect(screen.getAllByText(/Matched fields: Location/i).length).toBeGreaterThanOrEqual(1);
  });

  it("exposes reviewed index diagnostics, exclusions, and linked warnings in status", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/status";
    const { container } = render(<ReadyApp snapshot={snapshot} online update={update} runtime={runtime} />);
    expect(screen.getByText("2026-08-10")).toBeInTheDocument();
    expect(screen.getByText(/373 documents · 339 songs · 34 Set Lists/)).toBeInTheDocument();
    expect(screen.getByText(/373\/373 indexed routes/)).toBeInTheDocument();
    expect(screen.getByText("1076 resolved / 0 unresolved")).toBeInTheDocument();
    expect(screen.getByText(/339 total · 334 fit · 5 needs-editing · 0 scrollable/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /5 linked warning songs/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "can-t-stop" })).toBeInTheDocument();
    await user.click(screen.getByText(/Deleted Set paths excluded/));
    expect(screen.getByText("sets/2018-02-24-20180224-bv.md")).toBeInTheDocument();
    expect(screen.getByText("sets/2023-12-03-lc-acou-bv-party.md")).toBeInTheDocument();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it("locks non-status routes while retained pointer recovery is pending", async () => {
    const user = userEvent.setup();
    const pending = runtimeWith({ activeGeneration: null, retainedGeneration: runtime.activeGeneration, update: "failed-retained", warning: "retained recovery is pending" });
    window.location.hash = "#/songs";
    render(<ReadyApp snapshot={snapshot} online update={update} runtime={pending} />);
    expect(screen.getByRole("heading", { name: /active pointer recovers/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Songs" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Status" })).toBeInTheDocument();
    expect((await axe.run(document.body)).violations).toEqual([]);
    await user.click(screen.getByRole("link", { name: "Status" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Snapshot status" })).toBeInTheDocument());
    expect(screen.getByText(/active pointer recovery pending/i)).toBeInTheDocument();
  });

  it("keeps verified network and memory snapshots outside active catalog selectors", async () => {
    const user = userEvent.setup();
    const network = runtimeWith({ source: "network", update: "memory-only", activeGeneration: null, offlineReady: false });
    window.location.hash = "#/songs";
    render(<ReadyApp snapshot={snapshot} online update={update} runtime={network} />);
    expect(screen.getByText(/catalog selectors are unavailable until this generation/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /waits for an active saved snapshot/i })).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Songs" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: /View runtime status/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Snapshot status" })).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: /Library index diagnostics unavailable/i })).toBeInTheDocument();
    expect(screen.getByText(/not the active IndexedDB pointer generation/i)).toBeInTheDocument();
  });

  it("does not apply current deleted-path diagnostics to an active reviewed predecessor", () => {
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
    const predecessorRuntime = runtimeWith({ activeGeneration: predecessor.manifest.generation });
    window.location.hash = "#/status";
    render(<ReadyApp snapshot={predecessor} online update={update} runtime={predecessorRuntime} />);
    expect(screen.getByText(/Deleted-path exclusions are unavailable for this reviewed predecessor contract/i)).toBeInTheDocument();
    expect(screen.queryByText(/26 exact deleted Set paths/i)).not.toBeInTheDocument();
  });

  it("keeps an active snapshot searchable when an update fails and reports retention", async () => {
    const user = userEvent.setup();
    const retained = runtimeWith({ update: "failed-retained", warning: "preferred update unavailable" });
    window.location.hash = "#/songs";
    render(<ReadyApp snapshot={snapshot} online update={update} runtime={retained} />);
    expect(screen.getByText(/active verified snapshot was retained/i)).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: /Search songs in this local verified snapshot/i });
    await user.type(search, "cant stop");
    expect(screen.getByRole("link", { name: /Can't Stop/i })).toBeInTheDocument();
    window.location.hash = "#/status";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitFor(() => expect(screen.getByText(/update failed; active generation retained/i)).toBeInTheDocument());
    expect(screen.getByText("failed-retained")).toBeInTheDocument();
  });

  it("labels durable offline restart and defers shell updates while disconnected", () => {
    window.location.hash = "#/status";
    const waiting: ServiceWorkerState = { state: "update-available", canApply: false, apply: vi.fn(async () => undefined) };
    render(<ReadyApp snapshot={snapshot} online={false} update={waiting} runtime={runtime} />);
    expect(screen.getByRole("status")).toHaveTextContent(/browse and search are local/i);
    expect(screen.getByText(/Available from the active verified snapshot/i)).toBeInTheDocument();
    expect(screen.getByText(/songs-v2 · available/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /update waiting/i })).toBeDisabled();
  });
});
