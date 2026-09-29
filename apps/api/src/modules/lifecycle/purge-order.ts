export interface TenantForeignKey {
  child: string;
  parent: string;
  deferrable: boolean;
}

const tableIdentifier = /^[a-z][a-z0-9_]{0,62}$/;

/** Foreign-key children must be deleted before their parents. Unknown cycles fail closed. */
export function planTenantPurgeOrder(tables: readonly string[], foreignKeys: readonly TenantForeignKey[]): string[] {
  if (tables.some(table => !tableIdentifier.test(table))) throw new Error('TENANT_PURGE_CATALOGUE_INVALID');
  const names = new Set(tables);
  const parents = new Map([...names].map(name => [name, new Set<string>()]));
  const incoming = new Map([...names].map(name => [name, 0]));
  for (const { child, parent, deferrable } of foreignKeys) {
    if (!names.has(child) || !names.has(parent)) continue;
    if (child === parent) {
      if (!deferrable) throw new Error('TENANT_PURGE_CYCLE');
      continue;
    }
    const outgoing = parents.get(child)!;
    if (outgoing.has(parent)) continue;
    outgoing.add(parent);
    incoming.set(parent, incoming.get(parent)! + 1);
  }
  const ready = [...names].filter(name => incoming.get(name) === 0).sort();
  const ordered: string[] = [];
  while (ready.length) {
    const table = ready.shift()!;
    ordered.push(table);
    for (const parent of parents.get(table)!) {
      incoming.set(parent, incoming.get(parent)! - 1);
      if (incoming.get(parent) === 0) {
        ready.push(parent);
        ready.sort();
      }
    }
  }
  if (ordered.length !== names.size) throw new Error('TENANT_PURGE_CYCLE');
  return ordered;
}
