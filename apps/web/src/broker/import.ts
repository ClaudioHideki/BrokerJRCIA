export interface ProvisioningRow {
  name: string;
  key: string;
}
export interface ProvisioningResult extends ProvisioningRow {
  state: 'WAITING' | 'CREATED' | 'PENDING' | 'REVIEW';
  instanceId?: string;
}
export function parseProvisioningCsv(input: string): string[] {
  if (input.length > 100_000) throw new Error('Arquivo maior que 100 KB.');
  const text = input.replace(/^\ufeff/, '');
  const first = text.split(/\r?\n/)[0] ?? '';
  const delimiter = first.includes(';') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closed = false;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i] ?? '\n';
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
      continue;
    }
    if (c === '"') {
      if (field || closed) throw new Error('Aspas inválidas no CSV.');
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
      closed = false;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      field = '';
      closed = false;
    } else {
      if (closed) throw new Error('Conteúdo após aspas no CSV.');
      field += c;
    }
  }
  if (quoted) throw new Error('Aspas não fechadas no CSV.');
  const headers = rows.shift()?.map((v) => v.trim().toLowerCase()) ?? [];
  if (headers.filter((h) => h === 'nome').length !== 1)
    throw new Error('Inclua uma única coluna nome no cabeçalho.');
  const index = headers.indexOf('nome');
  const names = rows.map((r) => (r[index] ?? '').trim());
  if (!names.length || names.length > 100) throw new Error('Importe entre 1 e 100 conexões.');
  const seen = new Set<string>();
  for (const name of names) {
    if (!name || name.length > 120 || /[\r\n\x00-\x1f]/.test(name))
      throw new Error('Cada nome deve ter entre 1 e 120 caracteres em uma linha.');
    const key = name.toLocaleLowerCase('pt-BR');
    if (seen.has(key)) throw new Error('Há nomes duplicados no arquivo.');
    seen.add(key);
  }
  return names;
}
export async function runProvisioningBatch(
  rows: ProvisioningRow[],
  create: (
    row: ProvisioningRow,
  ) => Promise<{ instance: { id: string }; reconciliationRequired: boolean; pending: boolean }>,
  canContinue: () => boolean,
  onProgress: (rows: ProvisioningResult[]) => void,
): Promise<ProvisioningResult[]> {
  const results: ProvisioningResult[] = rows.map((r) => ({ ...r, state: 'WAITING' }));
  for (let i = 0; i < rows.length; i++) {
    if (!canContinue()) break;
    const row = rows[i]!;
    try {
      const result = await create(row);
      results[i] = {
        ...row,
        instanceId: result.instance.id,
        state: result.reconciliationRequired ? 'REVIEW' : result.pending ? 'PENDING' : 'CREATED',
      };
    } catch {
      results[i] = { ...row, state: 'REVIEW' };
    }
    onProgress([...results]);
    if (results[i]!.state === 'REVIEW') break;
  }
  return results;
}
export function toCsv(rows: (string | number)[][]): string {
  return (
    '\ufeff' +
    rows
      .map((row) =>
        row
          .map((value) => {
            let text = String(value);
            if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
            return '"' + text.replace(/"/g, '""') + '"';
          })
          .join(','),
      )
      .join('\r\n')
  );
}
export function downloadCsv(filename: string, rows: (string | number)[][]) {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
