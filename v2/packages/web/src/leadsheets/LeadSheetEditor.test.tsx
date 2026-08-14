import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../setlists/codec";
import { openSongsStorage, SONGS_STORAGE_NAME } from "../storage";
import type { WritableCapabilities } from "../sync/client";
import { createCanonicalLeadSheet } from "./codec";
import { LeadSheetEditor } from "./LeadSheetEditor";

const capabilities: WritableCapabilities = {
  schema_version: "1", set_list_authoring: false, lead_sheet_authoring: true, foreground_sync: true,
  apex_validation: true, lyrics_provider: true, shelley_suggestions: true,
};

async function erase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(SONGS_STORAGE_NAME);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("database blocked"));
  });
}

afterEach(async () => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); await erase(); });

describe("LeadSheetEditor", () => {
  it("autosaves an invalid exact-source workspace and reopens it without queueing", async () => {
    const baseline = createCanonicalLeadSheet({ id: "song-editor-one", path: "songs/Editor-One.md", title: "Editor One", artist: "The Band", body: "### Verse 1\nLine" });
    const first = render(<LeadSheetEditor baseline={baseline} capabilities={capabilities} online onClose={() => undefined} />);
    const source = await screen.findByLabelText("Exact lead-sheet Markdown source");
    fireEvent.change(source, { target: { value: "---\ntitle: \"Unfinished\"\n" } });
    await screen.findByText(/validation errors prevent sync/i);
    expect(screen.getByRole("button", { name: "Save revision for sync" })).toBeDisabled();
    const storage = await openSongsStorage();
    try {
      await waitFor(async () => expect((await storage.readLeadSheetWorkspace("song-editor-one"))?.source).toBe("---\ntitle: \"Unfinished\"\n"));
      expect(await storage.listLeadSheetOutbox()).toEqual([]);
    } finally { storage.close(); }
    first.unmount();

    render(<LeadSheetEditor baseline={baseline} capabilities={capabilities} online={false} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByLabelText("Exact lead-sheet Markdown source")).toHaveValue("---\ntitle: \"Unfinished\"\n"));
  });

  it("keeps the workspace unchanged when an online provider action fails", async () => {
    const baseline = createCanonicalLeadSheet({ id: "song-editor-two", path: "songs/Editor-Two.md", title: "Editor Two", artist: "The Band", body: "### Verse 1\nLine" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ schema_version: "1", error: { code: "PROVIDER_UNAVAILABLE", message: "provider unavailable" } }), { status: 502, headers: { "Content-Type": "application/json" } })));
    render(<LeadSheetEditor baseline={baseline} capabilities={capabilities} online onClose={() => undefined} />);
    const source = await screen.findByLabelText("Exact lead-sheet Markdown source");
    const before = (source as HTMLTextAreaElement).value;
    fireEvent.click(screen.getByRole("button", { name: "Search lyrics providers" }));
    await screen.findByText(/provider unavailable.*local work is unchanged/i);
    expect(source).toHaveValue(before);
  });

  it("persists structured 422 server/Apex validation issues for the exact source", async () => {
    const baseline = createCanonicalLeadSheet({ id: "song-editor-three", path: "songs/Editor-Three.md", title: "Editor Three", artist: "The Band", body: "### Verse 1\nLine" });
    const hash = await sha256Hex(baseline.source);
    const failure = { schema_version: "1", authority: "server-apex", document_id: baseline.id, path: baseline.path, title: "Editor Three", source_sha256: hash, valid: false, issues: [{ code: "APEX_VALIDATION_FAILED", message: "Apex could not validate" }] } as const;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(failure), { status: 422, headers: { "Content-Type": "application/json" } })));
    render(<LeadSheetEditor baseline={baseline} capabilities={capabilities} online onClose={() => undefined} />);
    await screen.findByLabelText("Exact lead-sheet Markdown source");
    fireEvent.click(screen.getByRole("button", { name: "Validate with server/Apex" }));
    await screen.findByText(/server\/Apex validation found errors/i);
    const storage = await openSongsStorage();
    try { expect((await storage.readLeadSheetValidationReceipt(baseline.id, hash))?.response).toEqual(failure); }
    finally { storage.close(); }
  });
});
