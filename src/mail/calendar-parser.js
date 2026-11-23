import { createHmac } from 'node:crypto';
import ICAL from 'ical.js';

const MAX_CALENDAR_BYTES = 64 * 1024;
const MAX_WINDOW_MS = 366 * 86_400_000;
const wallPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function one(component, name, required = true) {
  const properties = component.getAllProperties(name);
  if (properties.length > 1 || (required && properties.length === 0)) throw new Error('Invalid calendar property.');
  return properties[0];
}

function wallTime(value) {
  if (!wallPattern.test(value) || value < '1970' || value >= '2101') throw new Error('Invalid date-time.');
  const ms = Date.parse(`${value}Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== `${value}.000Z`) throw new Error('Invalid date-time.');
  return ms;
}

function nativeWall(tzid) {
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: tzid, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  return {
    name: format.resolvedOptions().timeZone,
    at(ms) {
      const p = Object.fromEntries(format.formatToParts(ms).map(({ type, value }) => [type, value]));
      return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
    },
  };
}

function embeddedOffsets(zone) {
  const transitions = zone.getAllSubcomponents();
  if (transitions.length === 0 || transitions.length > 4) throw new Error('Unsupported time zone.');
  const offsets = new Set();
  for (const transition of transitions) {
    if (!['standard', 'daylight'].includes(transition.name)) throw new Error('Unsupported time zone.');
    const start = one(transition, 'dtstart').jCal[3];
    if (!wallPattern.test(start) || start < '1600' || start >= '2101') throw new Error('Unsupported time-zone start.');
    const rule = one(transition, 'rrule', false)?.jCal[3];
    if (rule && (rule.freq !== 'YEARLY' || !Number.isInteger(rule.interval ?? 1) || (rule.interval ?? 1) < 1 ||
        (rule.count ?? 1) < 1 || (rule.count ?? 1) > 500 ||
        Object.keys(rule).some((part) => !['freq', 'interval', 'byday', 'bymonth', 'bymonthday', 'count', 'until'].includes(part)) ||
        Object.values(rule).some((part) => Array.isArray(part) && part.length > 12))) throw new Error('Unsupported time-zone rule.');
    if (transition.getAllProperties('rdate').reduce((count, p) => count + p.jCal.length - 3, 0) > 32) {
      throw new Error('Unsupported time-zone dates.');
    }
    for (const property of ['tzoffsetfrom', 'tzoffsetto']) {
      const value = one(transition, property).getFirstValue().toSeconds();
      if (!Number.isFinite(value) || Math.abs(value) >= 86_400) throw new Error('Invalid time-zone offset.');
      offsets.add(value * 1_000);
    }
  }
  return offsets;
}

function eventInstant(property, root) {
  const value = property.jCal[3];
  const tzid = property.getParameter('tzid');
  if (property.type !== 'date-time' || typeof value !== 'string') throw new Error('Expected a date-time.');
  if (value.endsWith('Z') && !tzid) return { ms: wallTime(value.slice(0, -1)), zone: 'UTC' };
  if (typeof tzid !== 'string' || !/^[a-z0-9_./ +()-]{1,128}$/i.test(tzid)) throw new Error('Unresolved time zone.');
  const wallMs = wallTime(value);

  const custom = root.getAllSubcomponents('vtimezone').filter((zone) => one(zone, 'tzid').getFirstValue() === tzid);
  if (custom.length > 1) throw new Error('Ambiguous time zone.');
  const nativeId = tzid === 'GMT Standard Time' ? 'Europe/Dublin' : tzid;
  let native;
  try { native = nativeWall(nativeId); } catch { /* An embedded Outlook time zone may use a Windows identifier. */ }

  let matches;
  if (custom.length) {
    const offsets = embeddedOffsets(custom[0]);
    const zone = new ICAL.Timezone({ component: custom[0], tzid });
    matches = [...offsets].map((offset) => wallMs - offset).filter((instant) =>
      ICAL.Time.fromJSDate(new Date(instant), true).convertToZone(zone).toString() === value
    );
  } else {
    if (!native) throw new Error('Unresolved time zone.');
    const samples = [-36, -24, -12, 0, 12, 24, 36].map((hour) => wallMs + hour * 3_600_000);
    const offsets = new Set(samples.map((instant) => Date.parse(`${native.at(instant)}Z`) - instant));
    matches = [...offsets].map((offset) => wallMs - offset).filter((instant) => native.at(instant) === value);
  }
  if (matches.length !== 1) throw new Error('Ambiguous or nonexistent local time.');
  return { ms: matches[0], zone: native?.name };
}

function qualifiedSubject(value, method) {
  if (typeof value !== 'string') return false;
  const subject = method === 'CANCEL' ? value.replace(/^Cancel(?:l)?ed:[ \t]*/i, '') : value;
  return subject.startsWith('[TEAMTIME]');
}

function boundedCalendar(content) {
  if (!Buffer.isBuffer(content) || content.length > MAX_CALENDAR_BYTES) throw new Error('Oversized calendar.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  if (lines.length > 1_000) throw new Error('Oversized calendar.');
  const nesting = [];
  for (const line of lines) {
    if (nesting.at(-1) === 'VEVENT' && /^SEQUENCE[;:]/i.test(line) &&
        !/^SEQUENCE(?:;[^:]*)?:\+?\d{1,10}$/i.test(line)) throw new Error('Invalid calendar sequence.');
    const match = /^(BEGIN|END):([A-Z0-9-]+)$/i.exec(line);
    if (!match) continue;
    if (match[1].toUpperCase() === 'BEGIN') nesting.push(match[2].toUpperCase());
    else if (nesting.pop() !== match[2].toUpperCase()) throw new Error('Invalid calendar structure.');
    if (nesting.length > 3) throw new Error('Invalid calendar nesting.');
  }
  if (nesting.length) throw new Error('Unclosed calendar component.');
  return new ICAL.Component(ICAL.parse(text));
}

export function parseCalendar(content, { organizer, eventKeySecret, subject }) {
  const calendar = boundedCalendar(content);
  if (calendar.name !== 'vcalendar' || one(calendar, 'version').getFirstValue() !== '2.0') {
    throw new Error('Unsupported calendar version.');
  }
  const method = one(calendar, 'method').getFirstValue()?.toUpperCase();
  const events = calendar.getAllSubcomponents('vevent');
  if (events.length !== 1 || !['REQUEST', 'CANCEL'].includes(method) ||
      calendar.getAllSubcomponents('vtimezone').length > 4) throw new Error('Unsupported calendar instruction.');

  const [event] = events;
  if (['recurrence-id', 'rrule', 'rdate', 'exrule', 'exdate'].some((name) => event.hasProperty(name))) {
    throw new Error('Recurring availability is unsupported.');
  }
  const summary = one(event, 'summary', false)?.getFirstValue();
  const organizerValue = one(event, 'organizer').getFirstValue();
  const uid = one(event, 'uid').getFirstValue();
  if (!qualifiedSubject(summary ?? (method === 'CANCEL' ? subject : undefined), method) ||
      typeof organizerValue !== 'string' || organizerValue.toLowerCase() !== `mailto:${organizer}` ||
      typeof uid !== 'string' || uid.length > 512 || !/^[\x21-\x7e]+$/.test(uid)) throw new Error('Unqualified calendar instruction.');

  const sequenceProperty = one(event, 'sequence', false);
  const sequence = sequenceProperty ? Number(sequenceProperty.jCal[3]) : 0;
  const stamp = one(event, 'dtstamp');
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 2_147_483_647 ||
      stamp.type !== 'date-time' || !stamp.jCal[3]?.endsWith('Z') || stamp.getParameter('tzid')) {
    throw new Error('Invalid calendar version.');
  }
  const revisionMs = wallTime(stamp.jCal[3].slice(0, -1));
  const eventKey = createHmac('sha256', eventKeySecret).update(organizer).update('\0').update(uid).digest('hex');
  if (method === 'CANCEL') return { eventKey, method, sequence, revisionMs };
  if (one(event, 'status', false)?.getFirstValue()?.toUpperCase() === 'CANCELLED') throw new Error('Invalid method.');

  const start = eventInstant(one(event, 'dtstart'), calendar);
  const end = eventInstant(one(event, 'dtend'), calendar);
  if (end.ms <= start.ms || end.ms - start.ms > MAX_WINDOW_MS) throw new Error('Invalid availability window.');
  return { eventKey, method, sequence, revisionMs, startMs: start.ms, endMs: end.ms,
    ...(start.zone ? { sourceTimeZone: start.zone } : {}) };
}
