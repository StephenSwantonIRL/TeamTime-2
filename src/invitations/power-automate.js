const MAX_RESPONSE_BYTES = 4096;

async function readOutcome(response) {
  if (![200, 201, 400, 422].includes(response.status) || !response.body) {
    await response.body?.cancel();
    return 'unknown';
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_RESPONSE_BYTES) return 'unknown';
    chunks.push(chunk);
  }
  const { status } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (response.ok && status === 'created') return 'created';
  if (status === 'rejected') return 'rejected';
  return 'unknown';
}

export function createPowerAutomateService({ url, method, statusUrl, statusMethod, timeoutMs }, fetchImpl = fetch) {
  async function request(endpoint, httpMethod, fields, bookingId) {
    const target = new URL(endpoint);
    for (const [key, value] of Object.entries(fields)) target.searchParams.set(key, value);
    try {
      const response = await fetchImpl(target, {
        method: httpMethod,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json', ...(bookingId ? { 'Idempotency-Key': bookingId } : {}) },
      });
      return await readOutcome(response);
    } catch {
      // Neither a dropped connection nor a timeout proves that Outlook creation failed.
      return 'unknown';
    }
  }

  return {
    send({ _id, startUtc, endUtc }, { email }) {
      return request(url, method, {
        title: '1:1 with Stephen',
        datetime: startUtc.toISOString(),
        endtime: endUtc.toISOString(),
        duration: (endUtc.getTime() - startUtc.getTime()) / 60_000,
        participant: email,
        bookingId: _id,
      }, _id);
    },
    lookup: statusUrl ? (bookingId) => request(statusUrl, statusMethod, { bookingId }) : undefined,
  };
}
