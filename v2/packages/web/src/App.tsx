import { Component, useEffect, useMemo, useRef, useState, type ErrorInfo, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { BootstrapClientError, type LeadSheetDocument, type VerifiedSnapshot } from "./bootstrap/types";
import { type SnapshotProgress } from "./bootstrap/load";
import { ACTIVE_POINTER_CHANNEL, bootstrapRuntime, type BootstrapRuntimeStatus } from "./bootstrap/runtime";
import { buildLibraryIndex, type LibraryIndex, type LibrarySet, type LibrarySong, type SetSearchField, type SongSearchField } from "./library";
import { LiveSetPage } from "./live/LiveSetPage";
import { buildPerformanceSet, type PerformanceSet } from "./live/model";
import { controllerChangeDisposition, deferredControllerDisposition, waitingWorkerActivationDisposition } from "./service-worker";
import { openSongsStorage, SONGS_STORAGE_NAME } from "./storage";
import "./styles.css";

const CACHE_PREFIX = "songs-v2-shell-";
let deferredControllerReload = false;

export interface ActivePointerState {
  readonly activeGeneration: string | null;
  readonly transitionCount: number;
}

export type ActivePointerInspector = () => Promise<ActivePointerState>;

async function inspectActivePointer(): Promise<ActivePointerState> {
  const storage = await openSongsStorage();
  try {
    const inspection = await storage.inspect();
    return { activeGeneration: inspection.activeGeneration, transitionCount: inspection.transitionCount };
  } finally { storage.close(); }
}

function rawHashPath(): string {
  if (window.location.pathname !== "/" && window.location.pathname !== "/index.html") return "/not-found";
  const raw = window.location.hash.slice(1) || "/";
  return raw.startsWith("/") && !raw.includes("?") && !raw.includes("#") ? raw : "/not-found";
}

function exactLiveHash(): boolean {
  return /^\/sets\/[^/]+\/live$/.test(rawHashPath());
}

type LoadState =
  | { readonly status: "loading"; readonly progress: SnapshotProgress }
  | { readonly status: "ready"; readonly snapshot: VerifiedSnapshot; readonly runtime: BootstrapRuntimeStatus }
  | { readonly status: "error"; readonly error: BootstrapClientError };

function useHashPath(): string {
  const read = () => rawHashPath();
  const [path, setPath] = useState(read);
  useEffect(() => {
    const update = () => setPath(read());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return path;
}

function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const yes = () => setOnline(true);
    const no = () => setOnline(false);
    window.addEventListener("online", yes);
    window.addEventListener("offline", no);
    return () => { window.removeEventListener("online", yes); window.removeEventListener("offline", no); };
  }, []);
  return online;
}

export interface ServiceWorkerState {
  readonly state: "unsupported" | "installing" | "current" | "update-available";
  readonly canApply: boolean;
  readonly controlled: boolean;
  readonly offlineReady: boolean;
  readonly message?: string | undefined;
  readonly apply: () => Promise<void>;
}

interface WorkerCompatibility {
  readonly release: string;
  readonly accepted_bootstrap_manifest_sha256: readonly string[];
}

function workerCompatibility(worker: ServiceWorker): Promise<WorkerCompatibility> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => reject(new Error("waiting worker compatibility timed out")), 2_000);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      window.clearTimeout(timeout);
      const value = event.data;
      if (value === null || typeof value !== "object" || typeof (value as { release?: unknown }).release !== "string" || !Array.isArray((value as { accepted_bootstrap_manifest_sha256?: unknown }).accepted_bootstrap_manifest_sha256)) {
        reject(new Error("waiting worker compatibility is malformed"));
        return;
      }
      const accepted = (value as { accepted_bootstrap_manifest_sha256: unknown[] }).accepted_bootstrap_manifest_sha256;
      if (!accepted.every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))) {
        reject(new Error("waiting worker compatibility hashes are malformed"));
        return;
      }
      resolve({ release: (value as { release: string }).release, accepted_bootstrap_manifest_sha256: accepted as string[] });
    };
    worker.postMessage({ type: "GET_COMPATIBILITY" }, [channel.port2]);
  });
}

function useServiceWorker(
  activeManifestSha256?: string | null,
  contentOfflineReady = false,
): ServiceWorkerState {
  const [state, setState] = useState<"unsupported" | "installing" | "current" | "update-available">("installing");
  const [message, setMessage] = useState<string>();
  const [registration, setRegistration] = useState<ServiceWorkerRegistration>();
  const [canApply, setCanApply] = useState(false);
  const [controlled, setControlled] = useState(false);
  const [shellOfflineReady, setShellOfflineReady] = useState(false);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      setState("unsupported");
      setControlled(false);
      setShellOfflineReady(false);
      return;
    }
    let alive = true;
    let currentRegistration: ServiceWorkerRegistration | undefined;
    let registrationPending = false;
    const controllerChanged = () => {
      if (!alive) return;
      setControlled(navigator.serviceWorker.controller !== null);
      if (controllerChangeDisposition(exactLiveHash()) === "defer") {
        deferredControllerReload = true;
        setMessage("A shell update is ready. Exit locked Live mode before reloading.");
        return;
      }
      window.location.reload();
    };
    const routeChanged = () => {
      if (deferredControllerDisposition(deferredControllerReload, exactLiveHash()) === "reload") window.location.reload();
    };
    const acceptRegistration = (next: ServiceWorkerRegistration | undefined): void => {
      if (!alive) return;
      if (next === undefined) {
        setState("unsupported");
        setControlled(false);
        setShellOfflineReady(false);
        return;
      }
      currentRegistration = next;
      setRegistration(next);
      setControlled(navigator.serviceWorker.controller !== null);
      setState(next.waiting ? "update-available" : "current");
      next.addEventListener("updatefound", () => {
        const worker = next.installing;
        if (worker === null) return;
        setState("installing");
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed") setState(navigator.serviceWorker.controller === null ? "current" : "update-available");
        });
      });
    };
    const ensureRegistration = async (): Promise<void> => {
      if (!alive || currentRegistration !== undefined || registrationPending) return;
      registrationPending = true;
      try { acceptRegistration(await navigator.serviceWorker.register("/sw.js", { scope: "/" })); }
      catch {
        if (alive) {
          setState("unsupported");
          setControlled(false);
          setShellOfflineReady(false);
        }
      } finally { registrationPending = false; }
    };
    navigator.serviceWorker.addEventListener("controllerchange", controllerChanged);
    window.addEventListener("hashchange", routeChanged);
    void ensureRegistration();
    return () => {
      alive = false;
      navigator.serviceWorker.removeEventListener("controllerchange", controllerChanged);
      window.removeEventListener("hashchange", routeChanged);
    };
  }, []);
  useEffect(() => {
    let alive = true;
    setShellOfflineReady(false);
    const controller = "serviceWorker" in navigator ? navigator.serviceWorker.controller : null;
    if (controller === null || activeManifestSha256 === undefined || activeManifestSha256 === null || !contentOfflineReady) return () => { alive = false; };
    workerCompatibility(controller).then((compatibility) => {
      if (alive) setShellOfflineReady(compatibility.accepted_bootstrap_manifest_sha256.includes(activeManifestSha256));
    }).catch(() => {
      if (alive) setShellOfflineReady(false);
    });
    return () => { alive = false; };
  }, [activeManifestSha256, contentOfflineReady, controlled, registration, state]);
  useEffect(() => {
    let alive = true;
    setCanApply(false);
    setMessage((current) => deferredControllerReload ? current : undefined);
    const waiting = registration?.waiting;
    if (state !== "update-available" || waiting === undefined || waiting === null || activeManifestSha256 === undefined || activeManifestSha256 === null) return () => { alive = false; };
    workerCompatibility(waiting).then((compatibility) => {
      if (!alive) return;
      const compatible = compatibility.accepted_bootstrap_manifest_sha256.includes(activeManifestSha256);
      if (!compatible) setMessage(`Shell update ${compatibility.release} is waiting for a compatible verified snapshot. Close all V2 windows before reopening.`);
      else setMessage(`Shell update ${compatibility.release} is waiting. Close all V2 windows to activate it safely.`);
    }).catch(() => {
      if (alive) setMessage("The waiting shell did not provide a valid compatibility contract. Close all V2 windows before reopening.");
    });
    return () => { alive = false; };
  }, [activeManifestSha256, registration, state]);
  const apply = async () => {
    setCanApply(false);
    if (waitingWorkerActivationDisposition() === "defer-until-clients-close") {
      setMessage("Immediate shell activation is disabled. Close all V2 windows, then reopen V2 to activate the waiting update safely.");
    }
  };
  return { state, canApply, controlled, offlineReady: shellOfflineReady && contentOfflineReady, ...(message === undefined ? {} : { message }), apply };
}

