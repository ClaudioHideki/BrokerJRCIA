export function guidedSetupNavigation(search: string) {
  const values = new URLSearchParams(search), id = values.get('setup'), node = values.get('node');
  return { returnPath: id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id) ? `/configuracao-guiada/${id}` : null,
    nodeId: node && /^[\w.:-]{1,200}$/u.test(node) ? node : null };
}
