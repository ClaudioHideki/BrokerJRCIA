import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';

const upstreamCommit = 'fa09d37892cdbb1d65a250155d293d92230c5b30';
const officialRepository = 'https://github.com/evolution-foundation/evolution-api.git';

const requiredPaths = [
  '.gitmodules',
  'upstream/evolution-api/LICENSE',
  'upstream/evolution-api/NOTICE',
  'upstream/evolution-api/TRADEMARKS.md',
  'docs/legal/evolution/UPSTREAM.md',
  'docs/legal/evolution/USAGE-NOTICE.md'
];

export async function checkEvolutionUpstream(root) {
  const missing = [];

  for (const path of requiredPaths) {
    try {
      await access(join(root, path), constants.F_OK);
    } catch {
      missing.push(path);
    }
  }

  const gitmodules = missing.includes('.gitmodules')
    ? ''
    : await readFile(join(root, '.gitmodules'), 'utf8');
  const record = missing.includes('docs/legal/evolution/UPSTREAM.md')
    ? ''
    : await readFile(join(root, 'docs/legal/evolution/UPSTREAM.md'), 'utf8');
  const usageNotice = missing.includes('docs/legal/evolution/USAGE-NOTICE.md')
    ? ''
    : await readFile(join(root, 'docs/legal/evolution/USAGE-NOTICE.md'), 'utf8');

  let stagedEntry = '';
  try {
    const safeRoot = resolve(root).replaceAll('\\', '/');
    stagedEntry = execFileSync(
      'git',
      ['-c', `safe.directory=${safeRoot}`, 'ls-files', '--stage', 'upstream/evolution-api'],
      { cwd: root, encoding: 'utf8' }
    );
  } catch {
    stagedEntry = '';
  }

  return {
    missing,
    usesOfficialRepository:
      gitmodules.includes(officialRepository) && record.includes(officialRepository),
    commitIsPinned: record.includes(upstreamCommit),
    isPinnedGitlink: stagedEntry.startsWith(`160000 ${upstreamCommit} `),
    hasAdminUsageNotice:
      /utiliza componentes.*Evolution API/is.test(usageNotice) &&
      /administradores/is.test(usageNotice)
  };
}

if (process.argv[1]?.endsWith('check-evolution-upstream.mjs')) {
  const result = await checkEvolutionUpstream(process.cwd());

  if (
    result.missing.length ||
    !result.usesOfficialRepository ||
    !result.commitIsPinned ||
    !result.isPinnedGitlink ||
    !result.hasAdminUsageNotice
  ) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  console.log('Evolution upstream baseline is valid.');
}