function Link({ to, children, className, ariaCurrent }: { readonly to: string; readonly children: ReactNode; readonly className?: string | undefined; readonly ariaCurrent?: "page" | undefined }) {
  return <a href={`#${to}`} className={className} aria-current={ariaCurrent}>{children}</a>;
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  return <button className="icon-button" type="button" onClick={() => setTheme(next)} aria-label={`Theme: ${theme}. Switch to ${next}.`}><span aria-hidden="true">{theme === "dark" ? "◐" : theme === "light" ? "☀" : "◒"}</span></button>;
}

function Header({ path, online, update, recoveryPending = false }: { readonly path: string; readonly online: boolean; readonly update: ReturnType<typeof useServiceWorker>; readonly recoveryPending?: boolean }) {
  const current = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
  return <header className="site-header">
    <a className="skip-link" href="#main">Skip to content</a>
    <div className="brand-row">
      {recoveryPending ? <span className="brand" aria-label="Songs, recovery pending"><span className="brand-mark" aria-hidden="true">KGL</span><span><strong>Songs</strong><small>Verified read-only V2</small></span></span> : <Link to="/" className="brand"><span className="brand-mark" aria-hidden="true">KGL</span><span><strong>Songs</strong><small>Verified read-only V2</small></span></Link>}
      <div className="header-actions">
        <span className={`connection ${online ? "online" : "offline"}`} aria-label={online ? "Online — browser connectivity hint" : "Offline — browser connectivity hint"}><span aria-hidden="true">●</span>{online ? "Online · browser connectivity hint" : "Offline · browser connectivity hint"}</span>
        {update.state === "update-available" && <button type="button" className="update-button" onClick={update.apply} disabled={!update.canApply} title={update.canApply ? "Activate the compatible verified shell update" : "Waiting for a compatible active snapshot"}>{update.canApply ? "Update ready" : "Update waiting for compatible snapshot"}</button>}
        <ThemeToggle />
      </div>
    </div>
    <nav aria-label="Primary">
      {!recoveryPending && <>
        <Link to="/" className={path === "/" ? "active" : undefined} ariaCurrent={path === "/" ? "page" : undefined}>Library</Link>
        <Link to="/songs" className={current("/songs") ? "active" : undefined} ariaCurrent={current("/songs") ? "page" : undefined}>Songs</Link>
        <Link to="/sets" className={current("/sets") ? "active" : undefined} ariaCurrent={current("/sets") ? "page" : undefined}>Set Lists</Link>
      </>}
      <Link to="/status" className={current("/status") ? "active" : undefined} ariaCurrent={current("/status") ? "page" : undefined}>Status</Link>
    </nav>
    {update.message && <p className="update-message" role="status">{update.message}</p>}
  </header>;
}

function Loading({ progress }: { readonly progress: SnapshotProgress }) {
  const label = progress.phase === "manifest" ? "Checking reviewed manifest" : progress.phase === "chunks" ? "Downloading verified chunks" : "Verifying source and Apex content";
  return <section className="state-card loading-state" aria-labelledby="loading-title">
    <p className="eyebrow">Private read-only pilot</p>
    <h1 id="loading-title">Preparing the verified songbook</h1>
    <p>Nothing is shown until the complete snapshot passes its reviewed hash chain.</p>
    <progress className="progress-track" max={Math.max(progress.total, 1)} value={progress.completed} aria-label={`${label}: ${progress.completed} of ${progress.total}`} />
    <p role="status" aria-live="polite"><strong>{label}</strong> · {progress.completed} of {progress.total}</p>
    <div className="skeleton-grid" aria-hidden="true"><span /><span /><span /><span /></div>
  </section>;
}

