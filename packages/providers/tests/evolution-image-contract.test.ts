import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import { describe, expect, it, vi } from 'vitest';
import { EvolutionMessagingClient } from '../src/evolution/messaging.js';

const source = readFileSync(new URL('../../../upstream/evolution-api/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const sourceHash = 'd920d4fdd3cae90cb0369ad501774388388f28475135562f6977628efa913d0c';
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
// Codec and upload are ports: this test exercises the actual pinned formatter,
// without contacting WhatsApp or claiming a real codec/session homologation.
const encodedJpeg = Buffer.from('ffd8ffe000104a4649460001', 'hex');

function pinnedImageFormatter() {
  expect(createHash('sha256').update(source).digest('hex')).toBe(sourceHash);
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'decorators-legacy'] });
  const declaration = ast.program.body.find((node: any) => node.type === 'ExportNamedDeclaration'
    && node.declaration?.type === 'ClassDeclaration' && node.declaration.id?.name === 'BaileysStartupService') as any;
  const method = declaration?.declaration.body.body.find((node: any) => node.type === 'ClassMethod' && node.key.name === 'prepareMediaMessage');
  expect(method).toBeDefined();
  const code = stripTypeScriptTypes(`module.exports = class Formatter { ${source.slice(method.start, method.end)} }`);
  const module = { exports: undefined as any };
  vm.runInNewContext(code, {
    module, Buffer, isURL: () => false,
    sharp: () => ({ jpeg: () => ({ toBuffer: async () => encodedJpeg }) }),
    prepareWAMessageMedia: async (input: any) => {
      expect(input.image).toEqual(encodedJpeg);
      return { imageMessage: {} };
    },
    mimeTypes: { lookup: (name: string) => /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.png$/i.test(name) ? 'image/png' : false },
    generateWAMessageFromContent: (_to: string, message: unknown) => ({ message }),
    InternalServerErrorException: Error,
  });
  const formatter = new module.exports();
  formatter.client = { waUploadToServer: vi.fn() };
  formatter.instance = { wuid: 'synthetic-owner' };
  formatter.logger = { error: vi.fn() };
  return formatter;
}

describe('Broker image contract with the preserved Evolution formatter', () => {
  it('reproduces the extensionless filename overwriting JPEG MIME with false', async () => {
    const result = await pinnedImageFormatter().prepareMediaMessage({ mediatype: 'image', media: Buffer.from(png).toString('base64'), mimetype: 'image/png', fileName: 'anexo-7' });
    expect(result.message.imageMessage.mimetype).toBe('false');
  });

  it.each(['anexo-7', 'campanha.png', 'foto.jpeg', 'nome-com-extensao-desconhecida.bin'])('keeps the final JPEG MIME coherent for %s and preserves the caption', async (fileName) => {
    let body: any;
    const request = vi.fn(async (_url: unknown, options: any) => {
      body = JSON.parse(options.body);
      return Response.json({ key: { id: 'synthetic-image-accepted' } });
    });
    const client = new EvolutionMessagingClient({ baseUrl: 'https://engine.test', apiKey: 'synthetic-secret', instanceKey: 'synthetic-instance', fetch: request });
    await expect(client.sendMedia('15550000001', { kind: 'image', bytes: png, mimeType: 'image/png', fileName, caption: 'Texto + imagem' }))
      .resolves.toEqual({ status: 'ACCEPTED', upstreamMessageId: 'synthetic-image-accepted' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(Buffer.from(body.media, 'base64')).toEqual(Buffer.from(png));
    expect(body.mimetype).toBe('image/png');
    const result = await pinnedImageFormatter().prepareMediaMessage(body);
    expect(result.message.imageMessage).toMatchObject({ mimetype: 'image/jpeg', caption: 'Texto + imagem' });
  });

  it.each([
    { kind: 'document' as const, mimeType: 'application/pdf', fileName: 'contrato.pdf', bytes: Buffer.from('%PDF-1.7') },
    { kind: 'audio' as const, mimeType: 'audio/mpeg', fileName: 'audio.mp3', bytes: Buffer.from('ID3') },
    { kind: 'video' as const, mimeType: 'video/mp4', fileName: 'video.mp4', bytes: Buffer.from('synthetic-mp4') },
  ])('preserves filename and MIME of $kind', async (media) => {
    const request = vi.fn().mockResolvedValue(Response.json({ key: { id: 'synthetic-media' } }));
    const client = new EvolutionMessagingClient({ baseUrl: 'https://engine.test', apiKey: 'synthetic-secret', instanceKey: 'synthetic-instance', fetch: request });
    await client.sendMedia('15550000001', media);
    expect(JSON.parse(request.mock.calls[0]![1].body)).toMatchObject({ fileName: media.fileName, mimetype: media.mimeType, mediatype: media.kind });
  });

  it('does not retry an image when its remote outcome is uncertain', async () => {
    const request = vi.fn().mockRejectedValue(new Error('synthetic timeout'));
    const client = new EvolutionMessagingClient({ baseUrl: 'https://engine.test', apiKey: 'synthetic-secret', instanceKey: 'synthetic-instance', fetch: request });
    await expect(client.sendMedia('15550000001', { kind: 'image', bytes: png, mimeType: 'image/png', fileName: 'anexo-7' }))
      .rejects.toMatchObject({ code: 'QR_SEND_UNKNOWN' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
