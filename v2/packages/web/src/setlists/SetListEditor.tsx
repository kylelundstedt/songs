import { useEffect, useMemo, useState } from "react";
import type { LeadSheetDocument } from "../bootstrap/types";
import { validateLeadSheetLocally } from "../leadsheets";
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
        const [loaded, authoredLeadSheets, authoredSync, leadOutbox, authoredState] = await Promise.all([
          initialize === undefined ? loadEditableSetList(storage, stableBaseline) : initializeEditableSetList(storage, stableBaseline, initialize),
          storage.listLeadSheetDrafts(), storage.readAuthoredSyncState(), storage.listLeadSheetOutbox(), storage.readAuthoredState(),
        ]);
        const authoredOptions = await Promise.all(authoredLeadSheets.map(async (draft) => {
          const validation = validateLeadSheetLocally(draft.document);
          if (!validation.valid || validation.title === undefined) return null;
          const receipt = await storage.readLeadSheetValidationReceipt(draft.documentId, draft.sourceSha256);
          const sync = authoredSync?.documents.find((item) => item.documentId === draft.documentId);
          const queued = leadOutbox.some((item) => item.documentId === draft.documentId);
          const conflicted = authoredState.conflicts.some((item) => item.documentId === draft.documentId && item.status === "open");
          const published = !conflicted && !queued && draft.baseServerRevisionId !== "" && sync?.publishedRevisionId === draft.baseServerRevisionId;
          const status = conflicted ? "conflict" : published ? "published" : receipt?.response.valid === true ? "server-validated" : draft.baseServerRevisionId === "" ? "local-stage-ready" : "sync-accepted";
          return { id: draft.documentId, path: draft.document.path, title: validation.title, status };
        }));
        if (active) {
          setState(loaded);
          setLocalSongs(authoredOptions.filter((item): item is NonNullable<typeof item> => item !== null));
          setMessage(loaded.queued > 0 ? `${loaded.queued} local operation${loaded.queued === 1 ? "" : "s"} waiting for foreground sync.` : "No local changes queued.");
        }
      }
      catch (error) { if (active) setMessage(error instanceof Error ? error.message : "Unable to open durable draft"); }
      finally { storage.close(); }
    });
    return () => { active = false; };
  }, [stableBaseline, initialize]);

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
    <header className="detail-header"><div><p className="eyebrow">Offline writable Set List</p><h1 data-page-heading tabIndex={-1}>{setList.title}</h1><p className="artist">Every change commits locally before entering the outbox.</p></div><div className="set-detail-actions">{liveHref !== undefined && <a className="primary-button" href={liveHref}>Open published Live</a>}<button type="button" onClick={() => void undo()} disabled={busy || state.revision?.inverse === null}>Undo</button><button type="button" className="primary-button" onClick={onClose}>Done</button></div></header>
    <p role="status" aria-live="polite" className="session-banner">{message}</p>
    <ul className="editor-state-list" aria-label="Set List save state"><li>Local: saved durably</li><li>Server: {state.conflicts > 0 ? "conflict requires resolution" : state.queued > 0 ? "local changes waiting" : state.baseServerRevisionId === "" ? "not synchronized" : "accepted"}</li><li>Published: {state.publishedRevisionId === "" ? "not published" : state.queued === 0 && state.publishedRevisionId === state.baseServerRevisionId ? "current server revision" : "older protected Live revision"}</li></ul>
    <fieldset className="editor-fields" disabled={busy}><legend>Set List details</legend>
      <label>Title<input value={setList.title} onChange={(event) => void mutate({ kind: "update-details", title: event.target.value })} /></label>
      <label>Date<input value={setList.date} placeholder="YYYY-MM-DD" onChange={(event) => void mutate({ kind: "update-details", date: event.target.value })} /></label>
      <label>Location<input value={setList.location} onChange={(event) => void mutate({ kind: "update-details", location: event.target.value })} /></label>
      <label>Band<input value={setList.band} onChange={(event) => void mutate({ kind: "update-details", band: event.target.value })} /></label>
    </fieldset>
    <section className="panel editor-add"><h2>Add lead sheet</h2><p>Local-stage-ready and sync-accepted songs are labeled explicitly; locked Live still requires a published revision.</p><select aria-label="Lead sheet" defaultValue="" onChange={(event) => {
      const song = songOptions.find((candidate) => candidate.id === event.target.value); if (song === undefined) return;
      void mutate({ kind: "add-entry", sectionId: firstSection.id, entry: { id: randomStableId("entry"), leadSheetId: song.id, targetPath: song.path, label: song.title } }); event.target.value = "";
    }}><option value="">Choose a song…</option>{songOptions.map((song) => <option key={song.id} value={song.id}>{song.title} · {song.status}</option>)}</select></section>
    <div className="set-sections">{setList.sections.map((section) => <section key={section.id} className="set-section"><h2>{section.heading}</h2><ol>{section.entries.map((entry, index) => <li key={entry.id} data-entry-id={entry.id}><span className="ordinal">{index + 1}</span><div className="editor-entry"><strong>{entry.label}</strong><label>Performance note<input value={entry.note} onChange={(event) => void mutate({ kind: "update-entry-note", entryId: entry.id, note: event.target.value })} /></label><div className="editor-entry-actions"><button type="button" disabled={busy || index === 0} onClick={() => void mutate({ kind: "move-entry", entryId: entry.id, toSectionId: section.id, beforeEntryId: section.entries[index - 1]!.id })}>Move up</button><button type="button" disabled={busy || index === section.entries.length - 1} onClick={() => void mutate({ kind: "move-entry", entryId: entry.id, toSectionId: section.id, ...(section.entries[index + 2] === undefined ? {} : { beforeEntryId: section.entries[index + 2]!.id }) })}>Move down</button><button type="button" disabled={busy} onClick={() => void mutate({ kind: "remove-entry", entryId: entry.id })}>Remove</button></div></div></li>)}</ol></section>)}</div>
  </article>;
}
