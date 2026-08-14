import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openSongsStorage, SONGS_STORAGE_NAME } from "../storage";
import { AUTHORED_CONFLICT_SCHEMA_VERSION, AUTHORED_REVISION_SCHEMA_VERSION, AUTHORED_SYNC_SCHEMA_VERSION, AUTHORED_SYNC_STATE_ID, canonicalJson, isAuthoredResolutionOutboxRecord } from "../storage/authored";
import { buildSetListPublicationPayload, sha256Hex } from "../setlists/codec";
import { validateSetList } from "../setlists/model";
import { ConflictReviewPage } from "./ConflictReviewPage";

async function deleteDatabase(): Promise<void> { await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(SONGS_STORAGE_NAME); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); }); }
afterEach(async () => { localStorage.clear(); await deleteDatabase(); });

async function seedConflict(): Promise<void> {
  const storage = await openSongsStorage();
  const makePayload = (title: string) => buildSetListPublicationPayload(validateSetList({ id: "set-conflict-review", path: "sets/Conflict-Review.md", title, sections: [{ id: "section-one", heading: "Set 1", entries: [] }] }));
  const currentPayload = makePayload("Server title");
  const candidatePayload = makePayload("Local title");
  const current = { id: "rev-111111111111111111111111", schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION, origin: "server" as const, documentId: "set-conflict-review", deviceId: "browser-server", operationId: "operation-server", baseRevisionId: "", title: "Server title", payload: currentPayload, contentHash: await sha256Hex(canonicalJson(currentPayload)), receivedAt: "1970-01-01T00:00:00.000Z" };
  const candidate = { id: "rev-222222222222222222222222", schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION, origin: "server" as const, documentId: "set-conflict-review", deviceId: "browser-local", operationId: "operation-local", baseRevisionId: "", title: "Local title", payload: candidatePayload, contentHash: await sha256Hex(canonicalJson(candidatePayload)), receivedAt: "1970-01-01T00:00:00.000Z" };
  const conflict = { id: "conf-333333333333333333333333", schemaVersion: AUTHORED_CONFLICT_SCHEMA_VERSION, documentId: "set-conflict-review", currentRevisionId: current.id, candidateRevisionId: candidate.id, resolutionRevisionId: "", status: "open" as const, updatedAt: "2026-08-14T15:00:00.000Z" };
  const sync = { id: AUTHORED_SYNC_STATE_ID, schemaVersion: AUTHORED_SYNC_SCHEMA_VERSION, deviceId: "browser-review", cursor: 9, acknowledgedCursor: 9, documents: [{ documentId: "set-conflict-review", currentServerRevisionId: current.id, publishedRevisionId: "" }], updatedAt: "2026-08-14T15:00:00.000Z" };
  await storage.commitAuthoredSync({ expectedCursor: 0, sync, revisions: [current, candidate], conflicts: [conflict] });
  storage.close();
}

describe("ConflictReviewPage", () => {
  it("shows both retained candidates and durably queues an explicit keep-local resolution", async () => {
    await seedConflict();
    const user = userEvent.setup();
    render(<ConflictReviewPage setListWritable leadSheetWritable={false} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Server title" })).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Current server candidate" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Local conflict candidate" })).toBeInTheDocument();
    expect(screen.getAllByText(/Server title/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Local title/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Keep local" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/saved durably and queued/i));
    const storage = await openSongsStorage();
    const queue = await storage.listAuthoredResolutionOutbox();
    expect(queue).toHaveLength(1);
    expect(isAuthoredResolutionOutboxRecord(queue[0]!)).toBe(true);
    expect(queue[0]).toMatchObject({ conflictId: "conf-333333333333333333333333", mode: "keep-local", state: "pending", currentRevisionId: "rev-111111111111111111111111", candidateRevisionId: "rev-222222222222222222222222" });
    expect(queue[0]!.envelope.payload.source).toContain("Local title");
    expect((await storage.readAuthoredState()).conflicts[0]).toMatchObject({ status: "open", resolutionRevisionId: "" });
    storage.close();
  });
});
