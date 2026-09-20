import { describe, expect, it } from "vitest";
import type { ISdk as IiiSdk, ApiRequest as IiiApiRequest } from "iii-sdk";
import { TriggerAction as IiiTriggerAction } from "iii-sdk";
import type { InprocSdk } from "../src/engine/inproc/sdk.js";
import { TriggerAction } from "../src/engine/types.js";
import type { ApiRequest, ISdk } from "../src/engine/types.js";

// The expand step of ADR 0001: this fork's own engine-facing types must be
// interchangeable with the external ones while both exist, so that call sites
// can migrate a batch at a time without the suite going red in between.
describe("local engine types", () => {
  it("accepts the external SDK where the local one is expected", () => {
    const check = (sdk: IiiSdk): ISdk => sdk;
    expect(check).toBeTypeOf("function");
  });

  it("accepts the in-process engine's own SDK where the local type is expected", () => {
    const check = (sdk: InprocSdk): ISdk => sdk;
    expect(check).toBeTypeOf("function");
  });

  it("accepts the external request shape where the local one is expected", () => {
    const check = (req: IiiApiRequest): ApiRequest => req;
    expect(check).toBeTypeOf("function");
  });

  it("builds the same void action the external factory builds", () => {
    expect(TriggerAction.Void()).toEqual(IiiTriggerAction.Void());
  });

  it("builds the same enqueue action the external factory builds", () => {
    expect(TriggerAction.Enqueue({ queue: "jobs" })).toEqual(
      IiiTriggerAction.Enqueue({ queue: "jobs" }),
    );
  });
});
