import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { gateAuditData } from './audit-schema.mjs';
import { CURRENT_AUDIT_PROFILE } from './audit-profile.mjs';

const input = process.argv[2]
  ?? resolve(process.cwd(), CURRENT_AUDIT_PROFILE.outputDirectory, 'findings.json');
const data = JSON.parse(await readFile(input, 'utf8'));
const result = gateAuditData(data);
if (result.blocked) {
  process.stderr.write(`Security audit gate: BLOCKED (${result.blockingFindingIds.join(', ')})\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Security audit gate: PASS (no OPEN CRITICAL/HIGH findings)\n');
}
