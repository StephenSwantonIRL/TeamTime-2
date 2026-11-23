import { databaseConfig } from '../config.js';
import { connectMongo } from '../db/mongo-store.js';
import { ACTIVE_BOOKING_STATUSES } from '../domain/scheduling.js';

let client;
try {
  const { uri, databaseName } = databaseConfig();
  const connection = await connectMongo(uri, databaseName);
  client = connection.client;
  const sync = await connection.db.collection('syncState').find({}, {
    projection: { lastSuccessAt: 1, lastError: 1, historyGapAt: 1, lastRejectedAt: 1, lastVersionConflictAt: 1 },
  }).toArray();
  const conflicts = await connection.db.collection('bookings').find({
    availabilityConflictAt: { $exists: true }, status: { $in: ACTIVE_BOOKING_STATUSES },
  }, { projection: { startUtc: 1, endUtc: 1, status: 1, availabilityConflictAt: 1 } })
    .sort({ startUtc: 1 }).limit(100).toArray();
  console.log(JSON.stringify({ sync, conflicts }, null, 2));
} catch {
  console.error('Mailbox status unavailable. Check the MongoDB settings and permissions.');
  process.exitCode = 1;
} finally {
  await client?.close();
}
