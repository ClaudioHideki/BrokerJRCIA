const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function deriveUpstreamInstanceKey(instanceId: string): string {
  if (!UUID_PATTERN.test(instanceId)) {
    throw new Error('Instance id must be a UUID');
  }
  return `jrc_${instanceId.replaceAll('-', '').toLowerCase()}`;
}
