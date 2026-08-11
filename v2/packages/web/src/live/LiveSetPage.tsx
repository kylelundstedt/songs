import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { cloneApexPresentationNode, fitLiveLeadSheet, type ApexSourceNode, type RuntimeFitTarget } from "./fitter";
import { type PerformanceEntry, type PerformanceSet } from "./model";

export interface LiveSetPageProps {
  readonly performanceSet: PerformanceSet;
  readonly exitHref: string;
}

type StageTheme = "bright" | "dark";
type NavigationDirection = "previous" | "next";

/**
 * Remove navigation from links cloned out of the verified Apex source.
 *
 * The source itself remains untouched in an inert template: it is the authority
 * supplied by the verified snapshot. Only sanitized fitter clones enter the
 * connected presentation subtree.
 */
function prepareClonedApexPresentation(columns: HTMLElement, title: string): void {
  for (const styled of columns.querySelectorAll<HTMLElement>("[style]")) {
    if (styled.tagName === "OL" && styled.style.listStyleType === "upper-alpha") styled.classList.add("apex-upper-alpha");
    styled.removeAttribute("style");
  }
  for (const [index, column] of [...columns.querySelectorAll<HTMLElement>(".live-column")].entries()) {
    column.tabIndex = 0;
    column.setAttribute("aria-label", `${title} fitted column ${index + 1}`);
  }
  for (const link of columns.querySelectorAll<HTMLAnchorElement>("a")) {
    link.removeAttribute("href");
    link.removeAttribute("target");
    link.removeAttribute("download");
    link.removeAttribute("rel");
    for (const attribute of [...link.attributes]) {
      if (/^on/i.test(attribute.name)) link.removeAttribute(attribute.name);
    }
    link.setAttribute("aria-disabled", "true");
    link.tabIndex = -1;
  }
}

function isFocusedInteractiveControl(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("a, button, input, textarea, select, summary, [contenteditable=\"true\"], [role=\"button\"]") !== null;
}

function isFocusedScrollablePresentation(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".live-column") !== null;
}

function navigationKey(event: KeyboardEvent): NavigationDirection | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  if (event.key === "ArrowLeft" || event.key === "PageUp") return "previous";
  if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " " || event.key === "Spacebar" || event.code === "Space") return "next";
  return null;
}

function metadataValue(value: string | undefined): string {
  return value === undefined || value.trim() === "" ? "—" : value;
}

function entrySection(entry: PerformanceEntry): string {
  return entry.sectionHeading ?? entry.section.heading ?? `Set ${entry.section.ordinal}`;
}

function resetScroll(element: HTMLElement | null): void {
  if (element === null) return;
  element.scrollTop = 0;
  element.scrollLeft = 0;
}

function renderReadableFallback(source: ApexSourceNode, columns: HTMLElement, title: string): void {
  const column = source.ownerDocument.createElement("div");
  column.className = "live-column";
  for (const node of source.childNodes) column.append(cloneApexPresentationNode(node));
  columns.replaceChildren(column);
  columns.dataset.fitStatus = "needs-editing";
  columns.dataset.formFactor = "phone";
  columns.dataset.bodyPx = "20";
  columns.dataset.lineHeight = "1.24";
  columns.dataset.columnCount = "1";
  columns.style.setProperty("--sheet-font", "20px");
  columns.style.setProperty("--sheet-line", "1.24");
  prepareClonedApexPresentation(columns, title);
}

/**
 * A deliberately closed, one-occurrence-at-a-time performance surface.
 *
 * All navigation is over the immutable PerformanceSet already held by the
 * caller.  There are no route lookups, storage writes, network calls, or edit
 * affordances in this component.
 */
