import { useEffect, useMemo, useRef, useState } from "react";
import type { WritableCapabilities, ProviderChoice, ProviderDraft, ShelleySuggestion } from "../sync/client";
import { importProviderDraft, requestShelleySuggestion, searchLyricsProviders, validateLeadSheetOnServer } from "../sync/client";
import { openSongsStorage } from "../storage";
import { sha256Hex } from "../setlists/codec";
import { readLeadSheetMetadata, scanLeadSheetFrontMatter, updateLeadSheetMetadataSource } from "./codec";
import type { LeadSheet } from "./model";
import { initializeNewLeadSheet, loadEditableLeadSheet, persistServerValidation, promoteLeadSheetWorkspace, saveLeadSheetWorkspace, undoEditableLeadSheet, type EditableLeadSheetState } from "./repository";

export interface LeadSheetEditorProps {
  readonly baseline: LeadSheet;
  readonly initialize?: boolean;
  readonly capabilities: WritableCapabilities;
  readonly online: boolean;
  readonly onClose: () => void;
}

export function LeadSheetEditor({ baseline, initialize = false, capabilities, online, onClose }: LeadSheetEditorProps) {
  const [state, setState] = useState<EditableLeadSheetState>();
  const stateRef = useRef<EditableLeadSheetState | undefined>(undefined);
  const [buffer, setBuffer] = useState(baseline.source);
  const [message, setMessage] = useState("Opening durable lead-sheet workspace…");
  const [busy, setBusy] = useState(false);
  const [providerChoices, setProviderChoices] = useState<readonly ProviderChoice[]>([]);
  const [candidate, setCandidate] = useState<ProviderDraft | ShelleySuggestion>();
  const [prompt, setPrompt] = useState("");
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const latestBuffer = useRef(buffer);
  latestBuffer.current = buffer;
  useEffect(() => { stateRef.current = state; }, [state]);

  useEffect(() => {
    localStorage.setItem("songs-v2-authored-recovery-present", "1");
    let active = true;
    void openSongsStorage().then(async (storage) => {
      try {
        const loaded = initialize ? await initializeNewLeadSheet(storage, baseline) : await loadEditableLeadSheet(storage, baseline);
        if (active) { stateRef.current = loaded; setState(loaded); setBuffer(loaded.source); setMessage("Workspace is saved locally. Local preview is not Apex authority."); }
      } catch (error) { if (active) setMessage(error instanceof Error ? error.message : "Unable to open lead-sheet workspace"); }
      finally { storage.close(); }
    }).catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : "Unable to open lead-sheet workspace"); });
    return () => { active = false; };
  }, [baseline, initialize]);

  const queueWorkspaceSave = (source: string) => {
    setBuffer(source); latestBuffer.current = source; setMessage("Saving workspace locally…");
    saveQueue.current = saveQueue.current.then(async () => {
      const current = stateRef.current;
      if (current === undefined) return;
      const storage = await openSongsStorage();
      try {
        const updated = await saveLeadSheetWorkspace(storage, current, source);
        stateRef.current = updated;
        setState(updated);
        if (latestBuffer.current === source) setMessage(updated.validation.valid ? "Workspace saved locally · local checks pass · not Apex validated." : "Workspace saved locally · validation errors prevent sync.");
      } finally { storage.close(); }
    }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Workspace save failed"));
  };

  const runAfterSaves = async <T,>(action: (storage: Awaited<ReturnType<typeof openSongsStorage>>, state: EditableLeadSheetState) => Promise<T>): Promise<T | undefined> => {
    await saveQueue.current;
    const current = stateRef.current;
    if (current === undefined) return undefined;
    const storage = await openSongsStorage();
    try { return await action(storage, current); } finally { storage.close(); }
  };

  const metadata = useMemo(() => { try { return readLeadSheetMetadata(buffer); } catch { return {}; } }, [buffer]);
  const preview = useMemo(() => { try { return scanLeadSheetFrontMatter(buffer).body; } catch { return buffer; } }, [buffer]);
  const patchMetadata = (patch: Parameters<typeof updateLeadSheetMetadataSource>[1]) => {
    try { queueWorkspaceSave(updateLeadSheetMetadataSource(buffer, patch)); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Metadata update failed"); }
  };
  const promote = async () => {
    setBusy(true);
    try {
      const updated = await runAfterSaves((storage, current) => promoteLeadSheetWorkspace(storage, current));
      if (updated !== undefined) { stateRef.current = updated; setState(updated); setBuffer(updated.source); setMessage("Exact source saved as a durable revision and queued for foreground sync."); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to queue lead-sheet revision"); }
    finally { setBusy(false); }
  };
  const undo = async () => {
    setBusy(true);
    try {
      const updated = await runAfterSaves((storage, current) => undoEditableLeadSheet(storage, current));
      if (updated !== undefined) { stateRef.current = updated; setState(updated); setBuffer(updated.source); setMessage("Undo saved as a new durable revision."); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Undo unavailable"); }
    finally { setBusy(false); }
  };
  const validateServer = async () => {
    if (!online || state === undefined || state.validation.title === undefined) return;
    setBusy(true); setMessage("Running authoritative server/Apex validation…");
    try {
      await saveQueue.current;
      const current = stateRef.current!;
      const result = await validateLeadSheetOnServer({ documentId: current.documentId, path: current.path, title: current.validation.title!, source: current.source });
      const updated = await runAfterSaves((storage, fresh) => persistServerValidation(storage, fresh, result));
      if (updated !== undefined) { stateRef.current = updated; setState(updated); setMessage(result.valid ? "Exact workspace source passed server/Apex validation." : "Server/Apex validation found errors; the local workspace was retained."); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Server validation failed safely"); }
    finally { setBusy(false); }
  };
  const providerSearch = async () => {
    setBusy(true); setMessage("Searching online lyrics providers…");
    try { const result = await searchLyricsProviders(state?.validation.title ?? metadata.title ?? "", metadata.artist ?? ""); setProviderChoices(result.choices); setMessage(result.choices.length === 0 ? "No provider recordings found. Local work is unchanged." : "Choose a recording to create a review-only candidate."); }
    catch (error) { setMessage(`${error instanceof Error ? error.message : "Provider search failed"}. Local work is unchanged.`); }
    finally { setBusy(false); }
  };
  const importChoice = async (choice: ProviderChoice) => {
    setBusy(true);
    try { setCandidate(await importProviderDraft(choice)); setMessage("Provider candidate created. Review and apply it locally; nothing was published."); }
    catch (error) { setMessage(`${error instanceof Error ? error.message : "Provider import failed"}. Local work is unchanged.`); }
    finally { setBusy(false); }
  };
  const askShelley = async () => {
    if (state === undefined) return;
    setBusy(true);
    try { const hash = await sha256Hex(buffer); setCandidate(await requestShelleySuggestion({ baseSourceSha256: hash, title: state.validation.title ?? metadata.title ?? "Lead sheet", source: buffer, prompt })); setMessage("Shelley candidate created. Review and apply it locally; nothing was published."); }
    catch (error) { setMessage(`${error instanceof Error ? error.message : "Shelley suggestion failed"}. Local work is unchanged.`); }
    finally { setBusy(false); }
  };

  if (state === undefined) return <section className="state-card" role="status"><h1>Opening lead-sheet editor</h1><p>{message}</p></section>;
  const serverValidated = state.serverValidation?.valid === true;
  return <article className="detail-page lead-editor" aria-busy={busy}>
    <nav className="breadcrumbs" aria-label="Breadcrumb"><button className="link-button" type="button" onClick={onClose}>Song</button><span aria-hidden="true">/</span><span>Edit</span></nav>
    <header className="detail-header"><div><p className="eyebrow">Offline writable lead sheet</p><h1 tabIndex={-1} data-page-heading>{state.validation.title ?? metadata.title ?? "Lead-sheet draft"}</h1><p className="artist">Exact source workspace; publication remains separate.</p></div><div className="set-detail-actions"><button type="button" disabled={busy || state.revision?.inverse === null} onClick={() => void undo()}>Undo revision</button><button type="button" className="primary-button" disabled={busy || !state.validation.valid} onClick={() => void promote()}>Save revision for sync</button><button type="button" onClick={onClose}>Done</button></div></header>
    <p role="status" aria-live="polite" className="session-banner">{message}</p>
    <ul className="editor-state-list" aria-label="Lead-sheet readiness"><li>Local workspace: saved durably</li><li>Local stage: {state.validation.valid ? "checks pass" : "validation errors"}</li><li>Server sync: {state.conflicts > 0 ? "conflict requires review" : state.queued > 0 ? "revision waiting" : state.baseServerRevisionId === "" ? "not accepted" : "accepted"}</li><li>Server/Apex: {serverValidated ? "validated for this exact source" : state.serverValidation === null ? "not validated for this exact source" : "validation failed for this exact source"}</li><li>Published: {state.conflicts > 0 ? "conflict candidate is not published" : state.publishedRevisionId === "" ? "not published" : state.publishedRevisionId === state.baseServerRevisionId && state.queued === 0 ? "current server revision" : "older revision"}</li></ul>
    <div className="lead-editor-grid">
      <section className="panel"><h2>Metadata</h2><fieldset className="editor-fields" disabled={busy}><label>Title<input key={`title-${state.workspaceSourceSha256}`} defaultValue={state.validation.title ?? metadata.title ?? ""} onBlur={(event) => { if (event.target.value !== (state.validation.title ?? metadata.title ?? "")) patchMetadata({ title: event.target.value }); }} /></label><label>Artist<input key={`artist-${state.workspaceSourceSha256}`} defaultValue={metadata.artist ?? ""} onBlur={(event) => { if (event.target.value !== (metadata.artist ?? "")) patchMetadata({ artist: event.target.value }); }} /></label><label>Performance key<input key={`performance-${state.workspaceSourceSha256}`} defaultValue={metadata.performanceKey ?? ""} onBlur={(event) => { if (event.target.value !== (metadata.performanceKey ?? "")) patchMetadata({ performanceKey: event.target.value || null }); }} /></label><label>BPM<input key={`bpm-${state.workspaceSourceSha256}`} defaultValue={metadata.bpm ?? ""} onBlur={(event) => { if (event.target.value !== (metadata.bpm ?? "")) patchMetadata({ bpm: event.target.value || null }); }} /></label><label>Original key<input key={`original-key-${state.workspaceSourceSha256}`} defaultValue={metadata.originalKey ?? ""} onBlur={(event) => { if (event.target.value !== (metadata.originalKey ?? "")) patchMetadata({ originalKey: event.target.value || null }); }} /></label><label>Original BPM<input key={`original-bpm-${state.workspaceSourceSha256}`} defaultValue={metadata.originalBpm ?? ""} onBlur={(event) => { if (event.target.value !== (metadata.originalBpm ?? "")) patchMetadata({ originalBpm: event.target.value || null }); }} /></label></fieldset></section>
      <section className="panel"><h2>Local validation</h2><p><strong>Local approximation only.</strong> Server/Apex validation still gates publication.</p>{state.validation.issues.length === 0 ? <p className="good">No local issues.</p> : <ul>{state.validation.issues.map((issue, index) => <li key={`${issue.code}-${index}`} className={issue.severity === "error" ? "warning" : undefined}>{issue.code}: {issue.message}</li>)}</ul>}<button type="button" disabled={!online || busy || !capabilities.apex_validation || !state.validation.valid} onClick={() => void validateServer()}>Validate with server/Apex</button>{state.serverValidation?.valid === false && <div className="warning-banner"><strong>Server/Apex validation failed for this exact source.</strong><ul>{state.serverValidation.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.code}: {issue.message}</li>)}</ul></div>}{state.serverValidation?.valid === true && state.serverValidation.html !== undefined && <iframe className="apex-draft-preview" title="Server Apex lead-sheet preview" sandbox="" srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><body>${state.serverValidation.html}</body>`} />}</section>
    </div>
    <section className="panel"><h2>Exact Markdown source</h2><textarea className="lead-source-editor" aria-label="Exact lead-sheet Markdown source" spellCheck={false} value={buffer} onChange={(event) => queueWorkspaceSave(event.target.value)} /><p>Every buffer change is stored in the local workspace. Only locally valid source can be promoted into the outbox.</p></section>
    <section className="panel"><h2>Local preview</h2><p><strong>Local approximation — not Apex validated.</strong> Links and HTML are inert.</p><pre className="lead-local-preview">{preview}</pre></section>
    {(capabilities.lyrics_provider || capabilities.shelley_suggestions) && <section className="panel"><h2>Online review candidates</h2>
      {capabilities.lyrics_provider && <div className="enrichment-block"><button type="button" disabled={!online || busy} onClick={() => void providerSearch()}>Search lyrics providers</button>{providerChoices.length > 0 && <ul>{providerChoices.map((choice) => <li key={`${choice.provider}:${choice.id}`}><span>{choice.title} · {choice.artist} · {choice.provider}</span><button type="button" disabled={busy} onClick={() => void importChoice(choice)}>Create candidate</button></li>)}</ul>}</div>}
      {capabilities.shelley_suggestions && <div className="enrichment-block"><label>Ask Shelley for a focused draft<textarea value={prompt} maxLength={1000} onChange={(event) => setPrompt(event.target.value)} /></label><button type="button" disabled={!online || busy || prompt.trim().length < 3} onClick={() => void askShelley()}>Create Shelley candidate</button></div>}
      {candidate !== undefined && <div className="candidate-review"><h3>Review-only candidate</h3><pre>{candidate.source}</pre><button type="button" disabled={busy} onClick={() => { if ("base_source_sha256" in candidate) void sha256Hex(buffer).then((hash) => { if (hash !== candidate.base_source_sha256) { setMessage("Suggestion is stale; current workspace was not changed."); return; } queueWorkspaceSave(candidate.source); setCandidate(undefined); }); else { queueWorkspaceSave(candidate.source); setCandidate(undefined); } }}>Apply to local workspace</button><button type="button" onClick={() => setCandidate(undefined)}>Discard</button></div>}
    </section>}
  </article>;
}
