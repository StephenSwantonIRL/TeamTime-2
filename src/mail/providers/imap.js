import { createHmac } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { MailSyncError, MAX_MESSAGE_BYTES } from '../message.js';

const MAX_UID = 4_294_967_295;
const UID_SPAN = 1_024;
const PAGE_SIZE = 6;
const uidOptions = { uid: true };

function isUid(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_UID;
}

function isValidity(value) {
  return typeof value === 'string' && /^\d{1,10}$/.test(value) && isUid(Number(value));
}

function parseCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(cursor);
    if (!/^[a-f0-9]{64}$/.test(value.mailboxKey) || !isValidity(value.uidValidity) ||
        (value.lastUid !== 0 && !isUid(value.lastUid))) throw new Error('Invalid checkpoint.');
    return value;
  } catch {
    throw new MailSyncError('cursor_expired');
  }
}

export function createImapProvider({
  imapHost, imapPort, imapUser, imapPassword, imapFolder, imapRejectUnauthorized = true, organizer, eventKeySecret,
}, {
  createClient = (options) => new ImapFlow(options),
} = {}) {
  const mailboxKey = createHmac('sha256', eventKeySecret).update('teamtime:imap:')
    .update(JSON.stringify([imapHost, imapPort, imapUser, imapFolder, organizer])).digest('hex');
  let client;

  function disconnect() {
    client?.close();
    client = undefined;
  }

  async function inMailbox(read) {
    try {
      if (!client?.usable) {
        disconnect();
        client = createClient({
          host: imapHost, port: imapPort, secure: true,
          auth: { user: imapUser, pass: imapPassword },
          tls: { rejectUnauthorized: imapRejectUnauthorized, minVersion: 'TLSv1.2' },
          logger: false, logRaw: false, disableAutoIdle: true,
          connectionTimeout: 12_000, greetingTimeout: 12_000, socketTimeout: 25_000,
        });
        // An idle socket can fail between polls. The next operation reconnects.
        client.on('error', () => {});
        await client.connect();
      }
      const lock = await client.getMailboxLock(imapFolder, { readOnly: true });
      try {
        if (!client.mailbox?.readOnly) throw new MailSyncError('connection');
        const status = await client.status(imapFolder, { uidNext: true, uidValidity: true });
        const uidValidity = String(status?.uidValidity);
        if (!isValidity(uidValidity) || !isUid(status?.uidNext)) throw new MailSyncError('read_failed');
        return await read(client, uidValidity, status.uidNext - 1);
      } finally {
        lock.release();
      }
    } catch (error) {
      const code = error instanceof MailSyncError ? error.code : !client?.usable || error.authenticationFailed ? 'connection' : 'read_failed';
      disconnect();
      throw new MailSyncError(code);
    }
  }

  return {
    async readChanges(cursor) {
      const previous = parseCursor(cursor);
      return inMailbox(async (connection, uidValidity, latestUid) => {
        let historyGap = Boolean(previous && (previous.mailboxKey !== mailboxKey ||
          previous.uidValidity !== uidValidity || previous.lastUid > latestUid));
        let lastUid = historyGap ? 0 : previous?.lastUid ?? 0;
        const messages = [];
        let rejected = false;
        if (lastUid < latestUid) {
          const high = Math.min(lastUid + UID_SPAN, latestUid);
          const range = `${lastUid + 1}:${high}`;
          const found = await connection.search({ uid: range, from: organizer }, uidOptions);
          if (!Array.isArray(found) || found.some((uid) => !isUid(uid) || uid <= lastUid || uid > high)) {
            throw new MailSyncError('read_failed');
          }
          const ordered = [...new Set(found)].sort((a, b) => a - b);
          const page = ordered.slice(0, PAGE_SIZE);
          if (page.length) {
            const metadata = await connection.fetchAll(page, { size: true }, uidOptions);
            const sizes = new Map(metadata.map(({ uid, size }) => [uid, size]));
            const eligible = page.filter((uid) => {
              if (!sizes.has(uid)) historyGap = true;
              else if (Number.isInteger(sizes.get(uid)) && sizes.get(uid) > 0 && sizes.get(uid) <= MAX_MESSAGE_BYTES) return true;
              else rejected = true;
              return false;
            });
            if (eligible.length) {
              const rows = await connection.fetchAll(eligible, { source: { start: 0, maxLength: MAX_MESSAGE_BYTES + 1 } }, uidOptions);
              const sources = new Map(rows.map(({ uid, source }) => [uid, source]));
              for (const uid of eligible) {
                const rawMime = sources.get(uid);
                if (!sources.has(uid)) historyGap = true;
                else if (!Buffer.isBuffer(rawMime) || rawMime.length !== sizes.get(uid)) rejected = true;
                else messages.push({ rawMime });
              }
            }
          }
          lastUid = ordered.length > PAGE_SIZE ? page.at(-1) : high;
        }

        return {
          messages, historyGap, rejected, hasMore: lastUid < latestUid,
          cursor: JSON.stringify({ mailboxKey, uidValidity, lastUid }),
        };
      });
    },
    async testConnection() {
      await inMailbox(async () => {});
    },
    async close() {
      disconnect();
    },
  };
}
