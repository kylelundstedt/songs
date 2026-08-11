import { describe, expect, it } from "vitest";
import { createLatestTaskRunner } from "./latest";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("createLatestTaskRunner", () => {
  it("serializes DOM-mutating work and runs the newest pending request last", async () => {
    const first = deferred();
    const second = deferred();
    const gates = [first, second];
    let concurrent = 0;
    let maximumConcurrent = 0;
    const latestAtCompletion: boolean[] = [];
    let calls = 0;
    const runner = createLatestTaskRunner(async (isLatest) => {
      const gate = gates[calls++]!;
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      await gate.promise;
      latestAtCompletion.push(isLatest());
      concurrent -= 1;
    });

    runner.request();
    await Promise.resolve();
    runner.request();
    runner.request();
    expect(calls).toBe(1);
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
    second.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(maximumConcurrent).toBe(1);
    expect(calls).toBe(2);
    expect(latestAtCompletion).toEqual([false, true]);
    runner.dispose();
  });
});
