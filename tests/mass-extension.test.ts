import { describe, expect, it } from "vitest";
import { massExtensionPeriod, parseExtensionDays } from "../src/mass-extension.js";

describe("custom mass extension", () => {
  it("accepts whole days and preserves calendar month/year presets", () => {
    expect(parseExtensionDays(" 15 ")).toBe(15);
    expect(massExtensionPeriod("15d")?.duration).toEqual({ days: 15 });
    expect(massExtensionPeriod("1m")?.duration).toEqual({ months: 1 });
    expect(massExtensionPeriod("1y")?.duration).toEqual({ years: 1 });
  });
  it.each(["0", "-1", "1.5", "1e3", "", "10 дней", "3651", "99999999999999999999"])("rejects %s", value => {
    expect(parseExtensionDays(value)).toBeNull();
    expect(massExtensionPeriod(`${value}d`)).toBeNull();
  });
});
