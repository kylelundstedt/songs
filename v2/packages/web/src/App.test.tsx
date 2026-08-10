import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import axe from "axe-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReadyApp, type ServiceWorkerState } from "./App";
import { loadVerifiedSnapshot } from "./bootstrap/load";
import type { VerifiedSnapshot } from "./bootstrap/types";

const dataRoot = resolve(process.cwd(), "../../../internal/v2bootstrap/data");
const update: ServiceWorkerState = { state: "current", apply: vi.fn(async () => undefined) };
let snapshot: VerifiedSnapshot;

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
    const { container } = render(<ReadyApp snapshot={snapshot} online update={update} />);
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
    render(<ReadyApp snapshot={snapshot} online update={update} />);
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

  it("keeps reviewed internal Apex links inside the isolated V2 router", async () => {
    const user = userEvent.setup();
    const linkedSong = snapshot.leadSheets.find((song) => song.apex.html.includes('href="/song/'))!;
    window.location.hash = `#/songs/${linkedSong.slug}`;
    render(<ReadyApp snapshot={snapshot} online update={update} />);
    const apex = document.querySelector<HTMLElement>('[data-authority="apex"]')!;
    const link = within(apex).getAllByRole("link")[0]!;
    const original = link.getAttribute("href")!;
    await user.click(link);
    await waitFor(() => expect(window.location.hash).toBe(`#${original.replace("/song/", "/songs/")}`));
    expect(window.location.pathname).toBe("/");
  });

  it("routes malformed percent encodings to the explicit V2 not-found page", () => {
    window.location.hash = "#/songs/%";
    render(<ReadyApp snapshot={snapshot} online update={update} />);
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByText(/does not fall through to v1/i)).toBeInTheDocument();
  });

  it("labels the in-memory offline limitation explicitly and defers shell updates", () => {
    window.location.hash = "#/status";
    const waiting: ServiceWorkerState = { state: "update-available", apply: vi.fn(async () => undefined) };
    render(<ReadyApp snapshot={snapshot} online={false} update={waiting} />);
    expect(screen.getByRole("status")).toHaveTextContent(/verified in-memory snapshot/i);
    expect(screen.getByText(/not opened until P1-005/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /update waiting/i })).toBeDisabled();
  });
});
