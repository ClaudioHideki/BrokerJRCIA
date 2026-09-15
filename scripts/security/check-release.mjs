import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {buildRouteInventory} from './inventory-routes.mjs';
import {buildAuditSourceReference} from './generate-security-audit.mjs';
import {scanJrcHistory} from './scan-jrc-history.mjs';
import {scanCompiledBundle,scanForbiddenViteVariables} from './scan-compiled-bundle.mjs';
import {assertFingerprintSecret,sanitizedScanSummary} from './secret-scan-core.mjs';
import {gateAuditData} from './audit-schema.mjs';
import {CURRENT_AUDIT_PROFILE} from './audit-profile.mjs';

// Current automated evidence is separate from the immutable, manually scoped historical audit.
const rootDirectory=process.cwd(),fingerprintSecret=process.env.AUDIT_FINGERPRINT_SECRET;
assertFingerprintSecret(fingerprintSecret);
const openapi=JSON.parse(await readFile(resolve(rootDirectory,'docs/api/openapi.json'),'utf8'));
const historic=JSON.parse(await readFile(resolve(rootDirectory,CURRENT_AUDIT_PROFILE.outputDirectory,'findings.json'),'utf8'));
const [routes,history,bundle,vite]=await Promise.all([
  buildRouteInventory({rootDirectory,openapi}),
  scanJrcHistory({rootDirectory,fingerprintSecret}),
  scanCompiledBundle({rootDirectory,fingerprintSecret}),
  scanForbiddenViteVariables({rootDirectory}),
]);
const recordedGate=gateAuditData(historic);
const passed=routes.length>0&&!recordedGate.blocked&&!history.length&&!bundle.length&&!vite.length;
const report={
  kind:'AUTOMATED_RELEASE_CHECK',
  scope:'Current OpenAPI route policies, compiled bundles, Git history and forbidden browser environment variables. External deployment and provider validation excluded.',
  sourceReference:buildAuditSourceReference({rootDirectory}),
  passed,routeCount:routes.length,routes,
  recordedFindings:{source:CURRENT_AUDIT_PROFILE.outputDirectory,...recordedGate},
  scans:sanitizedScanSummary([
    {scanner:'JRC_GIT_HISTORY',excluded:['upstream/**'],findings:history},
    {scanner:'COMPILED_BUNDLE',excluded:['**/*.map','node_modules/**','upstream/**'],findings:bundle},
  ]),
  browserConfiguration:{findingCount:vite.length,findings:vite},
};
await mkdir(resolve(rootDirectory,'.sessions'),{recursive:true});
await writeFile(resolve(rootDirectory,'.sessions/security-release.json'),JSON.stringify(report,null,2)+'\n');
process.stdout.write(`Current release checks: ${passed?'PASS':'FAIL'} (${routes.length} routes, ${history.length+bundle.length+vite.length} scanner findings)\n`);
if(!passed)process.exitCode=1;
