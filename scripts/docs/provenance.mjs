import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sourceTextHash } from './source-hash.mjs';

export async function documentationProvenance() {
  const files = { canonicalSha256: '../../docs/api/openapi.json', guideSha256: './operation-guide.mjs',
    profilesSha256: './public-api.mjs', exporterSha256: './export-guide.mjs', pdfGeneratorSha256: './generate-partner-pdf.py' };
  return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, path]) =>
    [key, sourceTextHash(await readFile(new URL(path, import.meta.url)))])));
}
export function verifyPdfProvenance(manifest, sources, pdf, operationCount) {
  if (Object.entries(sources).some(([key, value]) => manifest[key] !== value) || manifest.operationCount !== operationCount ||
    manifest.pdfSha256 !== createHash('sha256').update(pdf).digest('hex')) throw new Error('PUBLIC_DOCUMENT_PDF_STALE_REGENERATE');
}