function ErrorState({ error, retry }: { readonly error: BootstrapClientError; readonly retry: () => void }) {
  const offline = error.code === "NETWORK_OFFLINE";
  const auth = error.code === "UNAUTHENTICATED";
  const unsupported = error.code === "MANIFEST_UNSUPPORTED";
  const refreshAuthentication = () => window.location.assign(`/?auth-refresh=${Date.now()}${window.location.hash}`);
  return <section className="state-card error-state" role="alert" aria-labelledby="error-title">
    <p className="eyebrow">{offline ? "Offline" : auth ? "Authentication required" : unsupported ? "Shell update required" : "Verification stopped"}</p>
    <h1 id="error-title">{offline ? "No saved snapshot yet" : auth ? "Sign in to open the private songbook" : unsupported ? "This saved snapshot needs a newer V2 shell" : "The snapshot was not opened"}</h1>
    <p>{error.message}</p>
    <p className="error-code">Error code: <code>{error.code}</code></p>
    {auth ? <button type="button" className="primary-button" onClick={refreshAuthentication}>Refresh private sign-in</button> : <button type="button" className="primary-button" onClick={retry}>Try again</button>}
  </section>;
}

function PageHeading({ eyebrow, title, children }: { readonly eyebrow: string; readonly title: string; readonly children?: ReactNode }) {
  return <div className="page-heading"><p className="eyebrow">{eyebrow}</p><h1 tabIndex={-1} data-page-heading>{title}</h1>{children}</div>;
}

const SONG_FIELD_LABELS: Readonly<Record<SongSearchField, string>> = Object.freeze({
  title: "Title",
  artist: "Artist",
  slug: "Slug",
  performanceKey: "Performance key",
  originalKey: "Original key",
  bpm: "BPM",
  originalBpm: "Original BPM",
  provenanceStatus: "Provenance status",
  sourceProvider: "Provider",
});

const SET_FIELD_LABELS: Readonly<Record<SetSearchField, string>> = Object.freeze({
  title: "Title",
  slug: "Slug",
  date: "Date",
  location: "Location",
  band: "Band",
  status: "Status",
});

function matchedFieldLabels(fields: readonly string[], labels: Readonly<Record<string, string>>): string {
  return fields.map((field) => labels[field] ?? field).join(", ");
}

function LibraryPage({ index, snapshot, runtime }: { readonly index: LibraryIndex; readonly snapshot: VerifiedSnapshot; readonly runtime: BootstrapRuntimeStatus }) {
  const recentSets = index.recentSets.slice(0, 6);
  const songHighlights = index.songs.slice(0, 12);
  const activeSelection = index.activeSetSelection(null);
  const diagnostics = index.diagnostics;
  const activeSet = activeSelection.set;
  return <>
    <PageHeading eyebrow="Reviewed snapshot" title="Your gig book, without the edit controls"><p>{diagnostics.documents.songs} songs and {diagnostics.documents.sets} Set Lists are loaded only after full verification.</p></PageHeading>
    <section className="metric-grid" aria-label="Snapshot summary">
      <div><strong>{diagnostics.documents.songs}</strong><span>Lead sheets</span></div>
      <div><strong>{diagnostics.documents.sets}</strong><span>Set Lists</span></div>
      <div><strong>{diagnostics.references.resolved}</strong><span>Resolved entries</span></div>
      <div><strong>{runtime.chunks.completed}/{runtime.chunks.total}</strong><span>Chunks verified</span></div>
    </section>
    <section className="panel active-set-card" aria-labelledby="active-set-title">
      <div className="section-title"><div><p className="eyebrow">Read-only selection</p><h2 id="active-set-title">Active Set List</h2></div><span className="readonly-label">No mutation controls</span></div>
      <p className="active-set-explanation">No reviewed pin is configured. The latest-date Set List is shown as the active selection automatically.</p>
      {activeSet === null ? <p className="no-results">No dated Set List is available in this snapshot.</p> : <ul className="document-list compact"><SetRow setList={activeSet} snapshot={snapshot} /></ul>}
    </section>
    <div className="dashboard-grid">
      <section className="panel" aria-labelledby="dashboard-songs-title"><div className="section-title"><div><p className="eyebrow">Browse locally</p><h2 id="dashboard-songs-title">Songs</h2></div><Link to="/songs">View all</Link></div><ul className="document-list compact">{songHighlights.map((song) => <SongRow key={song.id} song={song} snapshot={snapshot} />)}</ul></section>
      <section className="panel" aria-labelledby="dashboard-sets-title"><div className="section-title"><div><p className="eyebrow">Current archive</p><h2 id="dashboard-sets-title">Set Lists</h2></div><Link to="/sets">View all</Link></div><ul className="document-list compact">{recentSets.map((setList) => <SetRow key={setList.id} setList={setList} snapshot={snapshot} />)}</ul></section>
    </div>
  </>;
}

function SongRow({ song, snapshot, matchedFields }: { readonly song: LibrarySong; readonly snapshot: VerifiedSnapshot; readonly matchedFields?: readonly SongSearchField[] | undefined }) {
  const route = snapshot.songRouteById.get(song.id);
  const landscape = song.document.fit.profiles.find((profile) => profile.profile === "ipad-landscape");
  const matched = matchedFields === undefined ? null : matchedFieldLabels(matchedFields, SONG_FIELD_LABELS);
  return <li><Link to={`/songs/${route?.slug ?? song.slug}`}><span><strong>{song.title}</strong><small>{song.artist || "Artist not listed"}</small>{matchedFields !== undefined && <small className="matched-fields" aria-label={matched ? `Matched fields: ${matched}` : "No specific matched fields; showing the local verified snapshot"}>{matched ? `Matched fields: ${matched}` : "Local verified snapshot"}</small>}</span><span className={`fit-dot ${landscape?.status === "needs-editing" ? "warning" : "good"}`}>{landscape?.status === "needs-editing" ? "Landscape warning" : "Fit checked"}</span></Link></li>;
}

function SetRow({ setList, snapshot, matchedFields }: { readonly setList: LibrarySet; readonly snapshot: VerifiedSnapshot; readonly matchedFields?: readonly SetSearchField[] | undefined }) {
  const matched = matchedFields === undefined ? null : matchedFieldLabels(matchedFields, SET_FIELD_LABELS);
  const metadata = [setList.date, setList.location].filter(Boolean).join(" · ");
  return <li><Link to={`/sets/${setList.slug}`}><span><strong>{setList.title}</strong><small>{metadata || "Date and location not listed"}</small>{matchedFields !== undefined && <small className="matched-fields" aria-label={matched ? `Matched fields: ${matched}` : "No specific matched fields; showing the local verified snapshot"}>{matched ? `Matched fields: ${matched}` : "Local verified snapshot"}</small>}</span><span className="entry-count" aria-label={`${setList.document.projection.entries.length} songs`}>{setList.document.projection.entries.length}</span></Link></li>;
}

