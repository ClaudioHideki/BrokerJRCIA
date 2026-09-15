import { expect, it } from 'vitest';
import { handlerLine } from '../scripts/security/inventory-routes.mjs';

it('encontra rota multilinha sem confundir comentário ou outro método', () => {
  const source = [
    "// app.get('/v1/organization/overview', ignored)",
    "app.post('/v1/organization/overview', other);",
    'app.withTypeProvider<ZodTypeProvider>().get(',
    "  '/v1/organization/overview',",
    '  {}, async () => ({}));',
  ].join('\n');
  expect(handlerLine(source, 'GET', '/v1/organization/overview')).toBe(3);
});

it('normaliza parâmetros e prefixo da administração', () => {
  expect(handlerLine("scope.get('/organizations/:id/monitor', {}, fn)", 'GET', '/v1/platform/organizations/{id}/monitor')).toBe(1);
  expect(() => handlerLine("// app.get('/missing', fn)", 'GET', '/missing')).toThrow('Route handler not found');
});
