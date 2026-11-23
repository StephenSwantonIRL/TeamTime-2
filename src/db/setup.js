import { isDeepStrictEqual } from 'node:util';
import { Long } from 'mongodb';
import { GUARD_ID } from './schedule-transaction.js';

const date = { bsonType: 'date' };
const timeFields = { startUtc: date, endUtc: date, createdAt: date, updatedAt: date };

const validators = {
  availability: {
    required: ['_id', 'eventKey', 'status', 'sequence', 'revisionUtc', 'createdAt', 'updatedAt'],
    properties: {
      _id: { bsonType: 'objectId' }, eventKey: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
      ...timeFields, sequence: { bsonType: 'int', minimum: 0 }, revisionUtc: date,
      sourceTimeZone: { bsonType: 'string', maxLength: 128 }, status: { enum: ['active', 'cancelled'] },
    },
    oneOf: [
      { required: ['startUtc', 'endUtc'], properties: { status: { enum: ['active'] } } },
      { properties: { status: { enum: ['cancelled'] } } },
    ],
  },
  bookings: {
    required: ['_id', 'statusTokenHash', 'date', 'startUtc', 'endUtc', 'status', 'notificationStatus', 'createdAt', 'updatedAt'],
    properties: {
      _id: { bsonType: 'string', pattern: '^[0-9a-f]{32}$' },
      statusTokenHash: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
      date: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, ...timeFields,
      status: { enum: ['pending', 'confirmed', 'failed', 'requires_reconciliation'] },
      notificationStatus: { enum: ['pending', 'created', 'rejected', 'unknown'] },
      availabilityConflictAt: date,
    },
  },
  bookingGuard: {
    required: ['_id', 'version'],
    properties: { _id: { enum: ['schedule'] }, version: { bsonType: 'long' } },
  },
  syncState: {
    required: ['_id', 'revision'],
    properties: {
      _id: { enum: ['gmail', 'imap', 'mock'] }, revision: { bsonType: 'long' },
      cursor: { bsonType: 'string', maxLength: 4096 }, lastSuccessAt: date,
      historyGapAt: date, lastRejectedAt: date, lastVersionConflictAt: date,
      lastError: {
        bsonType: 'object', additionalProperties: false, required: ['code', 'at'],
        properties: { code: { enum: ['connection', 'cursor_expired', 'read_failed', 'import_failed'] }, at: date },
      },
    },
  },
};

export async function initializeDatabase(db) {
  for (const [name, schema] of Object.entries(validators)) {
    const validator = { $jsonSchema: { bsonType: 'object', additionalProperties: false, ...schema } };
    const options = { validator, validationLevel: 'strict', validationAction: 'error' };
    // Atlas accepts a collection-name match here on tiers that reject an $in filter.
    let collection = await db.listCollections({ name }).next();
    if (!collection) {
      try {
        await db.createCollection(name, options);
        continue;
      } catch (error) {
        // Another instance may have created the collection during startup.
        if (error.code !== 48) throw error;
        collection = await db.listCollections({ name }).next();
        if (!collection) throw error;
      }
    }
    const current = collection.options;
    if (name === 'bookings' && isDeepStrictEqual(current?.validator?.$jsonSchema?.properties?.invitationRequestedAt, date)) {
      // Preserve the optional field on databases initialized by the earlier invitation code.
      validator.$jsonSchema.properties = { ...schema.properties, invitationRequestedAt: date };
    }
    if (!isDeepStrictEqual(current?.validator, validator) ||
        (current?.validationLevel ?? 'strict') !== 'strict' ||
        (current?.validationAction ?? 'error') !== 'error') {
      await db.command({ collMod: name, ...options });
    }
  }

  await db.collection('availability').createIndexes([
    { key: { eventKey: 1 }, unique: true },
    { key: { status: 1, endUtc: 1, startUtc: 1 } },
  ]);
  await db.collection('bookings').createIndexes([
    { key: { date: 1, status: 1 } },
    { key: { status: 1, endUtc: 1, startUtc: 1 } },
    { key: { status: 1, updatedAt: 1 } },
    { key: { availabilityConflictAt: 1 }, partialFilterExpression: { availabilityConflictAt: { $exists: true } } },
  ]);
  const guard = db.collection('bookingGuard');
  const key = { _id: GUARD_ID };
  try {
    await guard.updateOne(key, { $setOnInsert: { version: Long.ZERO } }, { upsert: true });
  } catch (error) {
    if (error.code !== 11000 || !await guard.findOne(key)) throw error;
  }
}