function SearchControls({ id, label, value, onChange, placeholder, clearLabel }: { readonly id: string; readonly label: string; readonly value: string; readonly onChange: (value: string) => void; readonly placeholder: string; readonly clearLabel: string }) {
  const input = useRef<HTMLInputElement>(null);
  const clear = () => {
    onChange("");
    requestAnimationFrame(() => input.current?.focus());
  };
  return <div className="search-controls"><label className="filter-field" htmlFor={id}><span>{label}</span><input ref={input} id={id} type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>{value !== "" && <button type="button" className="clear-button" onClick={clear} aria-label={clearLabel}>Clear</button>}</div>;
}

function SongsPage({ index, snapshot }: { readonly index: LibraryIndex; readonly snapshot: VerifiedSnapshot }) {
  const [filter, setFilter] = useState("");
  const results = useMemo(() => index.searchSongs(filter), [filter, index]);
  const query = filter.trim();
  return <>
    <PageHeading eyebrow="Lead sheets" title="Songs"><p>Search and browse the active verified snapshot locally. Results cover title, artist, slug, keys, BPM, provenance, and provider.</p></PageHeading>
    <SearchControls id="song-search" label="Search songs in this local verified snapshot" value={filter} onChange={setFilter} placeholder="Title, artist, key, BPM, provider" clearLabel="Clear song search" />
    <p className="result-count" role="status">{query === "" ? `Showing all ${results.length} songs from the local verified snapshot.` : `Showing ${results.length} of ${index.songs.length} songs for “${query}”.`}</p>
    {results.length === 0 ? <section className="panel no-results" aria-live="polite"><h2>No songs found</h2><p>No songs matched “{query}” in this local verified snapshot.</p></section> : <ul className="document-list panel" aria-label="Song search results">{results.map((result) => <SongRow key={result.song.id} song={result.song} snapshot={snapshot} matchedFields={query === "" ? undefined : result.matchedFields} />)}</ul>}
  </>;
}

function SetsPage({ index, snapshot }: { readonly index: LibraryIndex; readonly snapshot: VerifiedSnapshot }) {
  const [filter, setFilter] = useState("");
  const results = useMemo(() => index.searchSets(filter), [filter, index]);
  const query = filter.trim();
  return <>
    <PageHeading eyebrow="Performance archive" title="Set Lists"><p>Search title, slug, date, location, band, and status in the active verified snapshot locally.</p></PageHeading>
    <SearchControls id="set-search" label="Search Set Lists in this local verified snapshot" value={filter} onChange={setFilter} placeholder="Title, date, location, band, status" clearLabel="Clear Set List search" />
    <p className="result-count" role="status">{query === "" ? `Showing all ${results.length} Set Lists from the local verified snapshot.` : `Showing ${results.length} of ${index.sets.length} Set Lists for “${query}”.`}</p>
    {results.length === 0 ? <section className="panel no-results" aria-live="polite"><h2>No Set Lists found</h2><p>No Set Lists matched “{query}” in this local verified snapshot.</p></section> : <ul className="document-list panel" aria-label="Set List search results">{results.map((result) => <SetRow key={result.set.id} setList={result.set} snapshot={snapshot} matchedFields={result.matchedFields} />)}</ul>}
  </>;
}

function MetaItem({ label, value }: { readonly label: string; readonly value?: string | undefined }) {
  if (!value) return null;
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function apexPresentationHtml(html: string, snapshot: VerifiedSnapshot): string {
  const template = document.createElement("template");
  template.innerHTML = html
    .replace(/^<h1\b[^>]*>[\s\S]*?<\/h1>\s*/i, "")
    .replace(' style="list-style-type: upper-alpha"', ' class="apex-upper-alpha"');
  for (const link of template.content.querySelectorAll<HTMLAnchorElement>("a")) {
    const href = link.getAttribute("href");
    if (href?.startsWith("/song/")) {
      let slug: string | undefined;
      try { slug = decodeURIComponent(href.slice(6)); } catch { slug = undefined; }
      if (slug !== undefined && snapshot.routeByKey.has(`song:${slug}`)) {
        link.setAttribute("href", `#/songs/${encodeURIComponent(slug)}`);
        link.removeAttribute("target");
        link.removeAttribute("download");
      } else {
        link.removeAttribute("href");
        link.setAttribute("aria-disabled", "true");
      }
    } else if (href !== null) {
      link.setAttribute("rel", "noopener noreferrer");
    }
  }
  return template.innerHTML;
}

function ApexSheet({ song, snapshot }: { readonly song: LeadSheetDocument; readonly snapshot: VerifiedSnapshot }) {
  const html = useMemo(() => apexPresentationHtml(song.apex.html, snapshot), [snapshot, song.apex.html]);
  const handleClick = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target instanceof Element ? event.target.closest("a") : null;
    const href = target?.getAttribute("href");
    if (href?.startsWith("#/songs/")) {
      event.preventDefault();
      window.location.hash = href;
    }
  };
  return <>
    <h2 className="visually-hidden">Lead sheet sections</h2>
    <section className="apex-sheet" aria-label={`${song.projection.title} lead sheet`} data-authority="apex" onClick={handleClick} dangerouslySetInnerHTML={{ __html: html }} />
  </>;
}

function LeadSheetPage({ song, snapshot }: { readonly song: LeadSheetDocument; readonly snapshot: VerifiedSnapshot }) {
  const fit = Object.fromEntries(song.fit.profiles.map((profile) => [profile.profile, profile]));
  return <article className="detail-page">
    <nav className="breadcrumbs" aria-label="Breadcrumb"><Link to="/songs">Songs</Link><span aria-hidden="true">/</span><span>{song.projection.title}</span></nav>
    <header className="detail-header">
      <div><p className="eyebrow">Verified lead sheet</p><h1 tabIndex={-1} data-page-heading>{song.projection.title}</h1><p className="artist">{song.projection.metadata.artist}</p></div>
      <div className="fit-summary" aria-label="Fit evidence"><span className="good">Portrait fit</span><span className={fit["ipad-landscape"]?.status === "needs-editing" ? "warning" : "good"}>{fit["ipad-landscape"]?.status === "needs-editing" ? "Landscape needs editing" : "Landscape fit"}</span><span>Phone scrolls</span></div>
    </header>
    <dl className="metadata-grid">
      <MetaItem label="Performance key" value={song.projection.metadata.performanceKey} />
      <MetaItem label="BPM" value={song.projection.metadata.bpm} />
      <MetaItem label="Original key" value={song.projection.metadata.originalKey} />
      <MetaItem label="Original BPM" value={song.projection.metadata.originalBpm} />
    </dl>
    <div className="authority-note"><strong>Renderer authority:</strong> Apex output verified against source <code>{song.source.sha256.slice(0, 12)}…</code>. No browser Markdown renderer is present.</div>
    <ApexSheet song={song} snapshot={snapshot} />
    <p className="back-link"><Link to="/songs">← Back to songs</Link></p>
  </article>;
}

