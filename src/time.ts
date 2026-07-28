import { DateTime } from "luxon";

export function expiryFromDate(date: string, timezone: string): string | null {
  const parsed = DateTime.fromFormat(date, "yyyy-MM-dd", { zone: timezone }).endOf("day");
  return parsed.isValid ? parsed.toUTC().toISO() : null;
}

export function hiddenAtFromExpiry(expiresAt: string): string {
  return DateTime.fromISO(expiresAt, { zone: "utc" }).plus({ days: 10 }).toUTC().toISO()!;
}

export function formatDate(iso: string, timezone: string): string {
  return DateTime.fromISO(iso, { zone: "utc" }).setZone(timezone).toFormat("dd.MM.yyyy");
}

export function dateAfterDays(days: number, timezone: string, now = DateTime.now()): string {
  return now.setZone(timezone).plus({ days }).toFormat("yyyy-MM-dd");
}

export function dateAfterMonths(months: number, timezone: string, now = DateTime.now()): string {
  return now.setZone(timezone).plus({ months }).toFormat("yyyy-MM-dd");
}

export function dateAfterYears(years: number, timezone: string, now = DateTime.now()): string {
  return now.setZone(timezone).plus({ years }).toFormat("yyyy-MM-dd");
}

export function daysUntilExpiry(expiresAt: string, timezone: string, now = DateTime.now()): number {
  const today = now.setZone(timezone).startOf("day");
  const expiryDay = DateTime.fromISO(expiresAt, { zone: "utc" }).setZone(timezone).startOf("day");
  return Math.round(expiryDay.diff(today, "days").days);
}

export function isExpired(expiresAt: string, now = DateTime.now()): boolean {
  return DateTime.fromISO(expiresAt, { zone: "utc" }) < now.toUTC();
}

export function isRevocationDue(expiresAt: string, now = DateTime.now()): boolean {
  return DateTime.fromISO(expiresAt, { zone: "utc" }).plus({ hours: 24 }) <= now.toUTC();
}
