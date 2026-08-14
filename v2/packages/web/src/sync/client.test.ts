import { afterEach, describe, expect, it, vi } from "vitest";
import { applyOperation, loadWritableCapabilities, SyncHTTPError } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("sync HTTP client", () => {
  it("loads the explicit no-store writable capability", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ schema_version: "1", set_list_authoring: true, foreground_sync: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(loadWritableCapabilities()).resolves.toMatchObject({ set_list_authoring: true });
    expect(fetcher).toHaveBeenCalledWith("/api/v2/writable-capabilities", expect.objectContaining({ cache: "no-store", credentials: "same-origin" }));
  });

  it("preserves the exact frozen apply envelope and maps retryable errors", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "PUBLICATION_RESERVED", message: "reserved" }), { status: 409, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    const envelope = { protocol_version: "1", device_id: "device-a", operation_id: "operation-a", operation_kind: "set-list-put", document_id: "set-a", base_revision_id: "", title: "Set", payload: { a: 1 }, payload_sha256: "a".repeat(64), client_cursor: 0 } as const;
    await expect(applyOperation(envelope, { deviceId: "device-a", token: "secret" })).rejects.toEqual(expect.objectContaining<Partial<SyncHTTPError>>({ status: 409, code: "PUBLICATION_RESERVED" }));
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe(JSON.stringify(envelope));
  });
});
