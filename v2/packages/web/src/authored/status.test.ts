import { describe, expect, it } from "vitest";
import { authoredReadiness } from "./status";

const base = { documentId: "set-example", kind: "set-list" as const, baseServerRevisionId: "", sync: undefined, acknowledgedCursor: 0, cursor: 0, outbox: [], conflicts: [] };

describe("authoredReadiness", () => {
  it("gives conflicts precedence over publication", () => {
    expect(authoredReadiness({ ...base, baseServerRevisionId: "rev-111111111111111111111111", sync: { documentId: "set-example", currentServerRevisionId: "rev-111111111111111111111111", publishedRevisionId: "rev-111111111111111111111111" }, conflicts: [{ id: "conf-111111111111111111111111", schemaVersion: "songs-v2-authored-conflict-1", documentId: "set-example", currentRevisionId: "rev-111111111111111111111111", candidateRevisionId: "rev-222222222222222222222222", resolutionRevisionId: "", status: "open", updatedAt: "2026-08-14T00:00:00.000Z" }] }).code).toBe("conflicted");
  });
  it("distinguishes local, queued, accepted, acknowledged, and published", () => {
    expect(authoredReadiness(base).code).toBe("local");
    expect(authoredReadiness({ ...base, outbox: [{ documentId: "set-example", state: "pending" } as never] }).code).toBe("queued");
    expect(authoredReadiness({ ...base, baseServerRevisionId: "rev-111111111111111111111111", cursor: 2, acknowledgedCursor: 1 }).code).toBe("server-accepted");
    expect(authoredReadiness({ ...base, baseServerRevisionId: "rev-111111111111111111111111", cursor: 2, acknowledgedCursor: 2 }).code).toBe("acknowledged");
    expect(authoredReadiness({ ...base, baseServerRevisionId: "rev-111111111111111111111111", sync: { documentId: "set-example", currentServerRevisionId: "rev-111111111111111111111111", publishedRevisionId: "rev-111111111111111111111111" } }).code).toBe("published");
  });
});
