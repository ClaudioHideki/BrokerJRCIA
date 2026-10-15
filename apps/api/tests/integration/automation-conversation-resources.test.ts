import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { createConversationResourceService, assertConversationResourcePolicies } from '../../src/modules/automations/conversation-resources.js';
import { createMediaStore } from '../../src/modules/messaging/media-store.js';

describe('private action resources scoped to the root and company', () => {
  let lab: Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async () => { lab = await attendanceDatabase(); }, 60000);
  afterAll(async () => { await lab?.dispose(); });
  async function setup() {
    const own = await seedAttendanceTenant(lab.database, false), other = await seedAttendanceTenant(lab.database, false);
    await lab.database.pool.query('insert into flow_features(organization_id,enabled) values($1,true),($2,true)', [own.org, other.org]);
    const second = randomUUID();
    await lab.database.pool.query(`insert into messaging_channels(id,organization_id,provider_account_id,phone_number_id,waba_id,credential_reference)
      select $1,organization_id,provider_account_id,$2,waba_id,credential_reference from messaging_channels where id=$3`,
    [second, 'synthetic-second', own.channel]);
    const media = createMediaStore({ encryptionKey: Buffer.alloc(32, 1).toString('base64'), transact: lab.transact,
      download: async () => { throw Error('NO_PROVIDER_DOWNLOAD'); }, maxStorageBytes: 128 });
    return { ...own, other, second, resources: createConversationResourceService({ transact: lab.transact, media }) };
  }

  it('lists only the company channels, applies root scope and refuses another company root', async () => {
    const t = await setup(), first = await t.resources.resourceChannels(t.org, t.automation, { pageSize: 1 });
    expect(first.scope).toEqual({ organizationId: t.org, rootAutomationId: t.automation });
    expect(first.data).toHaveLength(1); expect(first.nextCursor).not.toBeNull();
    const next = await t.resources.resourceChannels(t.org, t.automation, { pageSize: 1, cursor: first.nextCursor! });
    expect(new Set([...first.data, ...next.data].map(channel => channel.id))).toEqual(new Set([t.channel, t.second]));
    await expect(t.resources.resourceChannels(t.org, t.other.automation)).rejects.toMatchObject({ code: 'AUTOMATION_RESOURCE_SCOPE_UNAVAILABLE' });
    await lab.database.pool.query('update automation_definitions set delegation_scope_revision=1 where organization_id=$1 and id=$2', [t.org, t.automation]);
    expect((await t.resources.resourceChannels(t.org, t.automation)).data).toEqual([]);
  });

  it('pins a typed local attribute without accepting the same resource in another channel or company', async () => {
    const t = await setup();
    const attribute = await t.resources.saveResource(t.org, t.automation, t.channel, { name: 'Ativo', key: 'active', kind: 'ATTRIBUTE',
      definition: { valueType: 'boolean', maxLength: 8, allowedValues: [] }, status: 'ACTIVE' });
    const graph = { nodes: [{ id: 'attribute', type: 'attribute', label: 'Ativo', position: { x: 0, y: 0 },
      data: { conversationEffectVersion: 2, operation: 'attribute', channelId: t.channel, resourceId: attribute.id,
        resourceRevision: attribute.revision, valueSource: { kind: 'LITERAL', value: false }, target: 'result', timeoutMs: 10000 } }], edges: [] };
    await expect(lab.transact(t.org, tx => assertConversationResourcePolicies(tx, t.org, t.automation, [graph]))).resolves.toBeUndefined();
    for (const [org, root, channel] of [[t.org, t.automation, t.second], [t.other.org, t.other.automation, t.other.channel]]) {
      const changed = structuredClone(graph); changed.nodes[0]!.data.channelId = channel!;
      await expect(lab.transact(org!, tx => assertConversationResourcePolicies(tx, org!, root!, [changed]))).rejects.toThrow('AUTOMATION_RESOURCE_UNAVAILABLE');
    }
    expect((await t.resources.actionCatalog(t.org, t.automation, t.channel)).data[0]).toMatchObject({ name: 'Ativo', kind: 'ATTRIBUTE' });
  });

  it('uploads one encrypted private file, rejects a reused key with different bytes, and keeps revocation scoped', async () => {
    const t = await setup(), identity = randomUUID();
    const file = { bytes: new TextEncoder().encode('Documento de teste'), kind: 'document' as const,
      mimeType: 'text/plain', fileName: 'teste.txt', idempotencyKey: identity };
    const asset = await t.resources.uploadMedia(t.org, t.automation, t.channel, file);
    expect(asset).toMatchObject({ status: 'READY', name: 'teste.txt', byteSize: file.bytes.length,
      scope: { organizationId: t.org, rootAutomationId: t.automation, channelId: t.channel } });
    expect((await t.resources.uploadMedia(t.org, t.automation, t.channel, file)).id).toBe(asset.id);
    await expect(t.resources.uploadMedia(t.org, t.automation, t.channel, { ...file, bytes: new TextEncoder().encode('Outro') }))
      .rejects.toThrow('MEDIA_UPLOAD_IDEMPOTENCY_CONFLICT');
    await expect(t.resources.revokeMedia(t.org, t.automation, t.second, asset.id, 1)).rejects.toMatchObject({ code: 'AUTOMATION_MEDIA_CHANGED' });
    await t.resources.revokeMedia(t.org, t.automation, t.channel, asset.id, 1);
    expect((await t.resources.mediaCatalog(t.org, t.automation, t.channel)).data).toContainEqual(expect.objectContaining({ id: asset.id, status: 'REVOKED', revision: 2 }));
    const row = (await lab.database.pool.query('select encrypted_data from messaging_media where organization_id=$1 and channel_id=$2', [t.org, t.channel])).rows[0]!;
    expect(row.encrypted_data).not.toContain('Documento de teste');
  });

  it('enforces the existing private-storage quota before making a file selectable', async () => {
    const t = await setup();
    await expect(t.resources.uploadMedia(t.org, t.automation, t.channel, { bytes: new TextEncoder().encode('a'.repeat(129)),
      kind: 'document', mimeType: 'text/plain', fileName: 'grande.txt', idempotencyKey: randomUUID() }))
      .rejects.toThrow('MEDIA_STORAGE_LIMIT');
    expect((await t.resources.mediaCatalog(t.org, t.automation, t.channel)).data).toEqual([]);
  });
});
