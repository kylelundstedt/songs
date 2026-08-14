import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { createCanonicalLeadSheet } from "../leadsheets";
import { buildLeadSheetPublicationPayload } from "../leadsheets/codec";
import { loadEditableLeadSheet, saveLeadSheetWorkspace } from "../leadsheets/repository";
import { buildSetListPublicationPayload, canonicalJson, sha256Hex } from "../setlists/codec";
import { createSetList } from "../setlists/model";
import { loadEditableSetList } from "../setlists/repository";
import { openSongsStorage, SONGS_STORAGE_NAME } from "../storage";
import { AUTHORED_REVISION_SCHEMA_VERSION, AUTHORED_SYNC_SCHEMA_VERSION, AUTHORED_SYNC_STATE_ID, buildLeadSheetWorkspaceRecord, type AnyAuthoredServerRevisionRecord } from "../storage/authored";

async function erase(): Promise<void> { await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(SONGS_STORAGE_NAME); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); }); }
afterEach(erase);

async function serverRevision(id: string, documentId: string, operationId: string, title: string, payload: AnyAuthoredServerRevisionRecord["payload"], baseRevisionId = ""): Promise<AnyAuthoredServerRevisionRecord> {
  return { id, schemaVersion: AUTHORED_REVISION_SCHEMA_VERSION, origin: "server", documentId, deviceId: "device-server", operationId, baseRevisionId, title, payload, contentHash: await sha256Hex(canonicalJson(payload)), receivedAt: "1970-01-01T00:00:00.000Z" } as AnyAuthoredServerRevisionRecord;
}

describe("editor projection from synchronized server heads", () => {
  it("opens a clean Set List editor from the latest server bytes rather than stale bootstrap bytes", async () => {
    const baseline = createSetList({ id: "set-remote-head", path: "sets/Remote-Head.md", title: "Reviewed R1", sections: [{ id: "section-main", heading: "Set 1", entries: [] }] });
    const remote = createSetList({ ...baseline, title: "Accepted R2" });
    const revision = await serverRevision("rev-111111111111111111111111", baseline.id, "operation-r2", remote.title, buildSetListPublicationPayload(remote));
    const storage = await openSongsStorage();
    await storage.commitAuthoredSync({ expectedCursor: 0, sync: { id: AUTHORED_SYNC_STATE_ID, schemaVersion: AUTHORED_SYNC_SCHEMA_VERSION, deviceId: "device-browser", cursor: 2, acknowledgedCursor: 2, documents: [{ documentId: baseline.id, currentServerRevisionId: revision.id, publishedRevisionId: "" }], updatedAt: "2026-08-14T17:00:00.000Z" }, revisions: [revision] });
    const loaded = await loadEditableSetList(storage, baseline);
    expect(loaded.document.title).toBe("Accepted R2");
    expect(loaded.baseServerRevisionId).toBe(revision.id);
    storage.close();
  });

  it("opens a clean lead sheet from the latest server source but binds an older local workspace to its exact baseline", async () => {
    const baseline = createCanonicalLeadSheet({ id: "song-remote-head", path: "songs/Remote-Head.md", title: "Reviewed R1", artist: "Band", body: "### Verse 1\nOld\n" });
    const remote = createCanonicalLeadSheet({ id: baseline.id, path: baseline.path, title: "Accepted R2", artist: "Band", body: "### Verse 1\nRemote\n" });
    const first = await serverRevision("rev-222222222222222222222222", baseline.id, "operation-r1", "Reviewed R1", buildLeadSheetPublicationPayload(baseline));
    const second = await serverRevision("rev-333333333333333333333333", baseline.id, "operation-r2", "Accepted R2", buildLeadSheetPublicationPayload(remote), first.id);
    const storage = await openSongsStorage();
    await storage.commitAuthoredSync({ expectedCursor: 0, sync: { id: AUTHORED_SYNC_STATE_ID, schemaVersion: AUTHORED_SYNC_SCHEMA_VERSION, deviceId: "device-browser", cursor: 2, acknowledgedCursor: 2, documents: [{ documentId: baseline.id, currentServerRevisionId: second.id, publishedRevisionId: "" }], updatedAt: "2026-08-14T17:00:00.000Z" }, revisions: [first, second] });
    const clean = await loadEditableLeadSheet(storage, baseline);
    expect(clean.source).toBe(remote.source);
    expect(clean.baseline.source).toBe(remote.source);
    expect(clean.baseServerRevisionId).toBe(second.id);

    const editedR2 = remote.source.replace("Remote", "Edited from accepted R2");
    const saved = await saveLeadSheetWorkspace(storage, clean, editedR2);
    expect(saved.baseServerRevisionId).toBe(second.id);
    expect((await storage.readLeadSheetWorkspace(baseline.id))?.baseServerRevisionId).toBe(second.id);

    const localSource = baseline.source.replace("Old", "Edited locally before seeing R2");
    const workspace = await buildLeadSheetWorkspaceRecord({ id: baseline.id, path: baseline.path, source: localSource }, { updatedAt: "2026-08-14T17:01:00.000Z" });
    await storage.saveLeadSheetWorkspace(workspace, { expectedSourceSha256: saved.workspaceSourceSha256 });
    const recovered = await loadEditableLeadSheet(storage, baseline);
    expect(recovered.source).toBe(localSource);
    expect(recovered.baseServerRevisionId).toBe(first.id);
    storage.close();
  });
});
