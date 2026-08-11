import { describe, expect, it } from "vitest";
import { controllerChangeDisposition, deferredControllerDisposition, waitingWorkerActivationDisposition } from "./service-worker";

describe("service-worker update hardening", () => {
  it("never immediately activates a waiting replacement worker", () => {
    expect(waitingWorkerActivationDisposition()).toBe("defer-until-clients-close");
  });

  it("defers first-controller reload throughout locked Live and reloads after exit", () => {
    expect(controllerChangeDisposition(true)).toBe("defer");
    expect(controllerChangeDisposition(false)).toBe("reload");
    expect(deferredControllerDisposition(true, true)).toBe("wait");
    expect(deferredControllerDisposition(true, false)).toBe("reload");
    expect(deferredControllerDisposition(false, false)).toBe("none");
  });
});
