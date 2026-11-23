import { addDays } from '../domain/booking-calendar.js';
import { getBookingDay } from '../domain/booking-day.js';
import { makeReservation, replayReservation, toSlotRecord } from '../domain/reservation.js';

function sampleWindows(from, until) {
  const windows = [];
  for (let date = from; date < until; date = addDays(date, 1)) {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (!weekday || weekday === 6) continue;

    const day = getBookingDay(date);
    const hour = 3_600_000;
    // The lunch boundary has the same Dublin offset as these working hours.
    const startMs = day.lunchStartMs - (weekday === 2 ? 3 : 4) * hour;
    const endMs = day.lunchEndMs + (weekday === 5 ? 2 : 3) * hour;
    windows.push({ startMs, endMs, status: 'active' });
  }
  return windows;
}

export function createDemoStore({ clock = Date.now } = {}) {
  const reservations = new Map();

  function snapshot(from, until) {
    return {
      windows: sampleWindows(from, until),
      bookings: [...reservations.values()]
        .filter(({ date }) => date >= from && date < until)
        .map(toSlotRecord),
    };
  }

  return {
    async ping() {},
    async getSnapshot(from, until) { return snapshot(from, until); },
    async getReservation(reference) { return reservations.get(reference); },
    async reserve(command) {
      // This section executes synchronously in the single-process demo.
      const existing = reservations.get(command.reference);
      if (existing) return replayReservation(existing, command);
      const reservation = makeReservation(command, snapshot(command.date, addDays(command.date, 1)), clock(), true);
      reservations.set(reservation._id, reservation);
      return { reservation, created: true };
    },
  };
}
