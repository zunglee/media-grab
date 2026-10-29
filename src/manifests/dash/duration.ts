/**
 * xs:duration values as they appear in MPD attributes (mediaPresentationDuration, Period@start,
 * Period@duration): "PT1H2M3.5S", "P1DT2H", and the long form some packagers write,
 * "P0Y0M0DT0H3M30.000S".
 *
 * Years and months are accepted only when they are zero. A non-zero year or month is not a fixed
 * number of seconds - a month is 28 to 31 days, a year 365 or 366 (XML Schema Part 2, 3.2.6) -
 * so converting one would be a guess, and real manifests never use them.
 */
const PATTERN =
  /^(-)?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_MINUTE = 60;

export function parseIsoDuration(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const match = PATTERN.exec(input.trim());
  if (!match) return undefined;

  const [, sign, years, months, days, hours, minutes, seconds] = match;
  const parts = [years, months, days, hours, minutes, seconds];
  if (parts.every((part) => part === undefined)) return undefined; // a bare "P" or "PT"
  if (num(years) !== 0 || num(months) !== 0) return undefined;

  const total =
    num(days) * SECONDS_PER_DAY +
    num(hours) * SECONDS_PER_HOUR +
    num(minutes) * SECONDS_PER_MINUTE +
    num(seconds);
  if (!Number.isFinite(total)) return undefined;
  return sign === '-' ? -total : total;
}

function num(value: string | undefined): number {
  return value === undefined ? 0 : Number(value);
}

/** MPD frameRate is "30" or "30000/1001". */
export function parseFrameRate(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (trimmed.includes('/')) {
    const [numerator, denominator] = trimmed.split('/');
    const a = Number(numerator);
    const b = Number(denominator);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return undefined;
    return a / b;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