function SetListPage({ performanceSet }: { readonly performanceSet: PerformanceSet }) {
  const setList = performanceSet.document;
  const entryById = new Map(performanceSet.entries.map((entry) => [entry.entryId, entry]));
  return <article className="detail-page">
    <nav className="breadcrumbs" aria-label="Breadcrumb"><Link to="/sets">Set Lists</Link><span aria-hidden="true">/</span><span>{setList.projection.title}</span></nav>
    <header className="detail-header"><div><p className="eyebrow">Read-only Set List</p><h1 tabIndex={-1} data-page-heading>{setList.projection.title}</h1><p className="artist">{[setList.projection.metadata.date, setList.projection.metadata.location].filter(Boolean).join(" · ")}</p></div><div className="set-detail-actions"><span className="set-total">{performanceSet.entries.length} songs</span><Link to={`/sets/${performanceSet.slug}/live`} className="primary-button live-launch">Open locked Live</Link></div></header>
    {setList.projection.metadata.reviewRequired && <p className="warning-banner">This frozen Set List is marked review required.</p>}
    {performanceSet.warningOccurrences.length > 0 && <p className="warning-banner">{performanceSet.warningOccurrences.length} occurrence{performanceSet.warningOccurrences.length === 1 ? " has" : "s have"} an explicit iPad landscape fit warning. Live mode remains readable at the 16px floor with scrolling.</p>}
    <div className="set-sections">{setList.projection.sections.map((section) => <section key={section.projectionKey} className="set-section"><h2>{section.heading || `Set ${section.ordinal}`}</h2><ol>{section.entryIds.map((entryId) => {
      const entry = entryById.get(entryId);
      if (entry === undefined) return <li key={entryId} className="missing-entry">Missing frozen entry {entryId}</li>;
      return <li key={entry.entryId} data-entry-id={entry.entryId} className={entry.columnBreakBefore ? "column-break" : undefined}><span className="ordinal">{entry.ordinal}</span><div><strong><Link to={`/songs/${entry.song.slug}`}>{entry.label}</Link></strong>{entry.singer && <span className="entry-detail"><b>Singer</b> {entry.singer}</span>}{entry.note && <span className="entry-detail"><b>Note</b> {entry.note}</span>}{entry.landscapeWarning && <span className="entry-detail live-fit-warning"><b>Fit</b> iPad landscape needs scrolling at the 16px floor</span>}</div></li>;
    })}</ol></section>)}</div>
  </article>;
}

function formatBytes(value: number | null): string {
  if (value === null) return "Unavailable";
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = value / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index]!;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}

function fitDistributionText(distribution: { readonly total: number; readonly fit: number; readonly needsEditing: number; readonly scrollable: number }): string {
  return `${distribution.total} total · ${distribution.fit} fit · ${distribution.needsEditing} needs-editing · ${distribution.scrollable} scrollable`;
}

function selectionReason(selection: ReturnType<LibraryIndex["activeSetSelection"]>): string {
  if (selection.reason === "latest-date") return "latest-date (no reviewed pin configured)";
  if (selection.reason === "reviewed-pin") return "reviewed-pin";
  return "none";
}

