import { useEffect, useMemo, useState } from "react";
import { authoredReadiness } from "../authored/status";
import type { LeadSheetDocument } from "../bootstrap/types";
import { createLeadSheet, validateLeadSheetLocally } from "../leadsheets";
import { openSongsStorage } from "../storage";
import { commitSetListCommand, initializeEditableSetList, loadEditableSetList, undoEditableSetList, type EditableSetListState } from "./repository";
import { randomStableId, type SetList } from "./model";

export function SetListEditor({ baseline, songs, onClose, initialize, liveHref }: { readonly baseline: SetList; readonly songs: readonly LeadSheetDocument[]; readonly onClose: () => void; readonly initialize?: "create" | { readonly sourceDocumentId: string }; readonly liveHref?: string }) {
  const stableBaseline = useMemo(() => baseline, [baseline]);
  const [state, setState] = useState<EditableSetListState>();
  const [localSongs, setLocalSongs] = useState<readonly { readonly id: string; readonly path: string; readonly title: string; readonly status: string }[]>([]);
  const [message, setMessage] = useState("Loading durable draft…");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    localStorage.setItem("songs-v2-authored-recovery-present", "1");
    let active = true;
    void openSongsStorage().then(async (storage) => {
      try {
        const [loaded, authoredLeadSheets, authoredSync, authoredState, authoredRevisions] = await Promise.all([
          initialize === undefined ? loadEditableSetList(storage, stableBaseline) : initializeEditableSetList(storage, stableBaseline, initialize),
          storage.listLeadSheetDrafts(), storage.readAuthoredSyncState(), storage.readAuthoredState(), storage.listAuthoredRevisions(),
        ]);
        const authoredOptions = await Promise.all(authoredLeadSheets.map(async (draft) => {
          const validation = validateLeadSheetLocally(draft.document);
          if (!validation.valid || validation.title === undefined) return null;
          const receipt = await storage.readLeadSheetValidationReceipt(draft.documentId, draft.sourceSha256);
          const sync = authoredSync?.documents.find((item) => item.documentId === draft.documentId);
          const readiness = authoredReadiness({
            documentId: draft.documentId, kind: "lead-sheet", baseServerRevisionId: draft.baseServerRevisionId,
            localRevisionId: draft.localRevisionId, sourceSha256: draft.sourceSha256, sync,
            acknowledgedCursor: authoredSync?.acknowledgedCursor ?? 0, cursor: authoredSync?.cursor ?? 0,
            outbox: authoredState.outbox, conflicts: authoredState.conflicts, validationReceipt: receipt,
          });
          return { id: draft.documentId, path: draft.document.path, title: validation.title, status: readiness.label };
        }));
        const reviewedSongIDs = new Set(songs.map((song) => song.id));
        const serverOptions = (authoredSync?.documents ?? []).flatMap((sync) => {
          if (reviewedSongIDs.has(sync.documentId)) return [];
          const revision = authoredRevisions.find((item) => item.origin === "server" && item.id === sync.currentServerRevisionId && item.payload.kind === "lead-sheet");
          if (revision === undefined || revision.origin !== "server" || revision.payload.kind !== "lead-sheet") return [];
          const document = createLeadSheet({ id: sync.documentId, path: revision.payload.path, source: revision.payload.source });
          const validation = validateLeadSheetLocally(document);
          if (!validation.valid || validation.title === undefined) return [];
          return [{ id: sync.documentId, path: document.path, title: validation.title, status: sync.publishedRevisionId === sync.currentServerRevisionId ? "published" : "sync accepted" }];
        });
        if (active) {
          const byID = new Map(serverOptions.map((song) => [song.id, song]));
          for (const song of authoredOptions) if (song !== null) byID.set(song.id, song);
          setState(loaded);
          setLocalSongs([...byID.values()].sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id)));
          setMessage(loaded.queued > 0 ? `${loaded.queued} local operation${loaded.queued === 1 ? "" : "s"} waiting for foreground sync.` : "No local changes queued.");
        }
      }
      catch (error) { if (active) setMessage(error instanceof Error ? error.message : "Unable to open durable draft"); }
      finally { storage.close(); }
    });
    return () => { active = false; };
  }, [stableBaseline, initialize, songs]);

  const mutate = async (command: Parameters<typeof commitSetListCommand>[2]) => {
    if (state === undefined || busy) return;
    setBusy(true);
    const storage = await openSongsStorage();
    try {
      const updated = await commitSetListCommand(storage, state, command);
      setState(updated); setMessage("Saved locally and queued for foreground sync.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Local save failed"); }
    finally { storage.close(); setBusy(false); }
  };
  const undo = async () => {
    if (state === undefined || busy) return;
    setBusy(true);
    const storage = await openSongsStorage();
    try { const updated = await undoEditableSetList(storage, state); setState(updated); setMessage("Undo saved as a new durable local revision."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Undo unavailable"); }
    finally { storage.close(); setBusy(false); }
  };
  if (state === undefined) return <section className="state-card" role="status"><h1>Opening Set List editor</h1><p>{message}</p></section>;
  const setList = state.document;
  const firstSection = setList.sections[0]!;
  const localByID = new Map(localSongs.map((song) => [song.id, song]));
  const songOptions = [
    ...songs.map((song) => ({ id: song.id, path: song.path, title: song.projection.title, status: localByID.has(song.id) ? localByID.get(song.id)!.status : "published/reviewed" })),
    ...localSongs.filter((song) => !songs.some((reviewed) => reviewed.id === song.id)),
  ];
  return <article className="detail-page set-editor" aria-busy={busy}>
    <nav className="breadcrumbs" aria-label="Breadcrumb"><button type="button" className="link-button" onClick={onClose}>Set List</button><span aria-hidden="true">/</span><span>Edit</span></nav>
    <header className="detail-header"><div><h1 data-page-heading tabIndex={-1}>{setList.title}</h1><p className="artist">{setList.date}{setList.location ? ` · ${setList.location}` : ""}</p></div><div className="set-detail-actions">{liveHref !== undefined && <a className="compact-primary-button" href={liveHref}>Live</a>}<button type="button" onClick={() => void undo()} disabled={busy || state.revision?.inverse === null}>Undo</button><button type="button" className="sync-button" onClick={onClose}>Done</button></div></header>
    <p role="status" aria-live="polite" className="editor-message">{message}</p>
    <ul className="editor-state-list" aria-label="Set List save state"><li>Local saved</li><li>{state.queued} queued</li><li>{state.conflicts} conflicts</li><li>{state.publishedRevisionId === state.baseServerRevisionId && state.queued === 0 ? "Published" : "Live uses last published version"}</li></ul>
    <fieldset className="editor-fields" disabled={busy}><legend>Set List details</legend>
      <label>Title<input value={setList.title} onChange={(event) => void mutate({ kind: "update-details", title: event.target.value })} /></label>
      <label>Date<input value={setList.date} placeholder="YYYY-MM-DD" onChange={(event) => void mutate({ kind: "update-details", date: event.target.value })} /></label>
      <label>Location<input value={setList.location} onChange={(event) => void mutate({ kind: "update-details", location: event.target.value })} /></label>
      <label>Band<input value={setList.band} onChange={(event) => void mutate({ kind: "update-details", band: event.target.value })} /></label>
    </fieldset>
    <section className="panel editor-add"><label><strong>Add song</strong><select aria-label="Lead sheet" defaultValue="" onChange={(event) => {
      const song = songOptions.find((candidate) => candidate.id === event.target.value); if (song === undefined) return;
      void mutate({ kind: "add-entry", sectionId: firstSection.id, entry: { id: randomStableId("entry"), leadSheetId: song.id, targetPath: song.path, label: song.title } }); event.target.value = "";
    }}><option value="">Choose a song…</option>{songOptions.map((song) => <option key={song.id} value={song.id}>{song.title} · {song.status}</option>)}</select></label></section>
    <div className={`set-sections editor-sections ${setList.sections.length === 1 ? "single-section" : "multi-section"}`}>{setList.sections.map((section) => <section key={section.id} className="set-section"><h2>{section.heading}</h2><ol>{section.entries.map((entry, index) => <li key={entry.id} data-entry-id={entry.id}><span className="ordinal">{index + 1}</span><div className="editor-entry"><div className="editor-entry-main"><strong>{entry.label}</strong><input aria-label={`Performance note for ${entry.label}`} placeholder="Performance note" value={entry.note} onChange={(event) => void mutate({ kind: "update-entry-note", entryId: entry.id, note: event.target.value })} /></div><div className="editor-entry-actions"><button type="button" aria-label={`Move ${entry.label} up`} title="Move up" disabled={busy || index === 0} onClick={() => void mutate({ kind: "move-entry", entryId: entry.id, toSectionId: section.id, beforeEntryId: section.entries[index - 1]!.id })}>↑</button><button type="button" aria-label={`Move ${entry.label} down`} title="Move down" disabled={busy || index === section.entries.length - 1} onClick={() => void mutate({ kind: "move-entry", entryId: entry.id, toSectionId: section.id, ...(section.entries[index + 2] === undefined ? {} : { beforeEntryId: section.entries[index + 2]!.id }) })}>↓</button><button type="button" aria-label={`Remove ${entry.label}`} title="Remove" disabled={busy} onClick={() => void mutate({ kind: "remove-entry", entryId: entry.id })}>×</button></div></div></li>)}</ol></section>)}</div>
  </article>;
}
