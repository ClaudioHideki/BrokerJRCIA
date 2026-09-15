import { describe, expect, it } from 'vitest';

import {
  parseBrowserCookieHeader,
  resolveBrowserCookiePolicy,
} from '../src/index.js';

describe('cookies da sessão de navegador', () => {
  it('usa cookies __Host seguros e sem Domain em produção HTTPS', () => {
    const policy = resolveBrowserCookiePolicy({ nodeEnv: 'production', secure: true });

    expect(policy).toEqual({
      refresh: {
        name: '__Host-jrc_refresh',
        options: {
          httpOnly: true,
          secure: true,
          sameSite: 'strict',
          path: '/',
        },
      },
      csrf: {
        name: '__Host-jrc_csrf',
        options: {
          httpOnly: false,
          secure: true,
          sameSite: 'strict',
          path: '/',
        },
      },
    });
    expect(policy.refresh.options).not.toHaveProperty('domain');
    expect(policy.csrf.options).not.toHaveProperty('domain');
  });

  it('usa nomes sem __Host e Secure=false no HTTP local de desenvolvimento', () => {
    const policy = resolveBrowserCookiePolicy({ nodeEnv: 'development', secure: false });

    expect(policy.refresh).toMatchObject({
      name: 'jrc_refresh',
      options: { httpOnly: true, secure: false },
    });
    expect(policy.csrf).toMatchObject({
      name: 'jrc_csrf',
      options: { httpOnly: false, secure: false },
    });
  });

  it('recusa a exceção HTTP de desenvolvimento em produção', () => {
    expect(() => resolveBrowserCookiePolicy({ nodeEnv: 'production', secure: false }))
      .toThrow('Production browser cookies require HTTPS');
  });

  it('interpreta os cookies pelos nomes da política ativa', () => {
    const policy = resolveBrowserCookiePolicy({ nodeEnv: 'development', secure: false });

    expect(parseBrowserCookieHeader(
      'other=value; jrc_refresh=refresh-value; jrc_csrf=csrf-value',
      policy,
    )).toEqual({ refreshToken: 'refresh-value', csrfToken: 'csrf-value' });
  });
});
