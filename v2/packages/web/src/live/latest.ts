export interface LatestTaskRunner {
  readonly request: () => void;
  readonly dispose: () => void;
}

/**
 * Serialize an asynchronous DOM-mutating task while coalescing requests.
 *
 * The task may mutate shared presentation state before it resolves, so merely
 * discarding an old returned value is insufficient. This runner guarantees that
 * no newer task starts until the older task has finished, then immediately runs
 * the newest pending request.
 */
export function createLatestTaskRunner(task: (isLatest: () => boolean) => Promise<void>): LatestTaskRunner {
  let latestRequest = 0;
  let completedRequest = 0;
  let running = false;
  let disposed = false;

  const drain = async (): Promise<void> => {
    if (running || disposed) return;
    running = true;
    try {
      while (!disposed && completedRequest < latestRequest) {
        const request = latestRequest;
        await task(() => !disposed && request === latestRequest);
        completedRequest = request;
      }
    } finally {
      running = false;
      if (!disposed && completedRequest < latestRequest) void drain();
    }
  };

  return {
    request: () => {
      if (disposed) return;
      latestRequest += 1;
      void drain();
    },
    dispose: () => { disposed = true; },
  };
}
