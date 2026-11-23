import { createDkimVerifier } from './dkim.js';
import { MailSyncError } from './message.js';
import { createMessageNormalizer } from './normalize-message.js';
import { createGmailProvider } from './providers/gmail.js';
import { createImapProvider } from './providers/imap.js';
import { createMockProvider, exampleInvitations, MOCK_ORGANIZER } from './providers/mock.js';

const MAX_PAGES_PER_POLL = 12;
const knownFailures = new Set(['connection', 'cursor_expired', 'read_failed', 'import_failed']);

export function configureMailbox(config) {
  if (config.providerId === 'mock') {
    const { messages, generation } = exampleInvitations();
    return {
      provider: createMockProvider(messages, { generation }),
      normalize: createMessageNormalizer({
        organizer: MOCK_ORGANIZER, eventKeySecret: Buffer.alloc(32), authenticate: async () => true,
      }),
    };
  }
  return {
    provider: config.providerId === 'imap' ? createImapProvider(config) : createGmailProvider(config),
    normalize: createMessageNormalizer({ ...config, authenticate: createDkimVerifier(config.dkimDomain) }),
  };
}

export async function synchronizeMailbox({
  store, providerId, provider, normalize, shouldStop = () => false, report = () => {},
}) {
  for (let count = 0; count < MAX_PAGES_PER_POLL && !shouldStop(); count++) {
    const state = await store.getState(providerId);
    let page;
    let changes;
    try {
      page = await provider.readChanges(state.cursor ?? null);
      if (shouldStop()) return;
      changes = [];
      for (const message of page.messages) changes.push(await normalize(message));
    } catch (error) {
      const code = error instanceof MailSyncError && knownFailures.has(error.code) ? error.code : 'read_failed';
      await store.recordFailure(providerId, state.revision, code);
      report('failure', code);
      return;
    }
    if (shouldStop()) return;

    const accepted = changes.filter(Boolean);
    let result;
    try {
      result = await store.commitPage(providerId, state.revision, {
        cursor: page.cursor, changes: accepted, historyGap: page.historyGap,
        rejected: page.rejected || changes.length !== accepted.length,
      });
    } catch {
      await store.recordFailure(providerId, state.revision, 'import_failed');
      report('failure', 'import_failed');
      return;
    }

    if (!result) return;
    if (result.flagged) report('booking_conflict', result.flagged);
    if (result.divergentVersions) report('version_conflict');
    if (page.historyGap) report('history_gap');
    if (!page.hasMore) return;
  }
}

function reportSync(type, value) {
  if (type === 'booking_conflict') {
    console.warn(`TeamTime availability conflicts need review (${value} newly flagged).`);
  } else if (type === 'history_gap') {
    console.warn('TeamTime detected a mailbox history gap. Compare upcoming Outlook availability with the booking calendar.');
  } else if (type === 'version_conflict') {
    console.warn('TeamTime received conflicting calendar instructions with the same version.');
  } else {
    console.warn(`TeamTime mailbox sync failed (${value}).`);
  }
}

export function startMailboxPoller(config, store) {
  const mailbox = configureMailbox(config);
  let stopped = false;
  let timer;
  let running;

  function poll() {
    running = synchronizeMailbox({
      ...mailbox, store, providerId: config.providerId, shouldStop: () => stopped, report: reportSync,
    }).catch(() => reportSync('failure', 'sync_state_unavailable')).finally(() => {
      if (!stopped) timer = setTimeout(poll, config.intervalMs);
    });
  }
  poll();
  return async function stop() {
    stopped = true;
    clearTimeout(timer);
    try { await running; } finally { await mailbox.provider.close(); }
  };
}
