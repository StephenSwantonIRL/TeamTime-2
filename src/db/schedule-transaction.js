import { Long } from 'mongodb';

export const GUARD_ID = 'schedule';

export function withScheduleTransaction(client, db, update) {
  return client.withSession((session) => session.withTransaction(async () => {
    const lock = await db.collection('bookingGuard').updateOne(
      { _id: GUARD_ID }, { $inc: { version: Long.ONE } }, { session },
    );
    if (lock.matchedCount !== 1) throw new Error('Schedule guard is missing.');
    return update(session);
  }, {
    readPreference: 'primary',
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
  }));
}
