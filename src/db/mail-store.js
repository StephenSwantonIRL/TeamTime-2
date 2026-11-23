import { Long } from 'mongodb';
import { ACTIVE_BOOKING_STATUSES } from '../domain/scheduling.js';
import { calendarDecision } from '../mail/calendar-version.js';
import { withScheduleTransaction } from './schedule-transaction.js';

function overlap(window) {
  return { startUtc: { $lt: window.endUtc }, endUtc: { $gt: window.startUtc } };
}

export function createMailStore(client, db, { clock = Date.now } = {}) {
  const syncState = db.collection('syncState');
  const availability = db.collection('availability');
  const bookings = db.collection('bookings');

  async function updateConflicts(windows, now, session) {
    const ranges = windows.filter((window) => window?.status === 'active').map(overlap);
    if (ranges.length === 0) return 0;

    const affected = bookings.find({ status: { $in: ACTIVE_BOOKING_STATUSES }, $or: ranges }, {
      session, projection: { startUtc: 1, endUtc: 1, availabilityConflictAt: 1 },
    });
    let flagged = 0;
    for await (const booking of affected) {
      const coveringWindow = await availability.findOne({
        status: 'active', startUtc: { $lte: booking.startUtc }, endUtc: { $gte: booking.endUtc },
      }, { session, projection: { _id: 1 } });
      if (coveringWindow && booking.availabilityConflictAt) {
        await bookings.updateOne({ _id: booking._id }, {
          $unset: { availabilityConflictAt: '' }, $set: { updatedAt: now },
        }, { session });
      } else if (!coveringWindow && !booking.availabilityConflictAt) {
        await bookings.updateOne({ _id: booking._id }, {
          $set: { availabilityConflictAt: now, updatedAt: now },
        }, { session });
        flagged++;
      }
    }
    return flagged;
  }

  async function applyChange(change, now, session) {
    const key = { eventKey: change.eventKey };
    const existing = await availability.findOne(key, { session });
    const decision = calendarDecision(existing, change);
    if (decision !== 'apply') return { decision, windows: [] };

    const next = {
      status: change.method === 'REQUEST' ? 'active' : 'cancelled',
      sequence: change.sequence,
      revisionUtc: new Date(change.revisionMs),
      updatedAt: now,
    };
    const update = { $set: next, $setOnInsert: { createdAt: now } };
    if (next.status === 'active') {
      next.startUtc = new Date(change.startMs);
      next.endUtc = new Date(change.endMs);
      if (change.sourceTimeZone) next.sourceTimeZone = change.sourceTimeZone;
      else update.$unset = { sourceTimeZone: '' };
    }
    await availability.updateOne(key, update, { upsert: true, session });
    return { decision, windows: [existing, next] };
  }

  return {
    async getState(provider) {
      const key = { _id: provider };
      try {
        await syncState.updateOne(key, { $setOnInsert: { revision: Long.ZERO } }, { upsert: true });
      } catch (error) {
        if (error.code !== 11000) throw error;
      }
      return syncState.findOne(key);
    },
    async recordFailure(provider, revision, code) {
      await syncState.updateOne({ _id: provider, revision }, {
        $set: { lastError: { code, at: new Date(clock()) } },
      });
    },
    commitPage(provider, revision, { cursor, changes, historyGap, rejected }) {
      return withScheduleTransaction(client, db, async (session) => {
        const key = { _id: provider, revision };
        if (!await syncState.findOne(key, { session, projection: { _id: 1 } })) return null;

        const now = new Date(clock());
        const affectedWindows = [];
        let divergentVersions = false;
        for (const change of changes) {
          const result = await applyChange(change, now, session);
          affectedWindows.push(...result.windows);
          divergentVersions ||= result.decision === 'version_conflict';
        }
        const flagged = await updateConflicts(affectedWindows, now, session);

        const checkpoint = { cursor, lastSuccessAt: now };
        if (historyGap) checkpoint.historyGapAt = now;
        if (rejected) checkpoint.lastRejectedAt = now;
        if (divergentVersions) checkpoint.lastVersionConflictAt = now;
        await syncState.updateOne(key, {
          $set: checkpoint, $unset: { lastError: '' }, $inc: { revision: Long.ONE },
        }, { session });
        return { flagged, divergentVersions };
      });
    },
  };
}
