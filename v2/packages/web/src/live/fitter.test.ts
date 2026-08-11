import { afterEach, describe, expect, it } from "vitest";
import {
  bestBalancedSplit,
  cloneApexPresentationNode,
  detectFormFactor,
  expandFlowNodes,
  fitLiveLeadSheet,
  forcedColumnSplit,
  observeLiveLeadSheets,
  sectionizeApex,
  type FormFactorViewport,
  type RuntimeFitTarget,
} from "./fitter";

function fitTarget(markup: string): { readonly panel: HTMLElement; readonly target: RuntimeFitTarget } {
  const panel = document.createElement("article");
  panel.innerHTML = `<div data-sheet-viewport><div data-apex-source>${markup}</div><div data-live-columns></div></div>`;
  const source = panel.querySelector<HTMLElement>("[data-apex-source]");
  const viewport = panel.querySelector<HTMLElement>("[data-sheet-viewport]");
  const columns = panel.querySelector<HTMLElement>("[data-live-columns]");
  if (source === null || viewport === null || columns === null) throw new Error("test fixture is incomplete");
  document.body.append(panel);
  return { panel, target: { source, viewport, columns } };
}

function rect(height: number): DOMRect {
  return { x: 0, y: 0, width: 0, height, top: 0, right: 0, bottom: height, left: 0, toJSON: () => ({}) } as DOMRect;
}

function installGeometry(
  target: RuntimeFitTarget,
  measuredHeight: (element: HTMLElement, host: HTMLElement) => number,
  dimensions: { readonly viewportWidth?: number; readonly viewportHeight?: number; readonly columnWidth?: number; readonly columnScrollWidth?: number; readonly columnHeight?: number; readonly columnScrollHeight?: number; readonly containerWidth?: number; readonly containerScrollWidth?: number } = {},
): () => void {
  const viewportWidth = dimensions.viewportWidth ?? 500;
  const viewportHeight = dimensions.viewportHeight ?? 100;
  const columnWidth = dimensions.columnWidth ?? 238;
  const columnScrollWidth = dimensions.columnScrollWidth ?? columnWidth;
  const columnHeight = dimensions.columnHeight ?? viewportHeight;
  const columnScrollHeight = dimensions.columnScrollHeight ?? columnHeight;
  const containerWidth = dimensions.containerWidth ?? viewportWidth;
  const containerScrollWidth = dimensions.containerScrollWidth ?? containerWidth;
  const prototype = HTMLElement.prototype;
  const originalRect = Object.getOwnPropertyDescriptor(prototype, "getBoundingClientRect");
  const originalClientWidth = Object.getOwnPropertyDescriptor(prototype, "clientWidth");
  const originalClientHeight = Object.getOwnPropertyDescriptor(prototype, "clientHeight");
  const originalScrollWidth = Object.getOwnPropertyDescriptor(prototype, "scrollWidth");
  const originalScrollHeight = Object.getOwnPropertyDescriptor(prototype, "scrollHeight");

  Object.defineProperty(prototype, "getBoundingClientRect", {
    configurable: true,
    value: function getBoundingClientRect(this: HTMLElement): DOMRect {
      const host = this.parentElement;
      return host?.classList.contains("measure-host") ? rect(measuredHeight(this, host)) : rect(0);
    },
  });
  Object.defineProperties(prototype, {
    clientWidth: {
      configurable: true,
      get(this: HTMLElement): number {
        if (this === target.viewport) return viewportWidth;
        if (this === target.columns) return containerWidth;
        return this.classList.contains("live-column") ? columnWidth : 0;
      },
    },
    clientHeight: {
      configurable: true,
      get(this: HTMLElement): number {
        if (this === target.viewport) return viewportHeight;
        return this.classList.contains("live-column") ? columnHeight : 0;
      },
    },
    scrollWidth: {
      configurable: true,
      get(this: HTMLElement): number {
        if (this === target.columns) return containerScrollWidth;
        return this.classList.contains("live-column") ? columnScrollWidth : 0;
      },
    },
    scrollHeight: {
      configurable: true,
      get(this: HTMLElement): number {
        return this.classList.contains("live-column") ? columnScrollHeight : 0;
      },
    },
  });

  return () => {
    for (const [name, descriptor] of [["getBoundingClientRect", originalRect], ["clientWidth", originalClientWidth], ["clientHeight", originalClientHeight], ["scrollWidth", originalScrollWidth], ["scrollHeight", originalScrollHeight]] as const) {
      if (descriptor === undefined) delete (prototype as unknown as Record<string, unknown>)[name];
      else Object.defineProperty(prototype, name, descriptor);
    }
  };
}

