import "fake-indexeddb/auto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createLeadSheet, executeLeadSheetCommand, scanLeadSheetFrontMatter, updateLeadSheetMetadataSource, validateLeadSheetLocally } from "../src/leadsheets/index";
import { buildAuthoredMutation, buildLeadSheetValidationReceipt, buildLeadSheetWorkspaceRecord, openSongsStorage, SONGS_STORAGE_NAME } from "../src/storage/index";

const at = ["2026-08-14T13:30:00.000Z", "2026-08-14T13:31:00.000Z", "2026-08-14T13:32:00.000Z"] as const;
const chunks = resolve(process.cwd(), "../internal/v2bootstrap/data/chunks");
let corpusCount = 0;
let corpusBytes = 0;
for (const name of readdirSync(chunks).filter((item) => item.endsWith(".json")).sort()) {
  const chunk = JSON.parse(readFileSync(resolve(chunks, name), "utf8")) as { documents: Array<{ id: string; path: string; kind: string; source: { content_base64: string } }> };
  for (const record of chunk.documents.filter((item) => item.kind === "lead-sheet")) {
    const source = Buffer.from(record.source.content_base64, "base64").toString("utf8");
    const document = createLeadSheet({ id: record.id, path: record.path, source });
    if (document.source !== source || scanLeadSheetFrontMatter(source).source !== source) throw new Error(`source drift: ${record.path}`);
    corpusCount++; corpusBytes += Buffer.byteLength(source);
  }
}

const legacy = ["---", "# keep", "artist :   'Original Artist' # comment", "custom:", "  nested: [one, two]", "performance_key: \"Am\"", "---", "", "# Exact Song", "", "### Verse 1", "Line one  ", "Line two", ""].join("\n");
const changed = updateLeadSheetMetadataSource(legacy, { artist: "Artist's Band", performanceKey: "Dm" });
const beforeBody = scanLeadSheetFrontMatter(legacy).body;
const afterBody = scanLeadSheetFrontMatter(changed).body;
const document = createLeadSheet({ id: "song-task-twenty", path: "songs/Task-Twenty.md", source: changed });
const revision = executeLeadSheetCommand(null, { kind: "create-lead-sheet", document }, { revisionId: "revision-task-twenty", operationId: "operation-task-twenty" });
const mutation = await buildAuthoredMutation(revision, { deviceId: "browser-task-twenty", baseServerRevisionId: "", clientCursor: 0, createdAt: at[0] });

const storage = await openSongsStorage();
await storage.commitAuthoredMutation(mutation);
const invalidSource = "---\ntitle: \"Interrupted\"\n";
const workspace = await buildLeadSheetWorkspaceRecord({ id: document.id, path: document.path, source: invalidSource }, { updatedAt: at[1] });
await storage.saveLeadSheetWorkspace(workspace, { expectedSourceSha256: null });
const receipt = await buildLeadSheetValidationReceipt({ schema_version: "1", authority: "server-apex", document_id: document.id, path: document.path, title: "Interrupted", source_sha256: workspace.sourceSha256, valid: false, issues: [{ code: "FRONT_MATTER_INVALID", message: "front matter is unfinished" }] }, { source: invalidSource, receivedAt: at[2] });
await storage.saveLeadSheetValidationReceipt(receipt, { expectedWorkspaceSourceSha256: workspace.sourceSha256 });
const archive = await storage.exportAuthoredState(at[2]);
storage.close();
await new Promise<void>((resolveDelete, reject) => { const request = indexedDB.deleteDatabase(SONGS_STORAGE_NAME); request.onsuccess = () => resolveDelete(); request.onerror = () => reject(request.error); });
const restored = await openSongsStorage();
const restore = await restored.restoreAuthoredState(archive, { mode: "replace" });
const restoredWorkspace = await restored.readLeadSheetWorkspace(document.id);
const restoredReceipt = await restored.readLeadSheetValidationReceipt(document.id, workspace.sourceSha256);
const restoredOutbox = await restored.listLeadSheetOutbox();
restored.close();

const output = {
  schema_version: "1", kind: "songs-v2.task-020.evidence",
  assertions: {
    reviewed_lead_sheets_opened_without_drift: corpusCount,
    reviewed_exact_source_bytes: corpusBytes,
    unknown_front_matter_preserved: changed.includes("custom:\n  nested: [one, two]") && changed.includes("# keep"),
    untouched_body_byte_stable: beforeBody === afterBody,
    surgical_quote_style_preserved: changed.includes("artist :   'Artist''s Band' # comment"),
    local_validation_is_non_authoritative: validateLeadSheetLocally(document).authority,
    exact_outbox_payload_source: mutation.outbox.envelope.payload.source === changed,
    invalid_workspace_export_sha256: archive.sha256,
    restore_counts: restore,
    invalid_workspace_restored: restoredWorkspace?.source === invalidSource,
    failed_server_validation_restored: restoredReceipt?.response.valid === false,
    retry_envelope_byte_stable: restoredOutbox.length === 1 && JSON.stringify(restoredOutbox[0]!.envelope) === JSON.stringify(mutation.outbox.envelope),
  },
};
process.stdout.write(JSON.stringify(output, null, 2) + "\n");
