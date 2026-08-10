import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
afterEach(cleanup);
Object.defineProperty(globalThis, "TextEncoder", { configurable: true, value: TextEncoder });
Object.defineProperty(globalThis, "TextDecoder", { configurable: true, value: TextDecoder });
Object.defineProperty(window, "scrollTo", { configurable: true, value: () => undefined });
Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => null });
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: () => ({ matches: false, media: "", onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }),
});
