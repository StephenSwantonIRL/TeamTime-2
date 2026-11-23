import { getBookingDay, getDublinDate } from './booking-day.js';
import { ACTIVE_BOOKING_STATUSES, findAvailableSlots } from './scheduling.js';

const BOOKING_HORIZON_DAYS = 28;

export function addDays(date, count) {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + count);
  return day.toISOString().slice(0, 10);
}

export function getBookingPeriod(nowMs) {
  const from = getDublinDate(nowMs);
  return { from, until: addDays(from, BOOKING_HORIZON_DAYS) };
}

export function getScheduleBounds(from, until) {
  return { startMs: getBookingDay(from).startMs, endMs: getBookingDay(until).startMs };
}

export function describeDate(date, snapshot, nowMs) {
  const { windows, bookings } = snapshot;
  const hasBookableWindow = findAvailableSlots({ date, windows, bookings: [], nowMs }).length > 0;
  if (!hasBookableWindow) return { date, state: 'closed', slots: [] };

  const dayBookings = bookings.filter((booking) => booking.date === date);
  const slots = findAvailableSlots({ date, windows, bookings: dayBookings, nowMs });
  const atCapacity = dayBookings.filter((booking) => ACTIVE_BOOKING_STATUSES.includes(booking.status)).length >= 2;
  const state = slots.length ? 'available' : atCapacity ? 'full' : 'unavailable';
  return { date, state, slots };
}
