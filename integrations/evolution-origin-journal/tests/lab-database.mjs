/** Test-only safety boundary, evaluated before any pool/database creation. */
export function validateTestAdminUrl(raw, nodeEnv = process.env.NODE_ENV) {
  if (nodeEnv === 'production' || !raw) throw new Error('Dedicated loopback TEST_DATABASE_ADMIN_URL required');
  let url;
  try { url = new URL(raw); } catch { throw new Error('Dedicated loopback TEST_DATABASE_ADMIN_URL required'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !/^(lab_|jrc_test_)[a-z0-9_]+$/u.test(url.pathname.slice(1))) throw new Error('Dedicated loopback TEST_DATABASE_ADMIN_URL required');
  return url;
}
