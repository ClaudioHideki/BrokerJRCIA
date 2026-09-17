// Shared by the API and the final web server. No caller-supplied origin is trusted.
export function buildEmbedHeaders(approvedOrigin) {
  const url = new URL(approvedOrigin);
  if (url.protocol !== 'https:' || url.origin !== approvedOrigin || url.port ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/u.test(url.hostname)) {
    throw new Error('INVALID_EMBED_ORIGIN');
  }
  return {
    'Content-Security-Policy': `default-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'none'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${url.origin}`,
    'Cache-Control': 'no-store', 'Pragma': 'no-cache',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}
