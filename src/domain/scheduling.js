import { getBookingDay } from './booking-day.js';

const MINUTE_MS = 60_000;
const DURATION_MS = 60 * MINUTE_MS;
const GRANULARITY_MS = 15 * MINUTE_MS;
const BUFFER_MS = 15 * MINUTE_MS;
export const ACTIVE_BOOKING_STATUSES = Object.freeze(['pending', 'confirmed', 'requires_reconciliation']);

/**
 * Return eligible slots in chronological order using UTC epoch milliseconds.
 * Windows and bookings can include other dates. Pass nowMs to exclude starts
 * at or before the request time. An availability window must cover a slot on its own.
 */
export function findAvailableSlots({ date, windows, bookings, nowMs = -Infinity }) {
  const day = getBookingDay(date);
  const activeBookings = bookings.filter((booking) =>
    ACTIVE_BOOKING_STATUSES.includes(booking.status) &&
    booking.startMs >= day.startMs && booking.startMs < day.endMs
  );
  if (activeBookings.length >= 2) return [];

  const activeWindows = windows.filter((window) =>
    window.status === 'active' && window.startMs < day.endMs && window.endMs > day.startMs
  );
  if (activeWindows.length === 0) return [];

  const [firstBooking] = activeBookings;
  const slots = [];

  // Dublin's clock changes since 1970 preserve the local quarter-hour grid.
  for (let startMs = day.startMs; startMs + DURATION_MS <= day.endMs; startMs += GRANULARITY_MS) {
    const endMs = startMs + DURATION_MS;
    if (startMs <= nowMs) continue;
    if (startMs < day.lunchEndMs && endMs > day.lunchStartMs) continue;
    if (firstBooking &&
        endMs + BUFFER_MS !== firstBooking.startMs &&
        startMs !== firstBooking.endMs + BUFFER_MS) continue;
    if (activeWindows.some((window) => window.startMs <= startMs && window.endMs >= endMs)) {
      slots.push({ startMs, endMs });
    }
  }

  return slots;
}
