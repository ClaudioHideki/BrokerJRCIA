import { useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
import { z } from 'zod';
import { AUTOMATION_PACKAGE_MAX_BYTES, AutomationGraphV1Schema, type AutomationPackage } from '@jrc/contracts';
import type { ApiClient } from '../api/client.js';
import { AutomationPackageSchema, parsePackage, type PackageRecord } from './api.js';
import { setupError } from './useGuidedSetup.js';

const previewSchema = z.object({ rootKey: z.string(), flows: z.array(z.object({ key: z.string(), name: z.string() })).max(32),
  requirements: z.array(z.unknown()).max(5000), createdAsDraft: z.literal(false), autoPublished: z.literal(false) });
export function PackageImport({ client, organizationId, onImported }: { client: ApiClient; organizationId: string; onImported(record: PackageRecord): void | Promise<void> }) {
  const [artifact, setArtifact] = useState<AutomationPackage | null>(null), [preview, setPreview] = useState<z.infer<typeof previewSchema> | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [legacy, setLegacy] = useState(false);
  const generation = useRef(0), intent = useRef<string | null>(null), fileInput = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    generation.current++; setArtifact(null); setPreview(null); setError(''); setBusy(false); intent.current = null;
    if (fileInput.current) fileInput.current.value = '';
    return () => { generation.current++; intent.current = null; };
  }, [client, organizationId]);
  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0], current = ++generation.current;
    setArtifact(null); setPreview(null); setError(''); setLegacy(false); intent.current = null;
    if (!file) return;
    if (file.size > AUTOMATION_PACKAGE_MAX_BYTES) { setError('O arquivo excede 2 MiB. Exporte um pacote dentro dos limites do motor.'); return; }
    setBusy(true);
    try {
      const content = await file.text(); if (current !== generation.current) return;
      const value: unknown = JSON.parse(content.replace(/^\uFEFF/u, ''));
      let payload: AutomationPackage;
      if (value && typeof value === 'object' && 'format' in value && value.format === 'jrc-broker-package/1') payload = AutomationPackageSchema.parse(value);
      else {
        const converted = z.object({ name: z.string().max(120), graph: AutomationGraphV1Schema }).parse(await client.request('/v1/automation-imports/preview', {
          method: 'POST', body: JSON.stringify({ source: 'AUTO', content }),
        }));
        if (current !== generation.current) return;
        payload = AutomationPackageSchema.parse({ format: 'jrc-broker-package/1', rootKey: 'root', flows: [{ key: 'root', name: converted.name, graph: converted.graph }] });
        setLegacy(true);
      }
      if (current !== generation.current) return;
      const prepared = previewSchema.parse(await client.request('/v1/automation-packages/preview', { method: 'POST', body: JSON.stringify(payload) }));
      if (current !== generation.current) return;
      setArtifact(payload); setPreview(prepared);
    } catch (reason) { if (current === generation.current) setError(reason instanceof SyntaxError || reason instanceof z.ZodError
      ? 'Arquivo inválido. Use um pacote JRC ou um JSON compatível. Subfluxos precisam estar incluídos no pacote.' : setupError(reason)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function importPackage() {
    if (!artifact || busy) return;
    const current = generation.current; intent.current ??= crypto.randomUUID(); setBusy(true); setError('');
    try {
      const result = parsePackage(organizationId, await client.request('/v1/automation-packages', { method: 'POST',
        headers: { 'Idempotency-Key': intent.current }, body: JSON.stringify(artifact) }));
      if (current !== generation.current) return;
      await onImported(result); if (current !== generation.current) return;
      intent.current = null; setArtifact(null); setPreview(null); if (fileInput.current) fileInput.current.value = '';
    } catch (reason) { if (current === generation.current) setError(setupError(reason)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  return <section className="panel"><h3>Importar robô</h3>
    <label>Arquivo do robô JSON<input ref={fileInput} type="file" accept="application/json,.json" disabled={busy} onChange={event => void readFile(event)} /></label>
    {busy && <p role="status">Conferindo arquivo…</p>}{error && <p role="alert">{error}</p>}
    {preview && <div><p>{preview.flows.length} fluxo(s), incluindo suas dependências. {preview.requirements.length} seleção(ões) de recursos locais.</p>
      <ul>{preview.flows.map(flow => <li key={flow.key}>{flow.name}</li>)}</ul>
      {legacy && <p>A conversão pode exigir revisão de blocos e vínculos antes de publicar.</p>}
      <p>A importação cria rascunhos nesta empresa. Publicar e ativar são etapas separadas.</p>
      <button className="button button--primary" disabled={busy} onClick={() => void importPackage()}>Importar rascunhos</button></div>}
  </section>;
}
