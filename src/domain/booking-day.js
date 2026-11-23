export const BOOKING_TIME_ZONE = 'Europe/Dublin';

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: BOOKING_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const offsetFormatter = new Intl.DateTimeFormat('en', {
  timeZone: BOOKING_TIME_ZONE,
  timeZoneName: 'longOffset',
});

export function getDublinDate(instantMs) {
  const parts = Object.fromEntries(dateFormatter.formatToParts(instantMs)
    .map(({ type, value }) => [type, value]));
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
}

function offsetAt(instantMs) {
  const offset = offsetFormatter.formatToParts(instantMs)
    .find(({ type }) => type === 'timeZoneName').value;

  if (offset === 'GMT') return 0;
  const [, sign, hours, minutes] = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset);
  const magnitude = (Number(hours) * 60 + Number(minutes)) * 60_000;
  return sign === '-' ? -magnitude : magnitude;
}

function wallTimeToUtc(date, time) {
  const wallMs = Date.parse(`${date}T${time}:00Z`);
  const utcMs = wallMs - offsetAt(wallMs);
  // The offset at noon on a transition day may differ from the one at midnight.
  return wallMs - offsetAt(utcMs);
}

export function getBookingDay(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < '1970-01-01') {
    throw new RangeError('Expected a Dublin booking date in YYYY-MM-DD format, from 1970 onwards.');
  }

  const midnight = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) {
    throw new RangeError('Invalid Dublin booking date.');
  }

  const tomorrow = new Date(midnight);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const nextDate = tomorrow.toISOString().split('T')[0];

  return {
    startMs: wallTimeToUtc(date, '00:00'),
    endMs: wallTimeToUtc(nextDate, '00:00'),
    lunchStartMs: wallTimeToUtc(date, '13:00'),
    lunchEndMs: wallTimeToUtc(date, '14:00'),
  };
}
