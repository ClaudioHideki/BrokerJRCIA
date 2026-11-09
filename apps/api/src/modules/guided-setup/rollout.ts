import { z } from 'zod';
/** Empty is disabled. Initial exposure can be limited without client-specific code. */
export function guidedSetupRollout(value?: string): (org: string) => boolean {
  if (value === undefined || !value.trim()) return () => false;
  if (value === 'all') return () => true;
  const ids = z.array(z.uuid()).max(1000).parse(value.split(',').map(part => part.trim()));
  const allowed = new Set(ids);
  return org => allowed.has(org);
}
