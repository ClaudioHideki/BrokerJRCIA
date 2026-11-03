import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBuildAdmission } from './entrypoint.mjs';
import { fileHash } from './artifacts.mjs';

// This is an internal IPC loader, not an ownership approval switch. The parent
// inventories every runtime file first; this process independently refuses
// capture/ownership drift and checks the exact admission receipt/main bytes.
if (process.argv.length !== 2 || typeof process.send !== 'function' || !process.connected) {
  console.error('ORIGIN_ENGINE_MAIN_REFUSED'); process.exitCode = 1;
} else {
  let refusing = false;
  process.once('disconnect', () => {
    if (!refusing) { console.error('ORIGIN_ENGINE_PARENT_LOST'); process.exit(1); }
  });
  process.on('message', message => {
    if (message?.kind === 'JRC_ENGINE_STOP_V1') {
      const signal = message.signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM';
      if (process.listenerCount(signal)) process.emit(signal);
      else process.exit(signal === 'SIGINT' ? 130 : 143);
    }
  });
  const admissionDeadline = setTimeout(() => { console.error('ORIGIN_ENGINE_MAIN_REFUSED'); process.exit(1); }, 5000);
  process.once('message', async message => {
    clearTimeout(admissionDeadline);
    try {
      if (message?.kind !== 'JRC_ENGINE_VERIFIED_START_V1') throw Error();
      async function verify() {
        const { receipt, receiptSha256 } = await readBuildAdmission(process.cwd(), process.env);
        if (receiptSha256 !== message.receiptSha256 || receipt.sourceManifestSha256 !== message.sourceManifestSha256 ||
          receipt.artifacts.find(file => file.path === 'dist/main.js')?.sha256 !== await fileHash(join(process.cwd(), 'dist/main.js'))) throw Error();
      }
      await verify();
      // The IPC channel must not keep a fully drained child alive. In Docker,
      // PID1 loss ends the entire namespace even while a synchronous import
      // prevents this JS disconnect handler from running.
      process.channel.unref();
      await import(pathToFileURL(join(process.cwd(), 'dist/main.js')).href);
    } catch {
      refusing = true;
      console.error(process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED === 'true' ? 'ORIGIN_ENGINE_OWNERSHIP_UNPROVEN' : 'ORIGIN_ENGINE_MAIN_REFUSED');
      process.exitCode = 1;
      if (process.connected) process.disconnect();
    }
  });
}
