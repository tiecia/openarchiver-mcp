/** Normalize only real RFC3339 instants with a known, explicit UTC offset.
 * Date.parse alone repairs impossible days and accepts timezone-free values.
 */
export function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offset] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return undefined;
  if (Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) return undefined;
  // RFC3339 -00:00 means an unknown local offset, not a known UTC instant.
  if (offset === "-00:00" || (offset.length > 1 && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59))) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
