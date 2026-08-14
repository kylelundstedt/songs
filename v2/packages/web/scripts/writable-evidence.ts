import "fake-indexeddb/auto";
import { createSetList, duplicateSetList, executeSetListCommand, undoSetListRevision } from "../src/setlists/index";
import { buildAuthoredMutation, openSongsStorage, SONGS_STORAGE_NAME } from "../src/storage/index";

const at = ["2026-08-14T12:00:00.000Z", "2026-08-14T12:01:00.000Z", "2026-08-14T12:02:00.000Z", "2026-08-14T12:03:00.000Z"] as const;
const original = createSetList({ id: "set-evidence", path: "sets/Evidence.md", title: "Evidence", date: "2026-08-14", location: "Room", band: "Band", sections: [{ id: "section-one", heading: "Set 1", entries: [
  { id: "entry-a-one", leadSheetId: "song-a", targetPath: "songs/Song-A.md", label: "Song A", note: "first" },
  { id: "entry-b", leadSheetId: "song-b", targetPath: "songs/Song-B.md", label: "Song B" },
  { id: "entry-a-two", leadSheetId: "song-a", targetPath: "songs/Song-A.md", label: "Song A", note: "second" },
] }] });
const one = executeSetListCommand(null, { kind: "create-set-list", document: original }, { revisionId: "revision-evidence-one", operationId: "operation-evidence-one" });
const two = executeSetListCommand(one, { kind: "update-entry-note", entryId: original.sections[0]!.entries[2]!.id, note: "changed only duplicate" }, { revisionId: "revision-evidence-two", operationId: "operation-evidence-two" });
const three = executeSetListCommand(two, { kind: "move-entry", entryId: original.sections[0]!.entries[2]!.id, toSectionId: original.sections[0]!.id, beforeEntryId: original.sections[0]!.entries[1]!.id }, { revisionId: "revision-evidence-three", operationId: "operation-evidence-three" });
const four = undoSetListRevision(three, { revisionId: "revision-evidence-four", operationId: "operation-evidence-four" });
const duplicate = duplicateSetList(original, { setListId: "set-evidence-copy", path: "sets/Evidence-Copy.md", sectionIds: ["section-copy"], entryIds: ["entry-copy-one", "entry-copy-two", "entry-copy-three"] });

const storage = await openSongsStorage();
for (const [revision, createdAt] of [[one, at[0]], [two, at[1]], [three, at[2]], [four, at[3]]] as const) {
  await storage.commitAuthoredMutation(await buildAuthoredMutation(revision, { deviceId: "browser-evidence", baseServerRevisionId: "", clientCursor: 0, createdAt }), { expectedLocalRevisionId: revision.parentRevisionId });
}
storage.close();
const reopened = await openSongsStorage();
const before = await reopened.listAuthoredOutbox();
const claimed = await reopened.claimNextAuthoredOutbox({ attemptedAt: at[3]! });
if (claimed === null) throw new Error("outbox claim missing");
const retryBytes = JSON.stringify(claimed.envelope);
await reopened.failAuthoredOutbox(claimed.id, { failedAt: at[3]!, message: "deterministic network loss" });
const failed = await reopened.listAuthoredOutbox();
const archive = await reopened.exportAuthoredState(at[3]!);
const draft = await reopened.readAuthoredDraft(original.id);
const revisions = await reopened.listAuthoredRevisions(original.id);
reopened.close();
await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(SONGS_STORAGE_NAME); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
const restored = await openSongsStorage();
const restore = await restored.restoreAuthoredState(archive);
const restoredDraft = await restored.readAuthoredDraft(original.id);
restored.close();

const output = {
  schema_version: "1",
  kind: "songs-v2.task-019.evidence",
  assertions: {
    duplicate_occurrences_preserved: original.sections[0]!.entries.filter((entry) => entry.leadSheetId === "song-a").map((entry) => entry.id),
    targeted_note_identity: two.document.sections[0]!.entries.map((entry) => [entry.id, entry.note]),
    reordered_entry_ids: three.document.sections[0]!.entries.map((entry) => entry.id),
    undo_is_forward_revision: four.parentRevisionId === three.id && four.document.sections[0]!.entries.map((entry) => entry.id).join(",") === two.document.sections[0]!.entries.map((entry) => entry.id).join(","),
    duplicate_has_fresh_identities: duplicate.id !== original.id && duplicate.sections[0]!.entries.every((entry, index) => entry.id !== original.sections[0]!.entries[index]!.id),
    durable_revision_count: revisions.length,
    coalesced_outbox_count: before.length,
    retry_envelope_byte_stable: failed.length === 1 && JSON.stringify(failed[0]!.envelope) === retryBytes,
    export_sha256: archive.sha256,
    restore_counts: restore,
    restored_head_matches: restoredDraft?.sourceSha256 === draft?.sourceSha256,
  },
};
process.stdout.write(JSON.stringify(output, null, 2) + "\n");