export function LiveSetPage({ performanceSet, exitHref }: LiveSetPageProps) {
  const [occurrenceIndex, setOccurrenceIndex] = useState(() => performanceSet.clampIndex(0));
  const [theme, setTheme] = useState<StageTheme>("bright");
  const [runtimeWarning, setRuntimeWarning] = useState<string | null>(null);
  const stageRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLTemplateElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const fitGeneration = useRef(0);

  // A changed immutable set starts at its first authored occurrence.
  useEffect(() => {
    setOccurrenceIndex(performanceSet.clampIndex(0));
  }, [performanceSet]);

  const boundedIndex = performanceSet.clampIndex(occurrenceIndex);
  const occurrence = performanceSet.occurrenceAt(boundedIndex);
  const total = performanceSet.length;
  const position = boundedIndex < 0 ? 0 : boundedIndex + 1;
  const stageThemeClass = theme === "dark" ? "locked-live-theme-dark" : "locked-live-theme-bright";

  const move = (direction: NavigationDirection): void => {
    setOccurrenceIndex((current) => {
      const next = direction === "previous" ? performanceSet.previousIndex(current) : performanceSet.nextIndex(current);
      return next === current ? current : next;
    });
  };

  useEffect(() => {
    resetScroll(stageRef.current);
    resetScroll(viewportRef.current);
    setRuntimeWarning(null);
    headingRef.current?.focus();
  }, [performanceSet, occurrence?.id]);

  useEffect(() => {
    const stage = stageRef.current;
    const viewport = viewportRef.current;
    const sourceElement = sourceRef.current;
    const columns = columnsRef.current;
    if (stage === null || viewport === null || sourceElement === null || columns === null || occurrence === null) return;
    const source = sourceElement.content;

    const generation = fitGeneration.current + 1;
    fitGeneration.current = generation;
    let cancelled = false;
    let timer: number | undefined;
    const target: RuntimeFitTarget = { source, viewport, columns };

    const fit = async (): Promise<void> => {
      try {
        const result = await fitLiveLeadSheet(target);
        // A song change/unmount can leave a previous fitter promise pending.
        // Its detached keyed subtree is harmless, but never apply its result to
        // the current presentation.
        if (cancelled || fitGeneration.current !== generation) return;
        columns.dataset.fitStatus = result.status;
        columns.dataset.formFactor = result.formFactor;
        columns.dataset.bodyPx = String(result.bodyPx);
        columns.dataset.lineHeight = String(result.lineHeight);
        columns.dataset.columnCount = String(result.columnCount);
        stage.dataset.formFactor = result.formFactor;
        setRuntimeWarning(result.status === "needs-editing" ? "Runtime fit warning: this viewport needs scrolling at the readability floor." : null);
        prepareClonedApexPresentation(columns, occurrence.label);
      } catch {
        if (!cancelled && fitGeneration.current === generation) {
          renderReadableFallback(source, columns, occurrence.label);
          stage.dataset.formFactor = "phone";
          setRuntimeWarning("Runtime fit unavailable: showing a readable one-column verified Apex fallback.");
        }
      }
    };
    const scheduleFit = (): void => {
      if (cancelled) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        void fit();
      }, 100);
    };

    void fit();
    window.addEventListener("resize", scheduleFit);
    window.addEventListener("orientationchange", scheduleFit);
    window.visualViewport?.addEventListener("resize", scheduleFit);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleFit);
    resizeObserver?.observe(viewport);

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("resize", scheduleFit);
      window.removeEventListener("orientationchange", scheduleFit);
      window.visualViewport?.removeEventListener("resize", scheduleFit);
      resizeObserver?.disconnect();
    };
  }, [performanceSet, occurrence?.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const direction = navigationKey(event);
      if (direction === null) return;
      const focusedInteractive = isFocusedInteractiveControl(event.target) || isFocusedInteractiveControl(document.activeElement);
      const focusedPresentation = isFocusedScrollablePresentation(event.target) || isFocusedScrollablePresentation(document.activeElement);
      const pageScrollKey = event.key === "PageUp" || event.key === "PageDown" || event.key === " " || event.key === "Spacebar" || event.code === "Space";
      if (focusedPresentation && pageScrollKey) return;
      if (focusedInteractive && (event.key === " " || event.key === "Spacebar" || event.code === "Space")) return;
      event.preventDefault();
      move(direction);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [performanceSet]);

  const handlePresentationClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target instanceof Element ? event.target.closest("a") : null;
    if (target !== null) event.preventDefault();
  };

  const handlePresentationKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const target = event.target instanceof Element ? event.target.closest("a") : null;
    if (target !== null && (event.key === "Enter" || event.key === " ")) event.preventDefault();
  };

  if (occurrence === null) {
    return <main ref={stageRef} className={`locked-live-stage ${stageThemeClass}`} data-live-locked="true" data-stage-theme={theme} aria-label="Locked Live mode">
      <div className="locked-live-panel locked-live-empty"><a className="locked-live-exit" href={exitHref}>Exit Live</a><h1 className="locked-live-title">Empty Set List</h1></div>
    </main>;
  }

  const song = occurrence.song;
  const apexHtml = occurrence.apexHtml;
  const warning = occurrence.landscapeWarning;
  const displayTitle = occurrence.label;
  const progressText = `Live progress: ${position}/${total} — occurrence ${position} of ${total} — ${displayTitle}`;

  return <main ref={stageRef} className={`locked-live-stage ${stageThemeClass}`} data-live-locked="true" data-stage-theme={theme} aria-label="Locked Live mode">
    <div className="locked-live-panel locked-live-summary">
      <div className="locked-live-summary-copy">
        <p className="locked-live-eyebrow">Locked Live</p>
        <h1 className="locked-live-title">{performanceSet.title}</h1>
      </div>
      <nav aria-label="Live controls" className="locked-live-controls">
        <a className="locked-live-exit" href={exitHref}>Exit Live</a>
        <button className="locked-live-theme-toggle" type="button" aria-pressed={theme === "dark"} aria-label={theme === "dark" ? "Bright" : "Stage Dark"} onClick={() => setTheme((current) => current === "bright" ? "dark" : "bright")}>{theme === "dark" ? "Bright" : "Stage Dark"}</button>
      </nav>
    </div>

    <section aria-labelledby="live-occurrence-title" data-occurrence-id={occurrence.entryId} data-occurrence-ordinal={String(occurrence.ordinal)} className="locked-live-panel locked-live-occurrence">
      <div className="locked-live-occurrence-context">
        <p className="locked-live-section">{entrySection(occurrence)}</p>
        <p className="locked-live-progress" role="status" aria-live="polite" aria-atomic="true">{progressText}</p>
      </div>
      <h2 ref={headingRef} id="live-occurrence-title" className="locked-live-song-title" tabIndex={-1} data-page-heading>{displayTitle}</h2>
      <dl className="locked-live-metadata">
        <div className="locked-live-metadata-item"><dt className="locked-live-metadata-label">Key</dt><dd className="locked-live-metadata-value">{metadataValue(song.performanceKey)}</dd></div>
        <div className="locked-live-metadata-item"><dt className="locked-live-metadata-label">BPM</dt><dd className="locked-live-metadata-value">{metadataValue(song.bpm)}</dd></div>
        <div className="locked-live-metadata-item"><dt className="locked-live-metadata-label">Singer</dt><dd className="locked-live-metadata-value">{metadataValue(occurrence.singer)}</dd></div>
        <div className="locked-live-metadata-item"><dt className="locked-live-metadata-label">Note</dt><dd className="locked-live-metadata-value">{metadataValue(occurrence.note)}</dd></div>
      </dl>
      {warning && <p role="note" data-frozen-landscape-warning="true" className="locked-live-warning">Frozen warning: iPad landscape fit needs editing; Live may scroll at the 16px floor.</p>}
      {runtimeWarning && <p role="status" aria-live="polite" className="locked-live-warning locked-live-runtime-warning">{runtimeWarning}</p>}
    </section>

    <section ref={viewportRef} key={occurrence.id} data-sheet-viewport aria-label={`${displayTitle} fitted presentation`} className="locked-live-sheet-viewport">
      <template ref={sourceRef} data-apex-source data-authority="apex" aria-hidden="true" className="locked-live-apex-source" dangerouslySetInnerHTML={{ __html: apexHtml }} />
      <div ref={columnsRef} data-live-columns data-authority="apex-presentation" className="locked-live-columns" onClick={handlePresentationClick} onAuxClick={handlePresentationClick} onKeyDown={handlePresentationKeyDown} />
    </section>

    <nav aria-label="Occurrence navigation" className="locked-live-navigation">
      <button className="locked-live-nav-button" type="button" onClick={() => move("previous")} disabled={position <= 1} aria-label="Previous">Previous</button>
      <button className="locked-live-nav-button" type="button" onClick={() => move("next")} disabled={position >= total} aria-label="Next">Next</button>
    </nav>
  </main>;
}
