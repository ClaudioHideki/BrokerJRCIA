import { expect, it } from 'vitest';
import { buildEmbedHeaders } from '../../src/modules/integrations/embed/frame-policy.js';

it('restricts the ancestor without allowing the console or conflicting XFO', () => {
  const h = buildEmbedHeaders('https://client.example.com');
  expect(h['Content-Security-Policy']).toContain('frame-ancestors https://client.example.com');
  expect(h['Content-Security-Policy']).toContain("frame-src 'none'");
  expect(h['Content-Security-Policy']).toContain("connect-src 'self'");
  expect(h['Content-Security-Policy']).not.toContain('facebook');
  expect(h['X-Frame-Options']).toBeUndefined();
  expect(h['Cache-Control']).toBe('no-store');
});
it.each(['*', 'https://*.example.com', 'http://client.example.com', 'https://client.example.com/path',
  'https://client.example.com?origin=*', 'https://user@client.example.com', 'https://client.example.com#x',
  'https://client.example.com; frame-ancestors *', 'https://client.example.com\r\nX-Test: unsafe',
  'https://client.example.com:444', 'https://client.example.com/'])('refuses unapproved origin syntax: %s', origin => {
  expect(() => buildEmbedHeaders(origin)).toThrow();
});
