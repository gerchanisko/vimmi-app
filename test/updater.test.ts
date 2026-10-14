import { describe, expect, it } from "vitest";
import { compareVersions } from "../electron/updater";

describe("compareVersions", () => {
  it("orders versions numerically", () => {
    expect(compareVersions("0.2.2", "0.2.1")).toBe(1);
    expect(compareVersions("v0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.2.1", "0.2.1")).toBe(0);
    expect(compareVersions("0.2", "0.2.1")).toBe(-1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
  });
});
