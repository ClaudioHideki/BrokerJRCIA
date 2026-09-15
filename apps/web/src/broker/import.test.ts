import { describe, expect, it, vi } from 'vitest';
import { parseProvisioningCsv, runProvisioningBatch, toCsv } from './import.js';
describe('Importação do broker', () => {
  it('lê BOM, separador brasileiro, aspas e linhas vazias', () => {
    expect(
      parseProvisioningCsv('\ufeffnome;observacao\r\n"Comercial; SP";teste\r\nSuporte;ok\r\n'),
    ).toEqual(['Comercial; SP', 'Suporte']);
  });
  it('recusa duplicados, planilha vazia, colunas desconhecidas e excesso', () => {
    expect(() => parseProvisioningCsv('nome\nVendas\nvendas')).toThrow(/duplicad/i);
    expect(() => parseProvisioningCsv('nome\n')).toThrow();
    expect(() => parseProvisioningCsv('telefone\n123')).toThrow(/nome/i);
    expect(() =>
      parseProvisioningCsv(
        'nome\n' + Array.from({ length: 101 }, (_, i) => 'Canal ' + i).join('\n'),
      ),
    ).toThrow(/100/);
  });
  it('interrompe o lote em resultado incerto sem reenviar nem criar o próximo', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        instance: { id: 'a' },
        reconciliationRequired: false,
        pending: false,
      })
      .mockResolvedValueOnce({
        instance: { id: 'b' },
        reconciliationRequired: true,
        pending: true,
      });
    const rows = [
      { name: 'A', key: 'key-a' },
      { name: 'B', key: 'key-b' },
      { name: 'C', key: 'key-c' },
    ];
    const result = await runProvisioningBatch(
      rows,
      create,
      () => true,
      () => {},
    );
    expect(create.mock.calls).toEqual([[rows[0]], [rows[1]]]);
    expect(result.map((r) => r.state)).toEqual(['CREATED', 'REVIEW', 'WAITING']);
  });
  it('cancela antes da próxima criação e registra timeout como incerto', async () => {
    const create = vi.fn().mockRejectedValue(new Error('timeout'));
    expect(
      (
        await runProvisioningBatch(
          [{ name: 'A', key: 'a' }],
          create,
          () => false,
          () => {},
        )
      )[0]?.state,
    ).toBe('WAITING');
    expect(create).not.toHaveBeenCalled();
    expect(
      (
        await runProvisioningBatch(
          [{ name: 'A', key: 'a' }],
          create,
          () => true,
          () => {},
        )
      )[0]?.state,
    ).toBe('REVIEW');
  });
  it('neutraliza fórmulas em exportação e escapa delimitadores', () => {
    expect(
      toCsv([
        ['nome', 'valor'],
        ['=CMD()', 'a"b'],
      ]),
    ).toContain('"\'=CMD()","a""b"');
  });
});
