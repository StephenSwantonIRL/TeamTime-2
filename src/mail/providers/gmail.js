import { MailSyncError, MAX_MESSAGE_BYTES } from '../message.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const PAGE_SIZE = 6;
const HISTORY_ID = /^\d{1,30}$/;
const MESSAGE_ID = /^[a-z0-9]{1,128}$/i;

class GmailResponseError extends Error {
  constructor(status) {
    super('Gmail request failed.');
    this.status = status;
  }
}

async function readJson(response, limit) {
  if (!response.ok || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new GmailResponseError(response.ok ? 413 : response.status);
  }
  const chunks = [];
  let bytes = 0;
  for await (const value of response.body) {
    bytes += value.length;
    if (bytes > limit) throw new GmailResponseError(413);
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function readCursor(cursor) {
  if (!cursor) return null;
  try {
    const state = JSON.parse(cursor);
    if (!['scan', 'history'].includes(state.mode) || !HISTORY_ID.test(state.historyId) ||
        (state.pageToken !== undefined && (typeof state.pageToken !== 'string' || state.pageToken.length > 2000)) ||
        !Number.isSafeInteger(state.offset) || state.offset < 0) throw new Error('Invalid cursor.');
    return state;
  } catch {
    throw new MailSyncError('cursor_expired');
  }
}

export function createGmailProvider({ mailbox, clientId, clientSecret, refreshToken }, {
  fetchImpl = fetch, clock = Date.now,
} = {}) {
  let access;
  let verifiedMailbox = false;

  async function request(url, options = {}, limit = 128 * 1024) {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(12_000) });
    return readJson(response, limit);
  }

  async function authorize() {
    if (access?.until > clock()) return access.token;
    const data = await request(TOKEN_URL, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token',
      }),
    });
    if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in) || data.expires_in < 1) {
      throw new MailSyncError('connection');
    }
    access = { token: data.access_token, until: clock() + Math.max(0, data.expires_in - 60) * 1000 };
    return access.token;
  }

  async function get(path, params, token, limit) {
    const url = new URL(path, GMAIL_URL);
    for (const [name, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(name, value);
    return request(url, { headers: { Authorization: `Bearer ${token}` } }, limit);
  }

  async function profile(token) {
    const data = await get('profile', { fields: 'emailAddress,historyId' }, token);
    if (data.emailAddress?.toLowerCase() !== mailbox || typeof data.historyId !== 'string' || !HISTORY_ID.test(data.historyId)) {
      throw new MailSyncError('connection');
    }
    verifiedMailbox = true;
    return data.historyId;
  }

  async function rawMessage(id, token) {
    if (typeof id !== 'string' || !MESSAGE_ID.test(id)) throw new MailSyncError('read_failed');
    const maxEncoded = Math.ceil(MAX_MESSAGE_BYTES * 4 / 3) + 4;
    try {
      const data = await get(`messages/${id}`, { format: 'raw', fields: 'raw,labelIds' }, token, maxEncoded + 4096);
      if (data.labelIds?.some((label) => ['SPAM', 'TRASH', 'DRAFT', 'SENT'].includes(label))) return {};
      if (typeof data.raw !== 'string' || data.raw.length > maxEncoded || !/^[A-Za-z0-9_-]+={0,2}$/.test(data.raw)) return { rejected: true };
      const rawMime = Buffer.from(data.raw, 'base64url');
      return rawMime.length <= MAX_MESSAGE_BYTES ? { message: { rawMime } } : { rejected: true };
    } catch (error) {
      if (error.status === 404) return { historyGap: true };
      if (error.status === 413) return { rejected: true };
      throw error;
    }
  }

  async function readPage(state, token, historyGap = false) {
    const initialHistory = !state || !verifiedMailbox ? await profile(token) : undefined;
    state ??= { mode: 'scan', historyId: initialHistory, offset: 0 };
    const { mode, historyId, pageToken, offset } = state;
    let page;
    try {
      page = mode === 'scan' ? await get('messages', {
        pageToken, maxResults: PAGE_SIZE, fields: 'messages(id),nextPageToken',
      }, token) : await get('history', {
        startHistoryId: historyId, pageToken, maxResults: PAGE_SIZE, historyTypes: 'messageAdded',
        fields: 'history(messagesAdded(message(id)),id),nextPageToken,historyId',
      }, token);
    } catch (error) {
      if ((mode === 'history' && error.status === 404) || (pageToken && error.status === 400)) {
        return readPage(null, token, true);
      }
      throw error;
    }

    const ids = mode === 'scan' ? (page.messages ?? []).map(({ id }) => id) : [...new Set(
      (page.history ?? []).flatMap(({ messagesAdded }) => (messagesAdded ?? []).map(({ message }) => message.id)),
    )];
    const nextOffset = offset + PAGE_SIZE;
    const uniquePage = await Promise.all(ids.slice(offset, nextOffset).map((id) => rawMessage(id, token)));
    const nextPageToken = page.nextPageToken;
    if (nextPageToken && (typeof nextPageToken !== 'string' || nextPageToken.length > 2000)) throw new MailSyncError('read_failed');
    let next;
    if (nextOffset < ids.length) next = { ...state, offset: nextOffset };
    else if (nextPageToken) next = { mode, historyId, pageToken: nextPageToken, offset: 0 };
    else next = { mode: 'history', historyId: mode === 'scan' ? historyId : page.historyId, offset: 0 };
    if (typeof next.historyId !== 'string' || !HISTORY_ID.test(next.historyId)) throw new MailSyncError('read_failed');

    return {
      messages: uniquePage.flatMap(({ message }) => message ? [message] : []),
      cursor: JSON.stringify(next),
      hasMore: mode === 'scan' || nextOffset < ids.length || Boolean(nextPageToken),
      historyGap: historyGap || uniquePage.some((item) => item.historyGap),
      rejected: uniquePage.some((item) => item.rejected),
    };
  }

  return {
    async readChanges(cursor) {
      const state = readCursor(cursor);
      for (let attempt = 0; attempt < 2; attempt++) {
        let token;
        try { token = await authorize(); } catch { throw new MailSyncError('connection'); }
        try {
          return await readPage(state, token);
        } catch (error) {
          if (error.status !== 401 || attempt > 0) {
            if (error instanceof MailSyncError) throw error;
            throw new MailSyncError(error.status === 401 || error.status === 403 ? 'connection' : 'read_failed');
          }
          access = undefined;
        }
      }
    },
    async testConnection() {
      try { await profile(await authorize()); } catch { throw new MailSyncError('connection'); }
    },
    async close() {
      access = undefined;
      verifiedMailbox = false;
    },
  };
}
