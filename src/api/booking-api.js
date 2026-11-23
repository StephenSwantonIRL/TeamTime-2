import { createHash } from 'node:crypto';
import express from 'express';
import { addDays, describeDate, getBookingPeriod } from '../domain/booking-calendar.js';
import { BOOKING_TIME_ZONE, getBookingDay, getDublinDate } from '../domain/booking-day.js';
import { BookingError, ownsReservation, unresolvedInvitation } from '../domain/reservation.js';

const referencePattern = /^[a-f0-9]{32}$/;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const STALE_INVITATION_MS = 120_000;
const errors = {
  invalid_request: [400, 'Check the date, time and contact details.'],
  invalid_date: [400, 'Choose a date within the booking period.'],
  slot_unavailable: [409, 'That time is no longer available. Please choose another.'],
  reference_conflict: [409, 'This booking reference is tied to another time.'],
  not_found: [404, 'Booking not found.'],
};

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
}

function tokenDigest(req, reference) {
  if (typeof reference !== 'string' || !referencePattern.test(reference)) return;
  const token = /^Bearer ([a-f0-9]{64})$/i.exec(req.get('Authorization') ?? '')?.[1];
  if (!token) return;
  const derivedReference = createHash('sha256').update(token, 'hex').digest('hex').slice(0, 32);
  // Invalid reference/token pairs have the same outcome whether or not the reference exists.
  if (derivedReference !== reference) return;
  return createHash('sha256').update('teamtime:booking-status:').update(token, 'hex').digest('hex');
}

function utcStart(value) {
  if (typeof value !== 'string' || !instantPattern.test(value)) return NaN;
  const ms = Date.parse(value);
  const normalized = value.length === 20 ? value.replace('Z', '.000Z') : value;
  return Number.isFinite(ms) && new Date(ms).toISOString() === normalized ? ms : NaN;
}

function parseBooking(req) {
  const body = req.body;
  req.body = undefined;
  const { reference, startUtc, name, email } = body ?? {};
  const tokenHash = tokenDigest(req, reference);
  const startMs = utcStart(startUtc);
  const validName = typeof name === 'string' && name.trim().length > 0 && name.length <= 120 && !/[\p{Cc}]/u.test(name);
  const validEmail = typeof email === 'string' && email.length <= 254 && /^[^\s@<>]+@[^\s@<>.]+(?:\.[^\s@<>.]+)+$/.test(email.trim());

  if (!tokenHash || !Number.isFinite(startMs) || !validName || !validEmail) throw new BookingError('invalid_request');
  return {
    command: { reference, tokenHash, date: getDublinDate(startMs), startMs },
    contact: { email: email.trim() },
  };
}

function publicBooking(reservation) {
  return {
    reference: reservation._id,
    startUtc: reservation.startUtc,
    endUtc: reservation.endUtc,
    date: reservation.date,
    status: reservation.status,
    notificationStatus: reservation.notificationStatus,
  };
}

export function bookingApi({ store, demo, clock, invitationService, bookingLimit }) {
  const router = express.Router();
  const json = express.json({ limit: '4kb', inflate: false });

  router.get('/health', asyncRoute(async (_req, res) => {
    try {
      await store.ping();
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  }));

  router.get('/availability/dates', asyncRoute(async (_req, res) => {
    const nowMs = clock();
    const { from, until } = getBookingPeriod(nowMs);
    const snapshot = await store.getSnapshot(from, until);
    const dates = [];
    for (let date = from; date < until; date = addDays(date, 1)) {
      const { state } = describeDate(date, snapshot, nowMs);
      if (state !== 'closed') dates.push({ date, state });
    }
    res.json({ dates, from, until, timezone: BOOKING_TIME_ZONE, demo, invitationsEnabled: Boolean(invitationService) });
  }));

  router.get('/availability/slots', asyncRoute(async (req, res) => {
    const nowMs = clock();
    const { date } = req.query;
    const { from, until } = getBookingPeriod(nowMs);
    try { getBookingDay(date); } catch { throw new BookingError('invalid_date'); }
    if (date < from || date >= until) throw new BookingError('invalid_date');

    const snapshot = await store.getSnapshot(date, addDays(date, 1));
    const { state, slots } = describeDate(date, snapshot, nowMs);
    res.json({ date, state, timezone: BOOKING_TIME_ZONE, slots: slots.map(({ startMs, endMs }) => ({
      startUtc: new Date(startMs), endUtc: new Date(endMs),
    })) });
  }));

  router.post('/bookings', bookingLimit, json, asyncRoute(async (req, res) => {
    const { command, contact } = parseBooking(req);
    const { from, until } = getBookingPeriod(clock());
    // Replays can still recover an earlier reservation after the display horizon advances.
    if (command.date < from || command.date >= until) {
      const existing = await store.getReservation(command.reference);
      if (!ownsReservation(existing, command.tokenHash)) throw new BookingError('slot_unavailable');
      if (existing.startUtc.getTime() !== command.startMs) throw new BookingError('reference_conflict');
      return res.json(publicBooking(existing));
    }
    let { reservation, created } = await store.reserve(command);
    if (created && invitationService) {
      const outcome = await invitationService.send(reservation, contact);
      reservation = await store.recordInvitationOutcome(command.reference, outcome);
    }
    res.status(created ? 201 : 200).json(publicBooking(reservation));
  }));

  router.get('/bookings/:reference/status', asyncRoute(async (req, res) => {
    const { reference } = req.params;
    const tokenHash = tokenDigest(req, reference);
    if (!tokenHash) throw new BookingError('not_found');
    let reservation = await store.getReservation(reference);
    if (!ownsReservation(reservation, tokenHash)) throw new BookingError('not_found');
    if (unresolvedInvitation(reservation)) {
      const requestedAt = reservation.invitationRequestedAt ?? reservation.createdAt;
      const stale = reservation.status === 'pending' && clock() - requestedAt.getTime() >= STALE_INVITATION_MS;
      if (stale || (reservation.status === 'requires_reconciliation' && invitationService?.lookup)) {
        const outcome = await invitationService?.lookup?.(reference) ?? 'unknown';
        reservation = await store.recordInvitationOutcome(reference, outcome);
      }
    }
    res.json(publicBooking(reservation));
  }));

  return router;
}

export function publicError(error, req, res, next) {
  req.body = undefined;
  if (res.headersSent) return next(error);
  if (error instanceof BookingError) {
    const [status, message] = errors[error.code];
    return res.status(status).json({ code: error.code, message });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ code: 'too_large', message: 'The booking request is too large.' });
  }
  if (error.status >= 400 && error.status < 500) {
    return res.status(error.status).json({ code: 'invalid_request', message: 'The request could not be read.' });
  }
  console.error('TeamTime request failed.');
  res.status(500).json({ code: 'service_error', message: 'TeamTime could not complete the request.' });
}
