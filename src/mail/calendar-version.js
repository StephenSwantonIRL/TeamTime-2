export function calendarDecision(existing, change) {
  if (!existing) return 'apply';

  const version = change.sequence - existing.sequence || change.revisionMs - existing.revisionUtc.getTime();
  if (version !== 0) return version > 0 ? 'apply' : 'ignore';

  if (change.method === 'CANCEL') return existing.status === 'cancelled' ? 'ignore' : 'apply';
  if (existing.status === 'cancelled') return 'ignore';
  return existing.startUtc.getTime() === change.startMs && existing.endUtc.getTime() === change.endMs ?
    'ignore' : 'version_conflict';
}