function StatusPage({ index, snapshot, online, update, runtime }: { readonly index: LibraryIndex | null; readonly snapshot: VerifiedSnapshot; readonly online: boolean; readonly update: ReturnType<typeof useServiceWorker>; readonly runtime: BootstrapRuntimeStatus }) {
  const diagnostics = index?.diagnostics ?? null;
  const activeSelection = index?.activeSetSelection(null) ?? null;
  const active = activeSnapshotFor(snapshot, runtime);
  const recoveryPending = runtime.source === "indexeddb" && !active;
  const offlineReady = completeOfflineReady(snapshot, runtime, update);
  const source = recoveryPending ? "Verified retained IndexedDB snapshot (active pointer recovery pending)" : runtime.update === "failed-retained" ? "Active verified IndexedDB snapshot (update failed; active generation retained)" : runtime.source === "indexeddb" ? "Active verified IndexedDB snapshot" : runtime.source === "network" ? "Verified network snapshot (not active; storage unchanged)" : "Verified memory snapshot (not active; not saved)";
  const persistence = runtime.persistence === "granted" ? "Granted (storage remains evictable)" : runtime.persistence === "denied" ? "Not granted" : runtime.persistence === "unsupported" ? "Unsupported" : "Unknown";
  return <>
    <PageHeading eyebrow="Diagnostics" title="Snapshot status"><p>Software evidence only. Physical Safari/iPad acceptance is still pending.</p></PageHeading>
    {runtime.warning && <p className={recoveryPending ? "recovery-banner" : runtime.update === "failed-retained" ? "update-warning-banner" : "warning-banner"} role="status">{runtime.warning}</p>}
    {diagnostics === null || activeSelection === null ? <section className="diagnostics-panel" aria-labelledby="index-diagnostics-title">
      <h2 id="index-diagnostics-title">Library index diagnostics unavailable</h2>
      <p className="status-note">Catalog selectors remain closed because this verified snapshot is not the active IndexedDB pointer generation. Runtime and storage diagnostics remain available below.</p>
    </section> : <section aria-labelledby="index-diagnostics-title" className="diagnostics-panel">
      <h2 id="index-diagnostics-title">Library index diagnostics</h2>
      <dl className="status-grid panel">
        <MetaItem label="Frozen date" value={diagnostics.frozenDate} />
        <MetaItem label="Snapshot freshness" value={`Reviewed baseline frozen ${diagnostics.frozenDate}; no live freshness inferred`} />
        <MetaItem label="Indexed counts" value={`${diagnostics.documents.total} documents · ${diagnostics.documents.songs} songs · ${diagnostics.documents.sets} Set Lists`} />
        <MetaItem label="Route coverage" value={`${diagnostics.routeCount}/${diagnostics.documents.total} indexed routes`} />
        <MetaItem label="Set Entry references" value={`${diagnostics.references.resolved} resolved / ${diagnostics.references.unresolved} unresolved`} />
        <MetaItem label="Active selection reason" value={selectionReason(activeSelection)} />
        <MetaItem label="Active selection title" value={activeSelection.set?.title ?? "None"} />
      </dl>
      <section className="fit-distributions" aria-labelledby="fit-distributions-title">
        <h3 id="fit-distributions-title">Exact fit distributions</h3>
        <ul>
          <li><strong>iPad portrait</strong><span>{fitDistributionText(diagnostics.fit.portrait)}</span></li>
          <li><strong>iPad landscape</strong><span>{fitDistributionText(diagnostics.fit.landscape)}</span></li>
          <li><strong>Phone</strong><span>{fitDistributionText(diagnostics.fit.phone)}</span></li>
        </ul>
      </section>
      <section className="warning-songs" aria-labelledby="warning-songs-title">
        <h3 id="warning-songs-title">Landscape warnings ({diagnostics.landscapeWarningSlugs.length} linked warning songs)</h3>
        <ul>{diagnostics.landscapeWarningSlugs.map((slug) => <li key={slug}><Link to={`/songs/${slug}`}>{slug}</Link></li>)}</ul>
      </section>
      <section className="search-contract" aria-labelledby="search-contract-title">
        <h3 id="search-contract-title">Search field contract</h3>
        <p><strong>Songs:</strong> title, artist, slug, performance key, original key, BPM, original BPM, provenance status, provider.</p>
        <p><strong>Set Lists:</strong> title, slug, date, location, band, status.</p>
      </section>
      {diagnostics.contractKind === "current-exact" ? <details className="deleted-paths"><summary>Deleted Set paths excluded ({diagnostics.excludedDeletedSetPaths.length} exact deleted Set paths)</summary><ul>{diagnostics.excludedDeletedSetPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></details> : <p className="status-note">Deleted-path exclusions are unavailable for this reviewed predecessor contract.</p>}
    </section>}
    <dl className="status-grid panel">
      <MetaItem label="Generation" value={snapshot.manifest.generation} />
      <MetaItem label="Source commit" value={snapshot.manifest.source_baseline.commit} />
      <MetaItem label="Snapshot SHA-256" value={snapshot.manifest.snapshot_sha256} />
      <MetaItem label="Snapshot source" value={source} />
      <MetaItem label="Completeness" value={`${runtime.docs.completed}/${runtime.docs.total} documents · ${runtime.chunks.completed}/${runtime.chunks.total} chunks`} />
      <MetaItem label="Network" value={online ? "Online" : "Offline"} />
      <MetaItem label="Offline restart" value={offlineReady ? "Available from the active verified snapshot" : "Unavailable until a snapshot is activated"} />
      <MetaItem label="IndexedDB" value={`${SONGS_STORAGE_NAME} · ${runtime.database}`} />
      <MetaItem label="Active generation" value={runtime.activeGeneration ?? "None"} />
      <MetaItem label="Active storage instance" value={runtime.activeStorageGeneration ?? "None"} />
      <MetaItem label="Retained generation" value={runtime.retainedGeneration ?? "None"} />
      <MetaItem label="Retained storage instance" value={runtime.retainedStorageGeneration ?? "None"} />
      <MetaItem label="Manifest SHA-256" value={runtime.manifestSha256 ?? "Unavailable"} />
      <MetaItem label="Pointer transitions" value={String(runtime.transitions)} />
      <MetaItem label="Content update" value={runtime.update} />
      <MetaItem label="Persistence request" value={persistence} />
      <MetaItem label="Origin-wide usage" value={formatBytes(runtime.usage)} />
      <MetaItem label="Origin-wide quota" value={formatBytes(runtime.quota)} />
      <MetaItem label="Origin-wide headroom" value={formatBytes(runtime.headroom)} />
      <MetaItem label="Service worker" value={update.state} />
      <MetaItem label="Shell cache prefix" value={CACHE_PREFIX} />
      <MetaItem label="Physical iPad" value="Pending" />
    </dl>
    <p className="status-note">Storage estimates are origin-wide and advisory. Persistence does not guarantee that browser storage cannot be evicted.</p>
  </>;
}

function decodedRouteSegment(value: string): string | undefined {
  try { return decodeURIComponent(value); } catch { return undefined; }
}

function exactSongSlug(path: string): string | undefined {
  const match = /^\/songs\/([^/]+)$/.exec(path);
  return match === null ? undefined : decodedRouteSegment(match[1]!);
}

function exactSetRoute(path: string): { readonly slug: string; readonly live: boolean } | undefined {
  const match = /^\/sets\/([^/]+)(\/live)?$/.exec(path);
  if (match === null) return undefined;
  const slug = decodedRouteSegment(match[1]!);
  return slug === undefined ? undefined : { slug, live: match[2] === "/live" };
}

function activeSnapshotFor(snapshot: VerifiedSnapshot, runtime: BootstrapRuntimeStatus): boolean {
  return runtime.source === "indexeddb" && runtime.activeGeneration === snapshot.manifest.generation;
}

function recoveryPendingFor(snapshot: VerifiedSnapshot, runtime: BootstrapRuntimeStatus): boolean {
  return runtime.source === "indexeddb" && !activeSnapshotFor(snapshot, runtime);
}

function durableOfflineReady(snapshot: VerifiedSnapshot, runtime: BootstrapRuntimeStatus): boolean {
  return activeSnapshotFor(snapshot, runtime) && runtime.offlineReady;
}

function completeOfflineReady(snapshot: VerifiedSnapshot, runtime: BootstrapRuntimeStatus, update: ServiceWorkerState): boolean {
  return durableOfflineReady(snapshot, runtime) && update.controlled && update.offlineReady;
}

function InactiveSnapshotPage({ snapshot, runtime }: { readonly snapshot: VerifiedSnapshot; readonly runtime: BootstrapRuntimeStatus }) {
  const recoveryPending = recoveryPendingFor(snapshot, runtime);
  return <section className={`state-card ${recoveryPending ? "recovery-state" : ""}`} role="status" aria-labelledby="inactive-title">
    <p className="eyebrow">{recoveryPending ? "Recovery pending" : "Activation required"}</p>
    <h1 id="inactive-title" tabIndex={-1} data-page-heading>{recoveryPending ? "Recovery pending: verified browsing is paused while the active pointer recovers" : "Verified browsing waits for an active saved snapshot"}</h1>
    <p>{recoveryPending ? "The retained verified snapshot is available for runtime diagnostics, but IndexedDB has not confirmed a matching active generation." : "The downloaded snapshot verified successfully, but it is not the active IndexedDB pointer generation."} Library, song, Set List, and search selectors stay closed until activation completes.</p>
    <dl className="status-grid recovery-details">
      <MetaItem label="Snapshot generation" value={snapshot.manifest.generation} />
      <MetaItem label="Snapshot source" value={runtime.source} />
      <MetaItem label="Active generation" value={runtime.activeGeneration ?? "None"} />
      <MetaItem label="Retained generation" value={runtime.retainedGeneration ?? "None"} />
      <MetaItem label="Runtime warning" value={runtime.warning ?? (recoveryPending ? "Pointer recovery is pending" : "Snapshot activation is required")} />
    </dl>
    <Link to="/status" className="primary-button">View runtime status</Link>
  </section>;
}

export function GuardedLiveSetPage({ performanceSet, exitHref, expectedStorageGeneration, expectedTransitionCount, inspectActiveGeneration = inspectActivePointer }: { readonly performanceSet: PerformanceSet; readonly exitHref: string; readonly expectedStorageGeneration?: string | null | undefined; readonly expectedTransitionCount?: number | undefined; readonly inspectActiveGeneration?: ActivePointerInspector }) {
  const [guard, setGuard] = useState<"checking" | "active" | "stopped">("checking");
  useEffect(() => {
    let alive = true;
    let checking = false;
    const inspect = async (): Promise<void> => {
      if (!alive || checking) return;
      checking = true;
      try {
        const pointer = await inspectActiveGeneration();
        const matches = expectedStorageGeneration !== undefined
          && expectedStorageGeneration !== null
          && expectedTransitionCount !== undefined
          && pointer.activeGeneration === expectedStorageGeneration
          && pointer.transitionCount === expectedTransitionCount;
        if (alive) setGuard((current) => current === "stopped" ? "stopped" : matches ? "active" : "stopped");
      } catch {
        if (alive) setGuard("stopped");
      } finally { checking = false; }
    };
    const visible = () => { if (document.visibilityState === "visible") void inspect(); };
    const pointerChanged = () => { void inspect(); };
    const timer = window.setInterval(() => { void inspect(); }, 2_000);
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(ACTIVE_POINTER_CHANNEL);
    channel?.addEventListener("message", pointerChanged);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pageshow", inspect);
    void inspect();
    return () => {
      alive = false;
      window.clearInterval(timer);
      channel?.removeEventListener("message", pointerChanged);
      channel?.close();
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pageshow", inspect);
    };
  }, [expectedStorageGeneration, expectedTransitionCount, inspectActiveGeneration]);
  if (guard === "checking") return <main className="locked-live-stage locked-live-theme-dark" aria-label="Locked Live mode checking"><section className="locked-live-panel locked-live-invalid" role="status"><p className="locked-live-eyebrow">Verifying active snapshot</p><h1 className="locked-live-title">Opening locked Live safely</h1><p>Confirming this tab still matches the active IndexedDB pointer generation.</p></section></main>;
  if (guard === "stopped") return <main className="locked-live-stage locked-live-theme-dark" aria-label="Locked Live mode stopped"><section className="locked-live-panel locked-live-invalid" role="alert"><p className="locked-live-eyebrow">Active snapshot changed</p><h1 className="locked-live-title">Locked Live stopped safely</h1><p>This tab no longer matches the active IndexedDB pointer generation. Reload verified content before continuing.</p><button className="locked-live-nav-button" type="button" onClick={() => window.location.reload()}>Reload verified content</button></section></main>;
  return <LiveSetPage key={performanceSet.id} performanceSet={performanceSet} exitHref={exitHref} />;
}

export function ReadyApp({ snapshot, online, update, runtime, inspectActiveGeneration }: { readonly snapshot: VerifiedSnapshot; readonly online: boolean; readonly update: ServiceWorkerState; readonly runtime: BootstrapRuntimeStatus; readonly inspectActiveGeneration?: ActivePointerInspector }) {
  const path = useHashPath();
  const active = activeSnapshotFor(snapshot, runtime);
  const index = useMemo(() => active ? buildLibraryIndex(snapshot) : null, [active, snapshot]);
  const selectorsClosed = !active;
  const offlineReady = completeOfflineReady(snapshot, runtime, update);
  const songSlug = exactSongSlug(path);
  const setRoute = exactSetRoute(path);
  const routedSet = useMemo(() => index === null || setRoute === undefined ? null : index.setBySlug(setRoute.slug), [index, setRoute?.slug]);
  const routedPerformanceSet = useMemo(() => index === null || routedSet === null ? null : buildPerformanceSet(index, routedSet), [index, routedSet]);
  useEffect(() => { document.querySelector<HTMLElement>("[data-page-heading]")?.focus(); window.scrollTo({ top: 0, behavior: "auto" }); }, [path]);
  let page: ReactNode;
  let livePage: ReactNode = null;
  if (path === "/status") page = <StatusPage index={index} snapshot={snapshot} online={online} update={update} runtime={runtime} />;
  else if (selectorsClosed || index === null) page = <InactiveSnapshotPage snapshot={snapshot} runtime={runtime} />;
  else if (path === "/") page = <LibraryPage index={index} snapshot={snapshot} runtime={runtime} />;
  else if (path === "/songs") page = <SongsPage index={index} snapshot={snapshot} />;
  else if (path === "/sets") page = <SetsPage index={index} snapshot={snapshot} />;
  else if (songSlug !== undefined) {
    const song = index.songBySlug(songSlug);
    page = song === null ? <NotFound /> : <LeadSheetPage song={song.document} snapshot={snapshot} />;
  } else if (setRoute !== undefined) {
    if (routedSet === null || routedPerformanceSet === null) page = <NotFound />;
    else if (setRoute.live) {
      livePage = <GuardedLiveSetPage performanceSet={routedPerformanceSet} exitHref={`#/sets/${routedSet.slug}`} expectedStorageGeneration={runtime.activeStorageGeneration} expectedTransitionCount={runtime.transitions} {...(inspectActiveGeneration === undefined ? {} : { inspectActiveGeneration })} />;
      page = null;
    } else page = <SetListPage performanceSet={routedPerformanceSet} />;
  } else page = <NotFound />;
  if (livePage !== null) return <>{livePage}</>;
  return <><Header path={path} online={online} update={update} recoveryPending={selectorsClosed} /><main id="main">
    {active && !online && <div className="offline-banner" role="status">Offline — browse and search are local. {offlineReady ? "Using the active verified snapshot saved in IndexedDB." : "This active snapshot is not ready for offline restart."}</div>}
    {!active && <div className="session-banner" role="status">Verified snapshot — catalog selectors are unavailable until this generation becomes the active IndexedDB pointer.</div>}
    {active && runtime.update === "failed-retained" && <div className="update-warning-banner" role="status">Update failed; the active verified snapshot was retained. Browsing and local search remain available.</div>}
    {page}
  </main><Footer snapshot={snapshot} runtime={runtime} update={update} /></>;
}

function NotFound() { return <section className="state-card"><p className="eyebrow">V2 route</p><h1 tabIndex={-1} data-page-heading>Page not found</h1><p>This isolated shell does not fall through to v1.</p><Link to="/" className="primary-button">Return to library</Link></section>; }

function Footer({ snapshot, runtime, update }: { readonly snapshot: VerifiedSnapshot; readonly runtime: BootstrapRuntimeStatus; readonly update: ServiceWorkerState }) { return <footer><span>Read-only pilot</span><span>{snapshot.manifest.generation}</span><span>{completeOfflineReady(snapshot, runtime, update) ? "Offline restart ready" : "Not offline-ready (session only)"}</span><span>Physical iPad: pending</span></footer>; }

export class ShellErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  override componentDidCatch(error: Error, info: ErrorInfo): void { console.error("V2 shell render failure", error, info.componentStack); }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <main id="main"><section className="state-card error-state" role="alert"><p className="eyebrow">V2 shell failure</p><h1>Unable to display this route</h1><p>The verified snapshot remains read-only. Reload the isolated V2 shell to recover.</p><button className="primary-button" type="button" onClick={() => window.location.reload()}>Reload V2</button></section></main>;
  }
}

