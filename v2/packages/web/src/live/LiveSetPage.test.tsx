import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { beforeAll, describe, expect, it } from "vitest";
import { loadVerifiedSnapshot } from "../bootstrap/load";
import type { VerifiedSnapshot } from "../bootstrap/types";
import { buildLibraryIndex, type LibraryIndex } from "../library";
import { LiveSetPage } from "./LiveSetPage";
import { buildPerformanceSet, type PerformanceSet } from "./model";

const dataRoot = resolve(process.cwd(), "../../../internal/v2bootstrap/data");
let index: LibraryIndex;
let snapshot: VerifiedSnapshot;
let latest: PerformanceSet;
let duplicateSet: PerformanceSet;
let linkedSet: PerformanceSet;
let linkedEntryIndex = 0;

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
  latest = buildPerformanceSet(index, "2025-10-13-9tease-stripped");
  duplicateSet = buildPerformanceSet(index, "2021-05-15-murphy-s-lc-acoustic");
  linkedSet = buildPerformanceSet(index, "2021-11-19-reel-brand-lc-acoustic");
  linkedEntryIndex = linkedSet.entries.findIndex((entry) => /<a\b/i.test(entry.apexHtml));
}, 20_000);

function renderLive(performanceSet: PerformanceSet = latest) {
  return render(<LiveSetPage performanceSet={performanceSet} exitHref="#/sets/test" />);
}

