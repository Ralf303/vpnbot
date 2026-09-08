export const MASS_EXTENSION_PERIODS = {
  "7d": { label: "7 дней", duration: { days: 7 } },
  "1m": { label: "1 месяц", duration: { months: 1 } },
  "3m": { label: "3 месяца", duration: { months: 3 } },
  "6m": { label: "6 месяцев", duration: { months: 6 } },
  "1y": { label: "1 год", duration: { years: 1 } },
} as const;

export function parseExtensionDays(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const days = Number(text.trim());
  return Number.isSafeInteger(days) && days >= 1 && days <= 3650 ? days : null;
}

export function massExtensionPeriod(code: string) {
  if (Object.hasOwn(MASS_EXTENSION_PERIODS, code)) {
    return MASS_EXTENSION_PERIODS[code as keyof typeof MASS_EXTENSION_PERIODS];
  }
  const days = code.endsWith("d") ? parseExtensionDays(code.slice(0, -1)) : null;
  return days === null ? null : { label: `${days} дн.`, duration: { days } };
}
