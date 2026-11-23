import { timingSafeEqual } from 'node:crypto';
import { findAvailableSlots } from './scheduling.js';

export class BookingError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function ownsReservation(reservation, tokenHash) {
  const storedHash = reservation?.statusTokenHash ?? '0'.repeat(64);
  const matches = timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(tokenHash, 'hex'));
  return Boolean(reservation && matches);
}

export function replayReservation(reservation, { tokenHash, startMs }) {
  if (!ownsReservation(reservation, tokenHash)) throw new BookingError('not_found');
  if (reservation.startUtc.getTime() !== startMs) throw new BookingError('reference_conflict');
  return { reservation, created: false };
}

export function toSlotRecord({ startUtc, endUtc, status, date }) {
  return { startMs: startUtc.getTime(), endMs: endUtc.getTime(), status, date };
}

export function unresolvedInvitation(reservation) {
  if (!reservation || !['pending', 'requires_reconciliation'].includes(reservation.status)) return false;
  return reservation.notificationStatus === 'unknown' || Boolean(reservation.invitationRequestedAt);
}

export function makeReservation({ reference, tokenHash, date, startMs }, snapshot, nowMs, demo) {
  const slot = findAvailableSlots({ date, ...snapshot, nowMs })
    .find((candidate) => candidate.startMs === startMs);
  if (!slot) throw new BookingError('slot_unavailable');

  // Keep persistence independent of the booking request body.
  return {
    _id: reference,
    statusTokenHash: tokenHash,
    date,
    startUtc: new Date(slot.startMs),
    endUtc: new Date(slot.endMs),
    status: demo ? 'confirmed' : 'pending',
    notificationStatus: demo ? 'simulated' : 'pending',
    createdAt: new Date(nowMs),
    updatedAt: new Date(nowMs),
  };
}
