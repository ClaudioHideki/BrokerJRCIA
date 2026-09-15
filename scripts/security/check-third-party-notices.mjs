import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BROWSER_DISTRIBUTED_PACKAGES = Object.freeze([
  'cookie',
  'react',
  'react-dom',
  'react-router',
  'scheduler',
  'set-cookie-parser',
  'zod',
]);

function normalize(value) {
  return value.replaceAll('\r\n', '\n').trim();
}

export function assertBundledNoticeMatches(source, bundled) {
  if (normalize(source) !== normalize(bundled)) {
    throw new Error('Bundled third-party notice differs from its source');
  }
}

async function loadInstalledLicense(rootDirectory, packageName) {
  const packageDirectory = resolve(rootDirectory, 'node_modules', packageName);
  const packageJson = JSON.parse(await readFile(resolve(packageDirectory, 'package.json'), 'utf8'));
  const licenseFile = (await readdir(packageDirectory))
    .filter((name) => /^LICENSE(?:\.|$)/iu.test(name))
    .sort()[0];
  if (!licenseFile) throw new Error(`Missing license file for distributed package: ${packageName}`);
  if (packageJson.license !== 'MIT') throw new Error(`Unexpected license for distributed package: ${packageName}`);
  return {
    marker: `${packageName}@${packageJson.version} (${packageJson.license})`,
    text: normalize(await readFile(resolve(packageDirectory, licenseFile), 'utf8')),
  };
}

export async function verifyThirdPartyNotices(
  rootDirectory = process.cwd(),
  { verifyBundle = true } = {},
) {
  const notice = normalize(await readFile(
    resolve(rootDirectory, 'apps/web/public/THIRD_PARTY_NOTICES.txt'),
    'utf8',
  ));
  for (const packageName of BROWSER_DISTRIBUTED_PACKAGES) {
    const license = await loadInstalledLicense(rootDirectory, packageName);
    const expected = normalize([
      `----- BEGIN PACKAGE ${license.marker} -----`,
      license.text,
      `----- END PACKAGE ${license.marker} -----`,
    ].join('\n'));
    if (!notice.includes(expected)) {
      throw new Error(`Incomplete third-party notice for distributed package: ${packageName}`);
    }
  }
  if (verifyBundle) {
    const bundledNotice = await readFile(
      resolve(rootDirectory, 'apps/web/dist/THIRD_PARTY_NOTICES.txt'),
      'utf8',
    );
    assertBundledNoticeMatches(notice, bundledNotice);
  }
  return { packageCount: BROWSER_DISTRIBUTED_PACKAGES.length };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const result = await verifyThirdPartyNotices();
  process.stdout.write(`Browser third-party notices: PASS (${result.packageCount} packages)\n`);
}
