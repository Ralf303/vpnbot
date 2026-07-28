import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { daysUntilExpiry, expiryFromDate, hiddenAtFromExpiry, isRevocationDue } from "../src/time.js";

describe("правила срока действия", () => {
  it("считает выбранную дату до конца дня по Москве", () => {
    expect(expiryFromDate("2026-07-28", "Europe/Moscow"))
      .toBe("2026-07-28T20:59:59.999Z");
  });

  it("оставляет запись видимой десять дней", () => {
    expect(hiddenAtFromExpiry("2026-07-28T20:59:59.999Z"))
      .toBe("2026-08-07T20:59:59.999Z");
  });

  it("напоминает за три, два и один календарный день", () => {
    const now = DateTime.fromISO("2026-07-25T12:00:00+03:00");
    expect(daysUntilExpiry("2026-07-28T20:59:59.999Z", "Europe/Moscow", now)).toBe(3);
  });

  it("назначает отзыв через 24 часа после окончания", () => {
    const expiry = "2026-07-28T20:59:59.999Z";
    expect(isRevocationDue(expiry, DateTime.fromISO("2026-07-29T20:59:59.998Z"))).toBe(false);
    expect(isRevocationDue(expiry, DateTime.fromISO("2026-07-29T20:59:59.999Z"))).toBe(true);
  });
});
