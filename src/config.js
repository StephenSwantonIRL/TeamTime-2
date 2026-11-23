import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export function databaseConfig(env = process.env) {
  if (!env.MONGODB_URI) throw new Error('Set MONGODB_URI to a replica set connection string.');
  return { uri: env.MONGODB_URI, databaseName: env.MONGODB_DB || 'teamtime' };
}

function powerAutomateUrl(value, name) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.hash) return url;
  } catch { /* Report the setting name without printing the signed URL. */ }
  throw new Error(`${name} must contain a valid HTTPS trigger URL.`);
}

function invitationConfig(env, demo) {
  if (demo) return undefined;
  const url = powerAutomateUrl(env.POWER_AUTOMATE_URL, 'POWER_AUTOMATE_URL');
  const statusUrl = powerAutomateUrl(env.POWER_AUTOMATE_STATUS_URL, 'POWER_AUTOMATE_STATUS_URL');
  if (!url && !statusUrl) return undefined;
  if (!url || (statusUrl && url.origin === statusUrl.origin && url.pathname.replace(/\/+$/, '') === statusUrl.pathname.replace(/\/+$/, ''))) {
    throw new Error('Power Automate creation and status lookup need distinct trigger URLs.');
  }
  const method = (env.POWER_AUTOMATE_METHOD || 'POST').trim().toUpperCase();
  const statusMethod = (env.POWER_AUTOMATE_STATUS_METHOD || 'POST').trim().toUpperCase();
  const timeoutMs = Number(env.POWER_AUTOMATE_TIMEOUT_MS ?? 10_000);
  if (![method, statusMethod].every((value) => ['GET', 'POST'].includes(value))) {
    throw new Error('Power Automate request methods must be GET or POST.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000) {
    throw new Error('POWER_AUTOMATE_TIMEOUT_MS must be between 1000 and 30000.');
  }
  return { url, method, statusUrl, statusMethod, timeoutMs };
}

function mailConfig(env, { demo, host }) {
  const providerId = env.MAIL_PROVIDER || 'disabled';
  if (demo || providerId === 'disabled') return undefined;
  if (!['mock', 'gmail', 'imap'].includes(providerId)) throw new Error('Invalid MAIL_PROVIDER.');
  const intervalMs = Number(env.MAIL_POLL_INTERVAL_MS ?? 120_000);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 43_200_000) {
    throw new Error('Invalid MAIL_POLL_INTERVAL_MS.');
  }
  if (providerId === 'mock') {
    if (env.NODE_ENV === 'production' || !['127.0.0.1', '::1', 'localhost'].includes(host)) {
      throw new Error('The mock provider is for local development.');
    }
    return { providerId, intervalMs };
  }

  const organizer = env.MAIL_ORGANIZER?.trim().toLowerCase();
  const email = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const eventKeySecret = env.MAIL_EVENT_KEY_SECRET;
  if (!email.test(organizer ?? '') || !/^[0-9a-f]{64}$/i.test(eventKeySecret ?? '')) {
    throw new Error('Set MAIL_ORGANIZER and a stable 32-byte MAIL_EVENT_KEY_SECRET.');
  }
  const shared = { providerId, intervalMs, organizer,
    eventKeySecret: Buffer.from(eventKeySecret, 'hex'), dkimDomain: organizer.split('@')[1] };

  if (providerId === 'imap') {
    const imapHost = env.IMAP_HOST?.trim().toLowerCase() || 'imap.gmail.com';
    const imapPort = Number(env.IMAP_PORT || 993);
    const imapUser = env.IMAP_USER?.trim();
    const imapFolder = env.IMAP_FOLDER || 'INBOX';
    const imapPassword = imapHost === 'imap.gmail.com' ? env.IMAP_PASSWORD?.replace(/\s/g, '') : env.IMAP_PASSWORD;
    const rejectUnauthorized = env.IMAP_REJECT_UNAUTHORIZED?.trim().toLowerCase() || 'true';
    if (rejectUnauthorized !== 'true' && rejectUnauthorized !== 'false') {
      throw new Error('IMAP_REJECT_UNAUTHORIZED must be true or false.');
    }
    if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(imapHost) || !Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535 ||
        !imapUser || !imapPassword || imapFolder.length > 255 || /[\p{Cc}]/u.test(imapFolder)) {
      throw new Error('Incomplete IMAP configuration.');
    }
    return { ...shared, imapHost, imapPort, imapUser, imapPassword, imapFolder,
      imapRejectUnauthorized: rejectUnauthorized === 'true' };
  }

  const mailbox = env.GMAIL_MAILBOX?.trim().toLowerCase();
  const [clientId, clientSecret, refreshToken] = [env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET, env.GMAIL_REFRESH_TOKEN];
  if (!email.test(mailbox ?? '') || !clientId || !clientSecret || !refreshToken) throw new Error('Incomplete Gmail configuration.');
  return { ...shared, mailbox, clientId, clientSecret, refreshToken };
}

export function serverConfig(env = process.env, args = process.argv.slice(2)) {
  const demo = args.includes('--demo');
  const render = env.RENDER === 'true';
  const host = env.HOST || (render ? '0.0.0.0' : '127.0.0.1');
  const port = Number(env.PORT ?? 3000);
  const trustProxyHops = Number(env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0) throw new Error('TRUST_PROXY_HOPS must be a nonnegative integer.');
  if (render && host !== '0.0.0.0') throw new Error('On Render, set HOST to 0.0.0.0 or remove the HOST override.');
  if (demo && (env.NODE_ENV === 'production' || !['127.0.0.1', '::1', 'localhost'].includes(host))) {
    throw new Error('Demo mode is available only on a local development host.');
  }
  return {
    demo, host, port, trustProxyHops, mongo: demo ? undefined : databaseConfig(env), mail: mailConfig(env, { demo, host }),
    invitations: invitationConfig(env, demo),
  };
}
