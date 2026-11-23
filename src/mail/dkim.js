import { createHash, createPublicKey, verify } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { MailSyncError, SIGNED_HEADERS } from './message.js';

const dns = new Resolver({ timeout: 2_000, tries: 2 });
const dnsName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const base64 = /^[a-z0-9+/]+={0,2}$/i;

function parseTags(value) {
  const tags = new Map();
  for (const item of value.split(';')) {
    if (!item.trim()) continue;
    const equals = item.indexOf('=');
    const name = item.slice(0, equals).trim();
    if (equals < 0 || !/^[a-z][a-z0-9_]*$/.test(name) || tags.has(name)) return new Map();
    tags.set(name, item.slice(equals + 1).trim());
  }
  return tags;
}

function canonicalBody(body, mode) {
  const lines = body.toString('latin1').split('\r\n');
  if (mode === 'relaxed') {
    for (let index = 0; index < lines.length; index++) {
      lines[index] = lines[index].replace(/[ \t]+/g, ' ').replace(/ $/, '');
    }
  }
  while (lines.at(-1) === '') lines.pop();
  return lines.length || mode === 'simple' ? `${lines.join('\r\n')}\r\n` : '';
}

function canonicalHeader(line, mode) {
  if (mode === 'simple') return line;
  const colon = line.indexOf(':');
  const value = line.slice(colon + 1).replace(/\r\n/g, '').replace(/[ \t]+/g, ' ').replace(/^ | $/g, '');
  return `${line.slice(0, colon).toLowerCase()}:${value}`;
}

function signedHeaderBlock(fields, signature, names, mode) {
  const available = fields.filter((field) => field !== signature).reverse();
  const selected = [];
  for (const name of names) {
    const index = available.findIndex((field) => field.name === name);
    if (index < 0) continue;
    const [field] = available.splice(index, 1);
    selected.push(`${canonicalHeader(field.line, mode)}\r\n`);
  }
  const colon = signature.line.indexOf(':');
  const emptyB = signature.line.slice(colon + 1).replace(/(^|;)([ \t\r\n]*b[ \t\r\n]*=)[^;]*/, '$1$2');
  selected.push(canonicalHeader(signature.line.slice(0, colon + 1) + emptyB, mode));
  return Buffer.from(selected.join(''), 'latin1');
}

function publicKey(records) {
  const recordsWithKey = records.map((chunks) => parseTags(chunks.join(''))).filter((tags) => tags.has('p'));
  if (recordsWithKey.length !== 1) return null;
  const [tags] = recordsWithKey;
  const key = tags.get('p').replace(/\s/g, '');
  if ((tags.get('v') ?? 'DKIM1') !== 'DKIM1' || (tags.get('k') ?? 'rsa') !== 'rsa' ||
      !/^(?:[^:]+:)*sha256(?::[^:]+)*$/.test(tags.get('h') ?? 'sha256') ||
      !(tags.get('s') ?? '*').split(':').some((service) => service === '*' || service === 'email') ||
      key.length > 1500 || !base64.test(key)) return null;

  const der = Buffer.from(key, 'base64');
  for (const type of ['spki', 'pkcs1']) {
    try {
      const publicKey = createPublicKey({ key: der, format: 'der', type });
      const bits = publicKey.asymmetricKeyDetails?.modulusLength;
      if (publicKey.asymmetricKeyType === 'rsa' && bits >= 1024 && bits <= 4096) return publicKey;
    } catch {
      // A TXT record may use either supported ASN.1 encoding for its RSA key.
    }
  }
  return null;
}

export function createDkimVerifier(domain, { resolveTxt = (name) => dns.resolveTxt(name), clock = Date.now } = {}) {
  return async ({ fields, body }) => {
    const signatures = fields.filter(({ name }) => name === 'dkim-signature');
    if (signatures.length > 8) return false;
    const protectedNames = SIGNED_HEADERS.filter((name) => fields.some((field) => field.name === name));
    let dnsFailure = false;

    for (const signature of signatures) {
      const tags = parseTags(signature.line.slice(signature.line.indexOf(':') + 1));
      const selector = tags.get('s');
      const [headerMode, bodyMode = 'simple', extra] = (tags.get('c') ?? 'simple').split('/');
      const names = (tags.get('h') ?? '').toLowerCase().split(':').map((name) => name.trim());
      const signatureValue = (tags.get('b') ?? '').replace(/\s/g, '');
      const identity = tags.get('i') ?? `@${domain}`;
      const now = Math.floor(clock() / 1000);
      const timestamp = tags.get('t');
      const expires = tags.get('x');
      if (tags.get('v') !== '1' || tags.get('a') !== 'rsa-sha256' || tags.get('d')?.toLowerCase() !== domain ||
          identity.slice(identity.lastIndexOf('@') + 1).toLowerCase() !== domain || tags.has('l') ||
          !selector || selector.length + domain.length > 240 || !dnsName.test(selector) ||
          !(tags.get('q') ?? 'dns/txt').split(':').includes('dns/txt') || extra !== undefined ||
          !['simple', 'relaxed'].includes(headerMode) || !['simple', 'relaxed'].includes(bodyMode) ||
          names.length > 100 || !protectedNames.every((name) => names.includes(name)) ||
          !base64.test(signatureValue) || signatureValue.length > 700 ||
          (timestamp && (!/^\d{1,12}$/.test(timestamp) || Number(timestamp) > now + 300)) ||
          (expires && (!/^\d{1,12}$/.test(expires) || Number(expires) <= now || Number(expires) <= Number(timestamp)))) continue;

      const bodyHash = createHash('sha256').update(canonicalBody(body, bodyMode), 'latin1').digest('base64');
      if (bodyHash !== (tags.get('bh') ?? '').replace(/\s/g, '')) continue;

      let records;
      try {
        records = await resolveTxt(`${selector}._domainkey.${domain}`);
      } catch (error) {
        if (!['ENOTFOUND', 'ENODATA'].includes(error.code)) dnsFailure = true;
        continue;
      }
      const key = publicKey(records);
      if (key && verify('RSA-SHA256', signedHeaderBlock(fields, signature, names, headerMode), key, Buffer.from(signatureValue, 'base64'))) {
        return true;
      }
    }

    if (dnsFailure) throw new MailSyncError('read_failed');
    return false;
  };
}
