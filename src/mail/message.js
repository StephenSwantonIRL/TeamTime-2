export const MAX_MESSAGE_BYTES = 1024 * 1024;

const MAX_HEADER_BYTES = 24 * 1024;
export const SIGNED_HEADERS = ['from', 'subject', 'content-type', 'content-transfer-encoding', 'mime-version', 'content-disposition'];

export function splitMessage(raw) {
  if (!Buffer.isBuffer(raw) || raw.length > MAX_MESSAGE_BYTES) return null;

  const separator = raw.indexOf('\r\n\r\n');
  if (separator < 1 || separator > MAX_HEADER_BYTES) return null;
  const fields = [];
  for (const line of raw.subarray(0, separator).toString('latin1').split(/\r\n(?=[^ \t])/)) {
    const colon = line.indexOf(':');
    const name = line.slice(0, colon);
    if (colon < 1 || !/^[!-9;-~]+$/.test(name) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line) ||
        /\r(?!\n)|(?<!\r)\n/.test(line)) return null;
    fields.push({ name: name.toLowerCase(), line });
  }
  for (const name of SIGNED_HEADERS) {
    if (fields.filter((field) => field.name === name).length > 1) return null;
  }
  if (!fields.some(({ name }) => name === 'from') || !fields.some(({ name }) => name === 'content-type')) return null;
  return { fields, body: raw.subarray(separator + 4) };
}

export class MailSyncError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