export function ActivePointerBoundary({ snapshot, runtime, onDrift, children, inspectPointer = inspectActivePointer }: { readonly snapshot: VerifiedSnapshot; readonly runtime: BootstrapRuntimeStatus; readonly onDrift: () => void; readonly children: ReactNode; readonly inspectPointer?: ActivePointerInspector }) {
  const guarded = activeSnapshotFor(snapshot, runtime);
  const [state, setState] = useState<"checking" | "active" | "stopped">(guarded ? "checking" : "active");
  const onDriftRef = useRef(onDrift);
  onDriftRef.current = onDrift;
  useEffect(() => {
    if (!guarded) {
      setState("active");
      return;
    }
    if (runtime.activeStorageGeneration === undefined || runtime.activeStorageGeneration === null) {
      setState("stopped");
      onDriftRef.current();
      return;
    }
    let alive = true;
    let checking = false;
    const verify = async (): Promise<void> => {
      if (!alive || checking) return;
      checking = true;
      try {
        const pointer = await inspectPointer();
        const matches = pointer.activeGeneration === runtime.activeStorageGeneration && pointer.transitionCount === runtime.transitions;
        if (!alive) return;
        if (matches) setState((current) => current === "stopped" ? "stopped" : "active");
        else {
          setState("stopped");
          onDriftRef.current();
        }
      } catch {
        if (alive) {
          setState("stopped");
          onDriftRef.current();
        }
      } finally { checking = false; }
    };
    const visible = () => { if (document.visibilityState === "visible") void verify(); };
    const changed = () => { void verify(); };
    const timer = window.setInterval(() => { void verify(); }, 2_000);
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(ACTIVE_POINTER_CHANNEL);
    channel?.addEventListener("message", changed);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pageshow", verify);
    void verify();
    return () => {
      alive = false;
      window.clearInterval(timer);
      channel?.removeEventListener("message", changed);
      channel?.close();
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pageshow", verify);
    };
  }, [guarded, inspectPointer, runtime.activeStorageGeneration, runtime.transitions]);
  if (!guarded || state === "active") return <>{children}</>;
  return <main id="main"><section className="state-card recovery-state" role="status" aria-labelledby="pointer-check-title"><p className="eyebrow">Active snapshot authority</p><h1 id="pointer-check-title">{state === "checking" ? "Confirming the active saved snapshot" : "The active saved snapshot changed"}</h1><p>{state === "checking" ? "Catalog routes stay closed until the physical IndexedDB pointer and transition epoch are confirmed." : "Reloading and reverifying the new active snapshot before browsing continues."}</p></section></main>;
}

