// Isolated synthetic source only. No HTTP acknowledgement is sent by this child.
import { Pool } from 'pg';
import { createOriginJournal } from '../src/journal.mjs';
import { validateTestAdminUrl } from './lab-database.mjs';

const input = JSON.parse(process.env.HISTORY_SOURCE_CRASH_FIXTURE);
const url = validateTestAdminUrl(process.env.HISTORY_SOURCE_CRASH_DATABASE);
const pool = new Pool({ connectionString: url.href, max: 1 });
const history = createOriginJournal({ pool, encryptionKey: Buffer.alloc(32, 93), history: { maxStagedBytes: 2000000 } }).history;
const snapshot = history.prepare(input.scope, input.run, input.events, { ...input.context, capturedAt: new Date(input.context.capturedAt) });
await history.append(snapshot);
process.stdout.write('COMMITTED\n');
setInterval(() => {}, 1000);
