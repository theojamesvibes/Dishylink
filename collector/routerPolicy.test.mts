import { describe, expect, it } from "vitest";
import { routerPollingDisabled } from "./routerPolicy.mts";

describe("routerPollingDisabled", () => {
  it("is off unless the variable says so", () => {
    expect(routerPollingDisabled({})).toBe(false);
    expect(routerPollingDisabled({ HISTORIAN_ROUTER_DISABLED: "" })).toBe(false);
    expect(routerPollingDisabled({ HISTORIAN_ROUTER_DISABLED: "0" })).toBe(false);
    expect(routerPollingDisabled({ HISTORIAN_ROUTER_DISABLED: "false" })).toBe(false);
    expect(routerPollingDisabled({ HISTORIAN_ROUTER_DISABLED: "no" })).toBe(false);
  });

  it("accepts the usual spellings of on", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
      expect(routerPollingDisabled({ HISTORIAN_ROUTER_DISABLED: value })).toBe(true);
    }
  });
});
