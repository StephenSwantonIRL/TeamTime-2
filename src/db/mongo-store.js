import { MongoClient } from 'mongodb';
import { addDays, getScheduleBounds } from '../domain/booking-calendar.js';
import { makeReservation, replayReservation, toSlotRecord, unresolvedInvitation } from '../domain/reservation.js';
import { ACTIVE_BOOKING_STATUSES } from '../domain/scheduling.js';
import { withScheduleTransaction } from './schedule-transaction.js';

export async function connectMongo(uri, databaseName) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  try {
    await client.connect();
    const db = client.db(databaseName);
    const topology = await db.command({ hello: 1 });
    if (!topology.setName) throw new Error('A MongoDB replica set is required.');
    return { client, db };
  } catch (error) {
    await client.close();
    throw error;
  }
}

export function createMongoStore(client, db, { clock = Date.now, sendInvitations = false } = {}) {
  const availability = db.collection('availability');
  const bookings = db.collection('bookings');

  async function getSnapshot(from, until, session) {
    const { startMs, endMs } = getScheduleBounds(from, until);
    const options = { session, projection: { _id: 0, date: 1, startUtc: 1, endUtc: 1, status: 1 } };
    const windows = await availability.find({
      status: 'active', startUtc: { $lt: new Date(endMs) }, endUtc: { $gt: new Date(startMs) },
    }, options).toArray();
    const reservations = await bookings.find({
      date: { $gte: from, $lt: until }, status: { $in: ACTIVE_BOOKING_STATUSES },
    }, options).toArray();
    return { windows: windows.map(toSlotRecord), bookings: reservations.map(toSlotRecord) };
  }

  return {
    async ping() {
      await db.command({ ping: 1 });
    },
    getSnapshot,
    getReservation(reference) {
      return bookings.findOne({ _id: reference });
    },
    reserve(command) {
      return withScheduleTransaction(client, db, async (session) => {
        const existing = await bookings.findOne({ _id: command.reference }, { session });
        if (existing) return replayReservation(existing, command);

        const snapshot = await getSnapshot(command.date, addDays(command.date, 1), session);
        const reservation = makeReservation(command, snapshot, clock(), false);
        // A pending reservation with an unknown notification has been claimed for dispatch.
        if (sendInvitations) reservation.notificationStatus = 'unknown';
        await bookings.insertOne(reservation, { session });
        return { reservation, created: true };
      });
    },
    recordInvitationOutcome(reference, outcome) {
      return withScheduleTransaction(client, db, async (session) => {
        const key = { _id: reference };
        const current = await bookings.findOne(key, { session });
        if (!unresolvedInvitation(current)) return current;

        const status = { created: 'confirmed', rejected: 'failed', unknown: 'requires_reconciliation' }[outcome];
        if (current.status === status) return current;
        const changes = { status, notificationStatus: outcome, updatedAt: new Date(clock()) };
        await bookings.updateOne(key, {
          $set: changes,
          ...(outcome === 'rejected' ? { $unset: { availabilityConflictAt: '' } } : {}),
        }, { session });
        return { ...current, ...changes };
      });
    },
  };
}
