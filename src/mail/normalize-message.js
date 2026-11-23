import { simpleParser } from 'mailparser';
import { parseCalendar } from './calendar-parser.js';
import { splitMessage } from './message.js';

export function createMessageNormalizer({ organizer, eventKeySecret, authenticate }) {
  return async ({ rawMime }) => {
    const envelope = splitMessage(rawMime);
    if (!envelope) return null;

    let change;
    try {
      const parsed = await simpleParser(rawMime, {
        ignoreEmbedded: true, maxHeadSize: 24 * 1024, maxChildNodes: 32,
        skipHtmlToText: true, skipTextToHtml: true, keepCidLinks: true, checksumAlgo: false,
      });
      const from = parsed.from?.value;
      if (from?.length !== 1 || from[0].address?.toLowerCase() !== organizer) return null;

      const calendars = parsed.attachments.filter(({ contentType, filename }) =>
        ['text/calendar', 'application/ics', 'application/icalendar'].includes(contentType) ||
        (contentType === 'application/octet-stream' && /\.ics$/i.test(filename ?? ''))
      );
      if (!calendars.length || calendars.length > 4) return null;
      const changes = calendars.map(({ content }) => parseCalendar(content, {
        organizer, eventKeySecret, subject: parsed.subject,
      }));
      [change] = changes;
      if (changes.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(change))) return null;
    } catch {
      return null;
    }

    return await authenticate(envelope) ? change : null;
  };
}
