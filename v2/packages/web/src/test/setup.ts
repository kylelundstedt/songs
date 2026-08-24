import "@testing-library/jest-dom/vitest";
import { Buffer } from "node:buffer";
import { webcrypto } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

function nodeBuffer(data: BufferSource): Buffer {
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  return Buffer.from(Array.from(bytes));
}

const compatibleCrypto = {
  getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
  randomUUID: webcrypto.randomUUID.bind(webcrypto),
  subtle: Object.create(webcrypto.subtle, {
    digest: {
      configurable: true,
      value: (algorithm: AlgorithmIdentifier, data: BufferSource) => webcrypto.subtle.digest(algorithm, nodeBuffer(data)),
    },
  }),
} as Crypto;
Object.defineProperty(globalThis, "crypto", { configurable: true, value: compatibleCrypto });
afterEach(cleanup);
Object.defineProperty(globalThis, "TextEncoder", { configurable: true, value: TextEncoder });
Object.defineProperty(globalThis, "TextDecoder", { configurable: true, value: TextDecoder });
Object.defineProperty(window, "scrollTo", { configurable: true, value: () => undefined });
Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => null });
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: () => ({ matches: false, media: "", onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }),
});