const restoreGeometry: (() => void)[] = [];
afterEach(() => {
  while (restoreGeometry.length > 0) restoreGeometry.pop()?.();
  document.body.replaceChildren();
});

describe("detectFormFactor", () => {
  it("preserves the v1 phone, iPadOS, touch-tablet, and width rules", () => {
    const view = (userAgent: string, platform: string, touchPoints: number, width: number): FormFactorViewport => ({
      innerWidth: width,
      navigator: { userAgent, platform, maxTouchPoints: touchPoints } as Navigator,
      visualViewport: { width } as VisualViewport,
    });
    expect(detectFormFactor(view("Mozilla iPhone", "iPhone", 0, 1024))).toBe("phone");
    expect(detectFormFactor(view("Mozilla", "MacIntel", 5, 600))).toBe("tablet");
    expect(detectFormFactor(view("Mozilla", "Linux", 2, 768))).toBe("tablet");
    expect(detectFormFactor(view("Mozilla", "Linux", 0, 767))).toBe("phone");
  });
});

describe("Apex section preparation", () => {
  it("makes resource-bearing and executable Apex markup inert before attachment", () => {
    const source = document.createElement("section");
    source.innerHTML = '<a href="/song/elsewhere" onclick="alert(1)">Guide</a><img src="/track.gif"><script>bad()</script><style>@import "/more.css"</style><svg><animate href="/pulse" /></svg><ol style="list-style-type: upper-alpha"><li>One</li></ol>';
    const clone = cloneApexPresentationNode(source) as HTMLElement;

    expect(clone.querySelector("script, style, img, svg, animate")).toBeNull();
    expect(clone.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(clone.querySelector("a")?.hasAttribute("onclick")).toBe(false);
    expect(clone.querySelector("a")).toHaveAttribute("aria-disabled", "true");
    expect(clone.querySelector("ol")).toHaveClass("apex-upper-alpha");
    expect(clone.querySelector("ol")?.hasAttribute("style")).toBe(false);
  });

  it("excludes H1, recognizes only exact column-break comments, groups H2/H3, and badges measures", () => {
    const source = document.createElement("div");
    source.innerHTML = "<h1>Display title</h1><h2>Chorus 4 x + 2</h2><p>Words</p><!-- column-break --><h3>Bridge 12 X</h3><p>More words</p><!-- column break -->";
    const original = source.innerHTML;
    const sections = sectionizeApex(source);

    expect(source.innerHTML).toBe(original);
    expect(sections).toHaveLength(3);
    expect(sections[0]?.textContent).toContain("Chorus 4x+2Words");
    expect((sections[0] as HTMLElement).querySelector(".measure-count")?.textContent).toBe("4x+2");
    expect(sections.filter((section) => section instanceof HTMLSpanElement)).toHaveLength(1);
    expect(forcedColumnSplit(sections)).toBe(1);
    expect((sections[2] as HTMLElement).querySelector(".measure-count")?.textContent).toBe("12x");
    expect(bestBalancedSplit([40, 60, 40])).toBe(1); // exact v1 earlier-split tie handling
  });

  it("splits a paragraph only at ten or more BRs, after each eighth BR", () => {
    const source = document.createElement("div");
    source.innerHTML = `<p>${Array.from({ length: 11 }, (_, index) => `line ${index}${index < 10 ? "<br>" : ""}`).join("")}</p>`;
    const expanded = expandFlowNodes(source);

    expect(expanded).toHaveLength(2);
    expect(expanded.map((node) => node.querySelectorAll("br").length)).toEqual([8, 2]);
  });
});

describe("fitLiveLeadSheet", () => {
  it("fits an inert template source using the connected presentation document fonts", async () => {
    const panel = document.createElement("article");
    panel.innerHTML = '<div data-sheet-viewport><template data-apex-source><h1>Title</h1><h3>Verse 8x</h3><p>One</p></template><div data-live-columns></div></div>';
    const template = panel.querySelector<HTMLTemplateElement>("template[data-apex-source]")!;
    const viewport = panel.querySelector<HTMLElement>("[data-sheet-viewport]")!;
    const columns = panel.querySelector<HTMLElement>("[data-live-columns]")!;
    document.body.append(panel);
    const target: RuntimeFitTarget = { source: template.content, viewport, columns };
    restoreGeometry.push(installGeometry(target, () => 20));

    await expect(fitLiveLeadSheet(target, { formFactor: "tablet" })).resolves.toMatchObject({ status: "fit", columnCount: 2 });
    expect(columns.querySelectorAll(".live-column")).toHaveLength(2);
  });

  it("searches the exact tablet candidate order, balances columns, and leaves the Apex/panel untouched", async () => {
    const { panel, target } = fitTarget("<h1>Title</h1><p>One</p><p>Two</p><p>Three</p>");
    restoreGeometry.push(installGeometry(target, (_element, host) => Number(host.style.getPropertyValue("--sheet-line")) === 1.24 ? 51 : 50));
    const source = target.source as HTMLElement;
    const originalSource = source.innerHTML;

    const result = await fitLiveLeadSheet(target, { formFactor: "tablet" });

    expect(result).toEqual({ formFactor: "tablet", status: "fit", columnCount: 2, bodyPx: 21, lineHeight: 1.2, split: 1 });
    expect(target.columns.style.getPropertyValue("--sheet-font")).toBe("21px");
    expect(target.columns.style.getPropertyValue("--sheet-line")).toBe("1.2");
    expect(target.columns.querySelectorAll(".live-column")).toHaveLength(2);
    expect(target.columns.children[0]?.children).toHaveLength(1);
    expect(target.columns.children[1]?.children).toHaveLength(2);
    expect(source.innerHTML).toBe(originalSource);
    expect(panel.getAttribute("style")).toBeNull();
  });

  it("accepts exactly one vertical overflow pixel and uses a 20px one-column phone result", async () => {
    const { target } = fitTarget("<p>One</p><p>Two</p><!-- column-break -->");
    restoreGeometry.push(installGeometry(target, (element) => element.hidden ? 0 : 101));

    const tablet = await fitLiveLeadSheet(target, { formFactor: "tablet" });
    expect(tablet.status).toBe("fit");
    expect(tablet.bodyPx).toBe(21);
    expect(tablet.lineHeight).toBe(1.24);

    const phone = await fitLiveLeadSheet(target, { formFactor: "phone" });
    expect(phone).toEqual({ formFactor: "phone", status: "scrollable", columnCount: 1, bodyPx: 20, lineHeight: 1.24, split: null });
    expect(target.columns.querySelectorAll(".live-column")).toHaveLength(1);
    expect(target.columns.querySelectorAll(".live-column > span")).toHaveLength(0);
  });

  it("rejects a measured candidate when the rendered columns still overflow vertically", async () => {
    const { target } = fitTarget("<p>One</p><p>Two</p>");
    restoreGeometry.push(installGeometry(target, () => 20, { viewportHeight: 100, columnHeight: 100, columnScrollHeight: 103 }));

    await expect(fitLiveLeadSheet(target, { formFactor: "tablet" })).resolves.toMatchObject({
      status: "needs-editing",
      bodyPx: 16,
      lineHeight: 1.12,
      columnCount: 2,
    });
  });

  it("reports phone horizontal overflow beyond the one-pixel tolerance", async () => {
    const { target } = fitTarget("<p>Wide line</p>");
    restoreGeometry.push(installGeometry(target, () => 1, { columnScrollWidth: 240, columnWidth: 238 }));

    await expect(fitLiveLeadSheet(target, { formFactor: "phone" })).resolves.toMatchObject({ status: "needs-editing", columnCount: 1 });
  });
});

describe("observeLiveLeadSheets", () => {
  it("refits on visual-viewport changes, redetects form factor, and fully cleans up", async () => {
    const { target } = fitTarget("<p>One</p><p>Two</p>");
    restoreGeometry.push(installGeometry(target, () => 10));
    let width = 900;
    const visualViewport = new EventTarget() as EventTarget & Pick<VisualViewport, "width" | "addEventListener" | "removeEventListener">;
    Object.defineProperty(visualViewport, "width", { configurable: true, get: () => width });
    const view = new EventTarget() as FormFactorViewport & EventTarget & { readonly setTimeout: typeof setTimeout; readonly clearTimeout: typeof clearTimeout };
    Object.defineProperties(view, {
      innerWidth: { configurable: true, get: () => width },
      navigator: { configurable: true, value: { userAgent: "Mozilla", platform: "Linux", maxTouchPoints: 0 } },
      visualViewport: { configurable: true, value: visualViewport },
      setTimeout: { configurable: true, value: setTimeout },
      clearTimeout: { configurable: true, value: clearTimeout },
    });
    const observer = observeLiveLeadSheets([target], { view, debounceMs: 0 });

    await observer.refit();
    expect(target.columns.querySelectorAll(".live-column")).toHaveLength(2);

    width = 390;
    visualViewport.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(target.columns.querySelectorAll(".live-column")).toHaveLength(1);

    observer.disconnect();
    width = 900;
    view.dispatchEvent(new Event("orientationchange"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(target.columns.querySelectorAll(".live-column")).toHaveLength(1);
  });
});