export function App() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: "loading", progress: { phase: "manifest", completed: 0, total: 1 } });
  const online = useOnline();
  const previousOnline = useRef(online);
  const deferredConnectivityRefresh = useRef(false);
  const update = useServiceWorker(
    state.status === "ready" ? state.runtime.manifestSha256 : null,
    state.status === "ready" && durableOfflineReady(state.snapshot, state.runtime),
  );
  useEffect(() => {
    if (previousOnline.current === online) return;
    previousOnline.current = online;
    if (exactLiveHash()) deferredConnectivityRefresh.current = true;
    else setAttempt((value) => value + 1);
  }, [online]);
  useEffect(() => {
    const routeChanged = (): void => {
      if (!exactLiveHash() && deferredConnectivityRefresh.current) {
        deferredConnectivityRefresh.current = false;
        setAttempt((value) => value + 1);
      }
    };
    window.addEventListener("hashchange", routeChanged);
    return () => window.removeEventListener("hashchange", routeChanged);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setState({ status: "loading", progress: { phase: "manifest", completed: 0, total: 1 } });
    bootstrapRuntime({ online, signal: controller.signal, onProgress: (progress) => { if (alive) setState({ status: "loading", progress }); } }).then((result) => { if (alive) setState({ status: "ready", snapshot: result.snapshot, runtime: result.status }); }).catch((error: unknown) => {
      if (controller.signal.aborted || !alive) return;
      setState({ status: "error", error: error instanceof BootstrapClientError ? error : new BootstrapClientError("API_PROTOCOL_INVALID", "An unexpected bootstrap error occurred", error) });
    });
    return () => { alive = false; controller.abort(); };
  }, [attempt]);
  if (state.status === "ready") return <ActivePointerBoundary snapshot={state.snapshot} runtime={state.runtime} onDrift={() => setAttempt((value) => value + 1)}><ReadyApp snapshot={state.snapshot} online={online} update={update} runtime={state.runtime} /></ActivePointerBoundary>;
  return <><Header path="/" online={online} update={update} /><main id="main">{state.status === "loading" ? <Loading progress={state.progress} /> : <ErrorState error={state.error} retry={() => setAttempt((value) => value + 1)} />}</main></>;
}
