const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

export function isIsoDate(value: string): boolean {
  return DATE_PATTERN.test(value);
}

function offsetMsAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
    hour: "numeric",
  }).formatToParts(instant);
  const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) {
    return 0;
  }
  const sign = match[1] === "+" ? 1 : -1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  return sign * (hours * 60 + minutes) * 60_000;
}

export function zonedDateTime(date: string, time: string, timeZone: string): Date | undefined {
  const dateMatch = date.match(DATE_PATTERN);
  const timeMatch = time.match(TIME_PATTERN);
  if (!dateMatch || !timeMatch) {
    return undefined;
  }
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59
  ) {
    return undefined;
  }
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const first = new Date(utcGuess - offsetMsAt(new Date(utcGuess), timeZone));
  return new Date(utcGuess - offsetMsAt(first, timeZone));
}

export function weekdayInTimeZone(date: string, timeZone: string): string | undefined {
  const noon = zonedDateTime(date, "12:00", timeZone);
  if (!noon) {
    return undefined;
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(noon);
}
