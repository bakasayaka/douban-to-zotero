export const NORMALIZED_PUBLICATION_DATE_PATTERN =
  /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

function padTwoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function isLeapYear(year: number): boolean {
  return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if ([4, 6, 9, 11].includes(month)) return 30;
  return 31;
}

function isValidYear(year: number): boolean {
  return Number.isInteger(year) && year >= 1 && year <= 9999;
}

function formatDateParts(
  yearText: string,
  monthText?: string,
  dayText?: string,
): string {
  const year = Number(yearText);
  if (!isValidYear(year)) return "";

  if (!monthText) return yearText;

  const month = Number(monthText);
  if (!Number.isInteger(month) || month < 1 || month > 12) return "";

  if (!dayText) return `${yearText}-${padTwoDigits(month)}`;

  const day = Number(dayText);
  if (
    !Number.isInteger(day) ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    return "";
  }

  return `${yearText}-${padTwoDigits(month)}-${padTwoDigits(day)}`;
}

export function isNormalizedPublicationDate(value: string | undefined): boolean {
  const text = value?.trim() ?? "";
  if (!NORMALIZED_PUBLICATION_DATE_PATTERN.test(text)) return false;

  const [yearText, monthText, dayText] = text.split("-");
  return formatDateParts(yearText, monthText, dayText) === text;
}

export function normalizePublicationDate(raw: string): string {
  const text = raw.trim();
  if (!text) return "";

  const match = text.match(
    /(\d{4})(?:\s*(?:年|[-./])\s*(\d{1,2})(?:\s*(?:月|[-./])\s*(\d{1,2})\s*(?:日|号)?)?)?/,
  );
  if (!match) return "";

  return formatDateParts(match[1], match[2], match[3]);
}
