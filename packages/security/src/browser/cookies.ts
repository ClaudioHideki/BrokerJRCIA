import fastifyCookie from '@fastify/cookie';

const parseCookie = (fastifyCookie as typeof fastifyCookie & {
  parse(header: string): Record<string, string | undefined>;
}).parse;

export type BrowserNodeEnvironment = 'development' | 'test' | 'production';

export interface BrowserCookieOptions {
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: 'strict';
  readonly path: '/';
}

export interface BrowserCookiePolicy {
  readonly refresh: { readonly name: string; readonly options: BrowserCookieOptions };
  readonly csrf: { readonly name: string; readonly options: BrowserCookieOptions };
}

export function resolveBrowserCookiePolicy(input: {
  nodeEnv: BrowserNodeEnvironment;
  secure: boolean;
}): BrowserCookiePolicy {
  if (input.nodeEnv === 'production' && !input.secure) {
    throw new Error('Production browser cookies require HTTPS');
  }

  const prefix = input.secure ? '__Host-' : '';
  const shared = {
    secure: input.secure,
    sameSite: 'strict' as const,
    path: '/' as const,
  };
  return {
    refresh: {
      name: `${prefix}jrc_refresh`,
      options: { ...shared, httpOnly: true },
    },
    csrf: {
      name: `${prefix}jrc_csrf`,
      options: { ...shared, httpOnly: false },
    },
  };
}

export function parseBrowserCookieHeader(
  header: string | undefined,
  policy: BrowserCookiePolicy,
): { refreshToken: string | null; csrfToken: string | null } {
  const cookies = header === undefined ? {} : parseCookie(header);
  return {
    refreshToken: cookies[policy.refresh.name] ?? null,
    csrfToken: cookies[policy.csrf.name] ?? null,
  };
}