describe("LiveSetPage", () => {
  it("exposes only the locked Live controls and omits shell chrome", () => {
    const { container } = renderLive();

    expect(within(container).getAllByRole("link").map((link) => link.textContent)).toEqual(["Exit Live"]);
    expect(within(container).getAllByRole("button").map((button) => button.textContent)).toEqual(["Stage Dark", "Previous", "Next"]);
    expect(container.querySelector("header")).toBeNull();
    expect(container.querySelector("footer")).toBeNull();
    expect(screen.getByText(latest.title)).toBeInTheDocument();
  });

  it("keeps Previous/Next bounded and leaves paging keys to focused scrollable columns", async () => {
    renderLive();
    const previous = screen.getByRole("button", { name: "Previous" });
    const next = screen.getByRole("button", { name: "Next" });
    expect(previous).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("1/58");
    const fittedColumn = await waitFor(() => {
      const column = document.querySelector<HTMLElement>(".live-column");
      expect(column).not.toBeNull();
      return column!;
    });
    fittedColumn.focus();
    fireEvent.keyDown(fittedColumn, { key: "PageDown" });
    expect(screen.getByRole("status")).toHaveTextContent("1/58");
    fireEvent.keyDown(fittedColumn, { key: " " });
    expect(screen.getByRole("status")).toHaveTextContent("1/58");
    fittedColumn.blur();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("2/58");
    fireEvent.keyDown(window, { key: "PageUp" });
    expect(screen.getByRole("status")).toHaveTextContent("1/58");
    fireEvent.keyDown(window, { key: "ArrowRight", ctrlKey: true });
    expect(screen.getByRole("status")).toHaveTextContent("1/58");
    fireEvent.keyDown(next, { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("2/58");
    fireEvent.keyDown(next, { key: "PageUp" });
    expect(screen.getByRole("status")).toHaveTextContent("1/58");

    for (let count = 0; count < latest.length + 4; count += 1) fireEvent.click(next);
    expect(screen.getByRole("status")).toHaveTextContent("58/58");
    expect(next).toBeDisabled();
    fireEvent.keyDown(window, { key: " ", shiftKey: true });
    expect(screen.getByRole("status")).toHaveTextContent("58/58");
  });

  it("retains duplicate occurrence identity instead of collapsing the song", () => {
    const duplicateTarget = duplicateSet.entries.find((entry, position, entries) => entries.some((other, otherPosition) => otherPosition > position && other.targetLeadSheetId === entry.targetLeadSheetId));
    expect(duplicateTarget).toBeDefined();
    const duplicateIndex = duplicateSet.entries.findIndex((entry) => entry.entryId === duplicateTarget?.entryId);
    const laterDuplicateIndex = duplicateSet.entries.findIndex((entry, position) => position > duplicateIndex && entry.targetLeadSheetId === duplicateTarget?.targetLeadSheetId);
    const { container } = renderLive(duplicateSet);

    const firstOccurrenceId = container.querySelector<HTMLElement>("[data-occurrence-id]")?.dataset.occurrenceId;
    for (let position = 0; position < laterDuplicateIndex; position += 1) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const laterOccurrenceId = container.querySelector<HTMLElement>("[data-occurrence-id]")?.dataset.occurrenceId;

    expect(firstOccurrenceId).not.toBe(laterOccurrenceId);
    expect(screen.getByRole("status")).toHaveTextContent(`${laterDuplicateIndex + 1}/${duplicateSet.length}`);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(duplicateSet.entries[laterDuplicateIndex]!.label);
  });

  it("shows the authored occurrence label when it carries performance instructions", () => {
    const instructionIndex = latest.entries.findIndex((entry) => entry.label !== entry.song.title);
    expect(instructionIndex).toBeGreaterThanOrEqual(0);
    renderLive();
    for (let position = 0; position < instructionIndex; position += 1) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const instruction = latest.entries[instructionIndex]!;
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(instruction.label);
    expect(screen.getByRole("status")).toHaveTextContent(instruction.label);
  });

  it("keeps Stage Dark in memory and resets to Bright on a new Live mount", () => {
    const first = renderLive();
    const stage = first.container.querySelector<HTMLElement>("[data-live-locked]");
    expect(stage).toHaveAttribute("data-stage-theme", "bright");
    fireEvent.click(screen.getByRole("button", { name: "Stage Dark" }));
    expect(stage).toHaveAttribute("data-stage-theme", "dark");
    expect(screen.getByRole("button", { name: "Bright" })).toBeInTheDocument();
    first.unmount();

    renderLive();
    expect(screen.getByLabelText("Locked Live mode")).toHaveAttribute("data-stage-theme", "bright");
  });

  it("shows the frozen landscape warning for the frozen warning occurrence", () => {
    const warningIndex = latest.entries.findIndex((entry) => entry.landscapeWarning);
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    renderLive();
    for (let position = 0; position < warningIndex; position += 1) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("note")).toHaveTextContent(/Frozen warning/i);
    expect(screen.getByRole("note")).toHaveTextContent(/landscape/i);
    expect(screen.getByRole("note")).toHaveTextContent(/16px/i);
  });

  it("uses verified Apex as hidden authority and leaves no active presentation links", async () => {
    const { container } = renderLive(linkedSet);
    for (let position = 0; position < linkedEntryIndex; position += 1) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const source = container.querySelector<HTMLTemplateElement>("template[data-apex-source]");
    expect(source?.tagName).toBe("TEMPLATE");
    expect(source).toHaveAttribute("data-authority", "apex");
    expect(source?.innerHTML.replaceAll("<br />", "<br>")).toBe(linkedSet.entries[linkedEntryIndex]!.apexHtml.replaceAll("<br />", "<br>"));

    await waitFor(() => {
      const links = [...container.querySelectorAll<HTMLAnchorElement>("[data-live-columns] a")];
      expect(links.length).toBeGreaterThan(0);
      expect(links.every((link) => !link.hasAttribute("href"))).toBe(true);
      expect(links.every((link) => !link.hasAttribute("aria-hidden"))).toBe(true);
      expect(links.every((link) => link.tabIndex === -1)).toBe(true);
      expect(links.every((link) => (link.textContent ?? "").trim().length > 0)).toBe(true);
      expect(container.querySelectorAll("[data-live-columns] [style]")).toHaveLength(0);
      expect([...container.querySelectorAll<HTMLElement>("[data-live-columns] .live-column")].every((column) => column.tabIndex === 0)).toBe(true);
    });
    expect(within(container).getAllByRole("link").map((link) => link.textContent)).toEqual(["Exit Live"]);
  });

  it("has no automated accessibility violations", async () => {
    const { container } = renderLive();
    const result = await axe.run(container);
    expect(result.violations).toEqual([]);
  });
});
