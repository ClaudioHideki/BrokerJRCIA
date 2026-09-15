import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_COMMIT = 'fa09d37892cdbb1d65a250155d293d92230c5b30';
const EXPECTED_REMOTE = 'https://github.com/evolution-foundation/evolution-api.git';
const SUBMODULE_PATH = 'upstream/evolution-api';

function git(arguments_, cwd) {
  return execFileSync('git', ['-c', `safe.directory=${cwd.replaceAll('\\', '/')}`, ...arguments_], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  }).trim();
}

export function hasDivergentNestedSubmodule(status) {
  return status.split(/\r?\n/u).filter(Boolean).some((line) => /^[+U-]/u.test(line));
}

export async function checkSubmodule(rootDirectory = process.cwd()) {
  const gitmodules = await readFile(resolve(rootDirectory, '.gitmodules'), 'utf8');
  if (!gitmodules.includes(`url = ${EXPECTED_REMOTE}`)) {
    throw new Error('Evolution submodule remote is not the approved official repository');
  }

  const staged = git(['ls-files', '--stage', '--', SUBMODULE_PATH], rootDirectory).split(/\s+/u);
  if (staged[0] !== '160000' || staged[1] !== EXPECTED_COMMIT) {
    throw new Error('Evolution submodule gitlink differs from the approved commit');
  }
  const checkout = git(['rev-parse', 'HEAD'], resolve(rootDirectory, SUBMODULE_PATH));
  if (checkout !== EXPECTED_COMMIT) {
    throw new Error('Evolution submodule checkout differs from the approved commit');
  }
  const submoduleDirectory = resolve(rootDirectory, SUBMODULE_PATH);
  const status = git(['status', '--porcelain', '--ignore-submodules=none'], submoduleDirectory);
  if (status !== '') throw new Error('Evolution submodule has local modifications');
  const nestedStatus = git(['submodule', 'status', '--recursive'], submoduleDirectory);
  if (hasDivergentNestedSubmodule(nestedStatus)) {
    throw new Error('Evolution nested submodule checkout differs from its approved gitlink');
  }
  return { commit: EXPECTED_COMMIT, remote: EXPECTED_REMOTE };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  await checkSubmodule();
  process.stdout.write(`Evolution submodule boundary: PASS (${EXPECTED_COMMIT})\n`);
}
