import { addDays } from '../../domain/booking-calendar.js';
import { getDublinDate } from '../../domain/booking-day.js';

export const MOCK_ORGANIZER = 'owner@example.test';

export function exampleInvitations(nowMs = Date.now()) {
  const date = getDublinDate(nowMs);
  const messages = [];
  for (let offset = 1; offset <= 7; offset++) {
    const day = addDays(date, offset);
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const compact = day.replaceAll('-', '');
    messages.push(Buffer.from([
      `From: TeamTime Demo <${MOCK_ORGANIZER}>`, 'Subject: [TEAMTIME] Demo availability', 'MIME-Version: 1.0',
      'Content-Type: text/calendar; charset=UTF-8; method=REQUEST', '',
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TeamTime//Demo//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT',
      `UID:teamtime-demo-${day}`, 'SEQUENCE:0', `DTSTAMP:${compact}T000000Z`,
      `ORGANIZER:mailto:${MOCK_ORGANIZER}`, 'SUMMARY:[TEAMTIME] Demo availability',
      `DTSTART;TZID=Europe/Dublin:${compact}T090000`, `DTEND;TZID=Europe/Dublin:${compact}T170000`,
      'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n')));
  }
  return { messages, generation: date };
}

export function createMockProvider(messages, { generation = 'fixture', batchSize = 6 } = {}) {
  return {
    async readChanges(cursor) {
      const [previousGeneration, lastOffset] = (cursor ?? '').split(':');
      const offset = previousGeneration === generation ? Number(lastOffset) : 0;
      const next = Math.min(offset + batchSize, messages.length);
      return {
        messages: messages.slice(offset, next).map((rawMime) => ({ rawMime })),
        cursor: `${generation}:${next}`,
        hasMore: next < messages.length,
      };
    },
    async testConnection() {},
    async close() {},
  };
}
