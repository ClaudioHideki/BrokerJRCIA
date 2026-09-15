import { readFile } from 'node:fs/promises';

export async function findUnpinnedImages(path) {
  const yaml = await readFile(path, 'utf8');

  return yaml
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('image:'))
    .map((line) => line.slice('image:'.length).trim())
    .filter((image) => !image.includes(':') || image.endsWith(':latest'));
}

if (process.argv[1]?.endsWith('check-compose-pins.mjs')) {
  const unpinned = await findUnpinnedImages(
    process.argv[2] ?? 'infra/baseline/compose.yaml'
  );

  if (unpinned.length) {
    console.error(JSON.stringify({ unpinned }, null, 2));
    process.exit(1);
  }

  console.log('Compose image pins are valid.');
}
