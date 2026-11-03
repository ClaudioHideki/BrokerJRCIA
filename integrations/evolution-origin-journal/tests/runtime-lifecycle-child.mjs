import { createServer, get } from 'node:http';
const lifecycle = await import('../src/runtime-lifecycle.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
// Baseline deliberately continues without the absent JRC lifecycle. The parent
// observes an interrupted HTTP request/no drain, not a module loader failure.
lifecycle.installRuntimeLifecycle?.({ deadlineMs: 700 });
const mode = process.argv[2], marks = [];
const resource = {};
lifecycle.registerRuntimeResource?.(resource, async () => {
  if (mode === 'failed') throw Error('SYNTHETIC_SECRET_MUST_NOT_LEAK');
  if (mode === 'hung') await new Promise(() => {});
  marks.push('RESOURCE_CLOSED');
});
const server = createServer((_req, res) => {
  process.send?.({ state: 'request_admitted' });
  setTimeout(() => { marks.push('RESPONSE_FINISHED'); res.end('committed-response'); }, 150);
});
lifecycle.registerRuntimeHttp?.(server);
server.listen(0, '127.0.0.1', () => {
  const request = get(`http://127.0.0.1:${server.address().port}/`, res => {
    res.resume(); res.on('end', () => process.send?.({ state: 'response', marks }));
  });
  request.on('error', () => {});
});
process.on('message', message => {
  if (message === 'signal') process.emit('SIGTERM');
  if (message === 'disconnect') process.disconnect();
});
process.on('exit', () => console.log(JSON.stringify({ marks })));
