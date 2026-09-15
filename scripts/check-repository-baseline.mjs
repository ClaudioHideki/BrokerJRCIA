import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const required = [
  'README.md',
  'AGENTS.md',
  '.gitignore',
  '.env.example',
  'docs/architecture/system-boundaries.md'
];

const forbiddenPatterns = [
  /^\.env$/,
  /\.sessions?(\/|$)/,
  /auth[_-]?state/i,
  /credentials?\.json$/i
];

export async function validateRepositoryBaseline(root) {
  const missing = [];

  for (const file of required) {
    try {
      await access(join(root, file), constants.F_OK);
    } catch {
      missing.push(file);
    }
  }

  let tracked = [];
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    tracked = [];
  }

  const forbiddenTrackedFiles = tracked.filter((file) =>
    forbiddenPatterns.some((pattern) => pattern.test(file))
  );

  return { missing, forbiddenTrackedFiles };
}

if (process.argv[1]?.endsWith('check-repository-baseline.mjs')) {
  const result = await validateRepositoryBaseline(process.cwd());

  if (result.missing.length || result.forbiddenTrackedFiles.length) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  console.log('Repository baseline is valid.');
}
