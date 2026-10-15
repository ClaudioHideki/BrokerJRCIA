import { z } from 'zod';
import {
  ActionCatalogPageSchema, ActionResourceWriteSchema, AutomationMediaAssetSchema, AutomationResourceChannelsSchema,
  type ActionCatalogPage, type ActionResourceWrite, type AutomationMediaAsset,
} from '@jrc/contracts';
import { ApiClientError, type ApiClient } from '../api/client.js';

export interface ConversationActionTransport {
  readonly organizationId: string;
  readonly rootAutomationId: string;
  listChannels(signal?: AbortSignal): Promise<Array<{ id: string; name: string }>>;
  actionCatalog(channelId: string, signal?: AbortSignal): Promise<ActionCatalogPage>;
  mediaCatalog(channelId: string, signal?: AbortSignal): Promise<AutomationMediaAsset[]>;
  saveResource(channelId: string, input: ActionResourceWrite, signal?: AbortSignal): Promise<void>;
  uploadMedia(channelId: string, file: File, kind: AutomationMediaAsset['kind'], signal?: AbortSignal): Promise<AutomationMediaAsset>;
  revokeMedia(channelId: string, mediaId: string, revision: number, signal?: AbortSignal): Promise<void>;
}
const mediaPageSchema = z.strictObject({ schemaVersion: z.literal(1),
  scope: z.strictObject({ organizationId: z.uuid(), rootAutomationId: z.uuid(), channelId: z.uuid() }),
  data: z.array(AutomationMediaAssetSchema).max(200) });
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiClientError('O serviço retornou um catálogo inválido.', 502);
  return result.data;
}
function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
}
function addCursor(seen: Set<string>, cursor: string | null, count: number) {
  if (count > 10000 || cursor && seen.has(cursor)) throw new ApiClientError('Paginação de catálogo inválida.', 502);
  if (cursor) seen.add(cursor);
}

/** The caller supplies either the console client or the authorized native BFF
 * client. Every operation stays below this exact root; no global channel list. */
export function createConversationActionTransport(client: Pick<ApiClient, 'request'>,
  organizationId: string, rootAutomationId: string): ConversationActionTransport {
  z.uuid().parse(organizationId); z.uuid().parse(rootAutomationId);
  const base = `/v1/automations/${encodeURIComponent(rootAutomationId)}`;
  const path = (channelId: string) => `${base}/channels/${encodeURIComponent(z.uuid().parse(channelId))}`;
  const assertScope = (scope: { organizationId: string; rootAutomationId: string; channelId?: string }, channelId?: string) => {
    if (scope.organizationId !== organizationId || scope.rootAutomationId !== rootAutomationId ||
        channelId !== undefined && scope.channelId !== channelId) {
      throw new ApiClientError('O catálogo não corresponde à empresa, fluxo e caixa selecionados.', 409);
    }
  };
  return {
    organizationId, rootAutomationId,
    async listChannels(signal) {
      const rows: Array<{ id: string; name: string }> = [], ids = new Set<string>(), seen = new Set<string>();
      let cursor: string | null = null;
      do {
        aborted(signal);
        const query = new URLSearchParams({ pageSize: '200' }); if (cursor) query.set('cursor', cursor);
        const page = parsed(AutomationResourceChannelsSchema, await client.request(`${base}/resource-channels?${query}`, { signal: signal ?? null }));
        aborted(signal); assertScope(page.scope);
        for (const row of page.data) {
          if (ids.has(row.id)) throw new ApiClientError('O catálogo contém caixas duplicadas.', 502);
          ids.add(row.id); rows.push(row);
        }
        cursor = page.nextCursor; addCursor(seen, cursor, rows.length);
      } while (cursor);
      return rows;
    },
    async actionCatalog(channelId, signal) {
      const rows: ActionCatalogPage['data'] = [], ids = new Set<string>(), seen = new Set<string>();
      let cursor: string | null = null, first: ActionCatalogPage | undefined;
      do {
        aborted(signal);
        const query = new URLSearchParams({ pageSize: '200' }); if (cursor) query.set('cursor', cursor);
        const page = parsed(ActionCatalogPageSchema, await client.request(`${path(channelId)}/action-catalog?${query}`, { signal: signal ?? null }));
        aborted(signal); assertScope(page.scope, channelId);
        if (first && (first.profile !== page.profile || JSON.stringify(first.capabilities) !== JSON.stringify(page.capabilities))) {
          throw new ApiClientError('As capacidades da caixa mudaram. Atualize o catálogo.', 409);
        }
        first ??= page;
        for (const row of page.data) {
          if (ids.has(row.id)) throw new ApiClientError('O catálogo contém recursos duplicados.', 502);
          ids.add(row.id); rows.push(row);
        }
        cursor = page.nextCursor; addCursor(seen, cursor, rows.length);
      } while (cursor);
      return { ...first!, data: rows };
    },
    async mediaCatalog(channelId, signal) {
      aborted(signal);
      const page = parsed(mediaPageSchema, await client.request(`${path(channelId)}/media`, { signal: signal ?? null }));
      aborted(signal); assertScope(page.scope, channelId);
      const ids = new Set<string>();
      for (const asset of page.data) {
        assertScope(asset.scope, channelId);
        if (ids.has(asset.id)) throw new ApiClientError('O catálogo contém arquivos duplicados.', 502);
        ids.add(asset.id);
      }
      return page.data;
    },
    async saveResource(channelId, input, signal) {
      aborted(signal);
      const value = ActionResourceWriteSchema.parse(input);
      await client.request(`${path(channelId)}/action-resources`, { method: 'POST', signal: signal ?? null, body: JSON.stringify(value) });
      aborted(signal);
    },
    async uploadMedia(channelId, file, kind, signal) {
      aborted(signal);
      if (!file.size || file.size > 16777216) throw new ApiClientError('O arquivo deve ter entre 1 byte e 16 MiB; limites por tipo também se aplicam.', 413);
      if (!file.name.trim() || file.name.length > 120 || /[\u0000-\u001f\u007f\\/]/u.test(file.name) || !file.type) {
        throw new ApiClientError('Selecione um arquivo com tipo reconhecido e nome de até 120 caracteres.', 400);
      }
      const asset = parsed(AutomationMediaAssetSchema, await client.request(`${path(channelId)}/media`, {
        method: 'POST', signal: signal ?? null, body: file, headers: { 'Content-Type': 'application/octet-stream',
          'x-jrc-media-mime': file.type, 'x-jrc-media-kind': kind, 'x-jrc-media-name': encodeURIComponent(file.name),
          'idempotency-key': crypto.randomUUID() },
      }));
      aborted(signal); assertScope(asset.scope, channelId);
      if (asset.kind !== kind || asset.mimeType !== file.type || asset.byteSize !== file.size) {
        throw new ApiClientError('O recibo não corresponde ao arquivo enviado.', 502);
      }
      return asset;
    },
    async revokeMedia(channelId, mediaId, revision, signal) {
      aborted(signal);
      z.number().int().positive().parse(revision);
      await client.request(`${path(channelId)}/media/${encodeURIComponent(z.uuid().parse(mediaId))}/revoke`, {
        method: 'POST', signal: signal ?? null, body: JSON.stringify({ revision }), headers: { 'Idempotency-Key': crypto.randomUUID() },
      });
      aborted(signal);
    },
  };
}
