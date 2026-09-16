import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';

export type LoggerDestination = DestinationStream;

const REDACTED = '[REDACTED]';

const SENSITIVE_KEYS = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'body',
  'challenge',
  'cookie',
  'credential',
  'evolutionapikey',
  'jwt',
  'jwtsecret',
  'pairingcode',
  'password',
  'passwordhash',
  'phone',
  'phonenumber',
  'providercredential',
  'qrcode',
  'qr',
  'verifier',
  'response',
  'refreshtoken',
  'refreshtokenhashsecret',
  'secret',
  'selectiontoken',
  'selectiontokenhashsecret',
  'setcookie',
  'telephone',
  'token',
  'upstream',
  'upstreambody',
  'upstreamresponse',
  'xjrcapikey',
  'xcsrftoken',
]);

const normalizeKey = (key: string) => key.replaceAll(/[-_]/g, '').toLowerCase();

function errorForLog(error: unknown): Record<string, unknown> {
  if (error === null || typeof error !== 'object') {
    return { type: 'Error' };
  }

  const candidate = error as {
    name?: unknown;
    type?: unknown;
    code?: unknown;
    statusCode?: unknown;
  };
  return {
    type: typeof candidate.name === 'string'
      ? candidate.name
      : typeof candidate.type === 'string'
        ? candidate.type
        : 'Error',
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    ...(typeof candidate.statusCode === 'number' ? { statusCode: candidate.statusCode } : {}),
  };
}

function pathWithoutQuery(url: unknown): string | undefined {
  return typeof url === 'string' ? url.split('?', 1)[0] : undefined;
}

function requestForLog(request: unknown): Record<string, unknown> {
  if (request === null || typeof request !== 'object') {
    return {};
  }

  const candidate = request as {
    id?: unknown;
    method?: unknown;
    url?: unknown;
    ip?: unknown;
    remoteAddress?: unknown;
    raw?: { method?: unknown; url?: unknown; socket?: { remoteAddress?: unknown } };
  };
  const raw = candidate.raw;
  const url = pathWithoutQuery(candidate.url ?? raw?.url);

  return {
    ...(typeof candidate.id === 'string' || typeof candidate.id === 'number'
      ? { id: candidate.id }
      : {}),
    ...(typeof candidate.method === 'string' || typeof raw?.method === 'string'
      ? { method: candidate.method ?? raw?.method }
      : {}),
    ...(url === undefined ? {} : { url }),
    ...(typeof candidate.ip === 'string'
      ? { remoteAddress: candidate.ip }
      : typeof candidate.remoteAddress === 'string'
        ? { remoteAddress: candidate.remoteAddress }
        : typeof raw?.socket?.remoteAddress === 'string'
          ? { remoteAddress: raw.socket.remoteAddress }
          : {}),
  };
}

function responseForLog(response: unknown): Record<string, unknown> {
  if (response === null || typeof response !== 'object') {
    return {};
  }

  const candidate = response as { statusCode?: unknown };
  return typeof candidate.statusCode === 'number'
    ? { statusCode: candidate.statusCode }
    : {};
}

function sanitizeForLog(value: unknown, seen: WeakSet<object>): unknown {
  if (value instanceof Error) {
    return errorForLog(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, seen));
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  const sanitized = Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    const normalizedKey = normalizeKey(key);
    if (SENSITIVE_KEYS.has(normalizedKey)) {
      return [key, REDACTED];
    }
    if (normalizedKey === 'req' || normalizedKey === 'request') {
      return [key, requestForLog(entry)];
    }
    if (normalizedKey === 'res' || normalizedKey === 'reply') {
      return [key, responseForLog(entry)];
    }
    if (normalizedKey === 'err' || normalizedKey === 'error') {
      return [key, errorForLog(entry)];
    }
    return [key, sanitizeForLog(entry, seen)];
  }));

  seen.delete(value);
  return sanitized;
}

export function redactSensitive(value: unknown): unknown {
  return sanitizeForLog(value, new WeakSet());
}

export const REDACTION_PATHS = [
  'accessToken',
  'apikey',
  'authorization',
  'body',
  'challenge',
  'cookie',
  'credential',
  'jwt',
  'pairingCode',
  'password',
  'passwordHash',
  'phone',
  'phoneNumber',
  'qrCode',
  'refreshToken',
  'secret',
  'selectionToken',
  'token',
  'headers.authorization',
  'headers.cookie',
  'headers.apikey',
  'headers["set-cookie"]',
  'headers["x-csrf-token"]',
  'headers["x-jrc-api-key"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers["x-jrc-api-key"]',
  'res.headers["set-cookie"]',
  'upstream.body',
] as const;

export function createLoggerOptions(): LoggerOptions {
  return {
    level: 'info',
    redact: {
      paths: [...REDACTION_PATHS],
      censor: REDACTED,
    },
    serializers: {
      req(request: {
        id?: string;
        method?: string;
        url?: string;
        remoteAddress?: string;
      }) {
        return {
          id: request.id,
          method: request.method,
          url: pathWithoutQuery(request.url),
          remoteAddress: request.remoteAddress,
        };
      },
      res(reply: { statusCode?: number }) {
        return { statusCode: reply.statusCode };
      },
      err(error: Error & { code?: string }) {
        return errorForLog(error);
      },
    },
    hooks: {
      logMethod(args, method) {
        const sanitized = args.map((argument) => sanitizeForLog(argument, new WeakSet()));
        method.apply(this, sanitized as Parameters<typeof method>);
      },
    },
  };
}

export function createRedactedLogger(destination?: DestinationStream): Logger {
  return destination === undefined
    ? pino(createLoggerOptions())
    : pino(createLoggerOptions(), destination);
}
