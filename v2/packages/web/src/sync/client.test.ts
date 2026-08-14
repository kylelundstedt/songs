import { afterEach, describe, expect, it, vi } from "vitest";
import { acknowledge, applyOperation, loadWritableCapabilities, pull, resolveConflict, SyncHTTPError, validateLeadSheetOnServer } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("sync HTTP client", () => {
  it("loads the explicit no-store writable capability", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ schema_version: "1", set_list_authoring: true, lead_sheet_authoring: true, foreground_sync: true, apex_validation: true, lyrics_provider: false, shelley_suggestions: false }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(loadWritableCapabilities()).resolves.toMatchObject({ set_list_authoring: true });
    expect(fetcher).toHaveBeenCalledWith("/api/v2/writable-capabilities", expect.objectContaining({ cache: "no-store", credentials: "same-origin" }));
  });

  it("preserves the exact frozen apply envelope and maps nested retryable errors", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "PUBLICATION_RESERVED", message: "reserved" } }), { status: 409, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    const envelope = { protocol_version: "1", device_id: "device-a", operation_id: "operation-a", operation_kind: "set-list-put", document_id: "set-a", base_revision_id: "", title: "Set", payload: { a: 1 }, payload_sha256: "a".repeat(64), client_cursor: 0 } as const;
    await expect(applyOperation(envelope, { deviceId: "device-a", token: "secret" })).rejects.toEqual(expect.objectContaining<Partial<SyncHTTPError>>({ status: 409, code: "PUBLICATION_RESERVED" }));
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe(JSON.stringify(envelope));
  });

  it("posts exact resolve bytes to the conflict-specific endpoint", async () => {
    const outcome = { operation_id: "operation-resolve", status: "resolved", revision_id: "rev-333333333333333333333333", conflict_id: "conf-aaaaaaaaaaaaaaaaaaaaaaaa", sequence: 4 } as const;
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(outcome), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    const envelope = {
      protocol_version: "1", device_id: "device-a", operation_id: "operation-resolve", operation_kind: "resolve-conflict",
      document_id: "set-a", base_revision_id: "rev-111111111111111111111111", title: "Resolved",
      payload: { kind: "set-list" }, payload_sha256: "b".repeat(64), client_cursor: 3,
    } as const;
    await expect(resolveConflict("conf-aaaaaaaaaaaaaaaaaaaaaaaa", envelope, { deviceId: "device-a", token: "secret" })).resolves.toEqual(outcome);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v2/sync/conflicts/conf-aaaaaaaaaaaaaaaaaaaaaaaa/resolve");
    expect(fetcher.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: "POST", cache: "no-store", credentials: "same-origin", body: JSON.stringify(envelope),
      headers: expect.objectContaining({ "X-Songs-V2-Device-ID": "device-a", "X-Songs-V2-Device-Token": "secret" }),
    }));
  });

  it("uses the server pull and acknowledgement wire contracts exactly", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: [], revisions: [], conflicts: [], cursor: 7, compaction_floor: 0 }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ protocol_version: "1", cursor: 7, status: "acknowledged" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    const credential = { deviceId: "device-a", token: "secret" };
    await expect(pull(4, credential)).resolves.toMatchObject({ cursor: 7 });
    await expect(acknowledge(7, credential)).resolves.toBeUndefined();
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v2/sync/pull?after=4");
    expect((fetcher.mock.calls[1]?.[1] as RequestInit).body).toBe(JSON.stringify({ cursor: 7 }));
  });

  it("returns structured server/Apex validation failures for durable receipt storage", async () => {
    const failure = { schema_version: "1", authority: "server-apex", document_id: "song-a", path: "songs/A.md", title: "A", source_sha256: "a".repeat(64), valid: false, issues: [{ code: "ARTIST_REQUIRED", message: "artist is required" }] } as const;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(failure), { status: 422, headers: { "Content-Type": "application/json" } })));
    await expect(validateLeadSheetOnServer({ documentId: "song-a", path: "songs/A.md", title: "A", source: "source" })).resolves.toEqual(failure);
  });
});
