import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

import { CURRENT_AUDIT_PROFILE } from './audit-profile.mjs';

export function unexpectedPdfDiagnostics(stderr) {
  return stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    // The bundled Windows Poppler emits these two host-font lookup warnings
    // even for an ASCII-only PDFKit document; all other diagnostics fail.
    .filter((line) => ![
      "Syntax Error: No display font for 'Symbol'",
      "Syntax Error: No display font for 'ArialUnicode'",
    ].includes(line));
}

function run(command, arguments_, timeout = 30_000, rejectDiagnostics = false) {
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    windowsHide: true,
  });
  const unexpectedDiagnostics = unexpectedPdfDiagnostics(result.stderr ?? '');
  if (result.error || result.status !== 0 || (rejectDiagnostics && unexpectedDiagnostics.length > 0)) {
    throw new Error(`PDF verification command failed: ${command}`);
  }
  return result.stdout ?? '';
}

function extractPdfText(pdf) {
  const source = pdf.toString('latin1');
  return [...source.matchAll(/<([0-9a-f]+)>/giu)]
    .map((match) => Buffer.from(match[1], 'hex').toString('latin1'))
    .join('')
    .replaceAll('\x97', '—');
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid PNG raster');
  let width;
  let height;
  let channels;
  const compressed = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('Unsupported PNG raster format');
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[data[9]];
      if (!channels) throw new Error('Unsupported PNG color type');
    } else if (type === 'IDAT') compressed.push(data);
    offset += length + 12;
  }
  if (!width || !height || !channels || compressed.length === 0) throw new Error('Incomplete PNG raster');
  const raw = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[sourceOffset];
    sourceOffset += 1;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[sourceOffset + x];
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const above = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? above
            : filter === 3 ? Math.floor((left + above) / 2)
              : filter === 4 ? paeth(left, above, upperLeft)
                : Number.NaN;
      if (!Number.isFinite(predictor)) throw new Error('Unsupported PNG filter');
      pixels[y * stride + x] = (value + predictor) & 0xff;
    }
    sourceOffset += stride;
  }
  return { width, height, channels, pixels };
}

function pngInkInPointRegion(buffer, region) {
  const { width, height, channels, pixels } = decodePng(buffer);
  const x1 = Math.floor((region.x1 / 595.28) * width);
  const x2 = Math.ceil((region.x2 / 595.28) * width);
  const y1 = Math.floor((region.y1 / 841.89) * height);
  const y2 = Math.ceil((region.y2 / 841.89) * height);
  let ink = 0;
  const regionBytes = [];
  for (let y = Math.max(0, y1); y < Math.min(height, y2); y += 1) {
    for (let x = Math.max(0, x1); x < Math.min(width, x2); x += 1) {
      const offset = y * width * channels + x * channels;
      regionBytes.push(...pixels.subarray(offset, offset + Math.min(channels, 3)));
      if (pixels[offset] < 235 || pixels[offset + Math.min(1, channels - 1)] < 235 || pixels[offset + Math.min(2, channels - 1)] < 235) ink += 1;
    }
  }
  return { ink, fingerprint: createHash('sha256').update(Buffer.from(regionBytes)).digest('hex') };
}

export function classifyVisibleChrome(chromeInk, expectedChromePages) {
  if (chromeInk.length !== expectedChromePages.length) {
    throw new Error('PDF chrome raster count differs from the content page count');
  }
  if (chromeInk.length === 0) return { headerPages: [], footerPages: [] };
  if (chromeInk.some(({ header }) => !Number.isFinite(header) || header <= 0)) {
    throw new Error('PDF contains an empty rasterized header region');
  }
  if (chromeInk.some(({ footer }) => !Number.isFinite(footer) || footer <= 0)) {
    throw new Error('PDF contains an empty rasterized footer region');
  }
  if (new Set(chromeInk.map(({ headerFingerprint }) => headerFingerprint)).size !== 1) {
    throw new Error('PDF content pages do not share the same rasterized header');
  }
  const maximumHeaderInk = Math.max(...chromeInk.map(({ header }) => header));
  const maximumFooterInk = Math.max(...chromeInk.map(({ footer }) => footer));
  const headerPages = chromeInk
    .filter(({ header }) => header >= maximumHeaderInk * 0.85)
    .map(({ page }) => page);
  const footerPages = chromeInk
    .filter(({ footer }) => footer >= maximumFooterInk * 0.7)
    .map(({ page }) => page);
  if (headerPages.join(',') !== expectedChromePages.join(',')) {
    throw new Error('PDF header is missing from one or more content pages');
  }
  if (footerPages.join(',') !== expectedChromePages.join(',')) {
    throw new Error('PDF footer is missing or incomplete on one or more content pages');
  }
  return { headerPages, footerPages };
}

export async function verifySecurityAuditPdf({
  pdfPath,
  expectedPageCount,
  dpi = 150,
  expectedHeader = CURRENT_AUDIT_PROFILE.headerText,
}) {
  if (!Number.isInteger(expectedPageCount) || expectedPageCount < 1) throw new Error('expectedPageCount must be positive');
  if (!Number.isInteger(dpi) || dpi < 150) throw new Error('PDF raster verification requires at least 150 DPI');

  const rasterDirectory = await mkdtemp(join(tmpdir(), 'jrc-audit-raster-'));
  try {
    const info = run('pdfinfo', [pdfPath], 30_000, true);
    const pageCount = Number.parseInt(/^Pages:\s+(\d+)$/mu.exec(info)?.[1] ?? '', 10);
    if (pageCount !== expectedPageCount) throw new Error('PDF page count differs from the generated manifest');
    if (!/^Page size:\s+595\.28 x 841\.89 pts \(A4\)$/mu.test(info)) throw new Error('PDF page size is not A4');

    run('pdftoppm', ['-png', '-r', String(dpi), pdfPath, join(rasterDirectory, 'page')], 60_000, true);
    const rasters = (await readdir(rasterDirectory)).filter((name) => /^page-\d+\.png$/u.test(name)).sort();
    if (rasters.length !== pageCount) throw new Error('Rasterized page count differs from the PDF page count');
    for (const raster of rasters) {
      if ((await stat(join(rasterDirectory, raster))).size < 1_024) throw new Error('Rasterized PDF contains an empty page image');
    }

    const expectedChromePages = Array.from({ length: pageCount - 1 }, (_, index) => index + 2);
    const chromeInk = [];
    for (const [index, raster] of rasters.entries()) {
      if (index === 0) continue;
      const page = await readFile(join(rasterDirectory, raster));
      const header = pngInkInPointRegion(page, { x1: 45, x2: 555, y1: 20, y2: 48 });
      const footer = pngInkInPointRegion(page, { x1: 430, x2: 555, y1: 800, y2: 832 });
      chromeInk.push({
        page: index + 1,
        header: header.ink,
        headerFingerprint: header.fingerprint,
        footer: footer.ink,
      });
    }
    const extractedText = extractPdfText(await readFile(pdfPath));
    const headerCount = extractedText.split(expectedHeader).length - 1;
    const { headerPages, footerPages } = classifyVisibleChrome(chromeInk, expectedChromePages);
    if (headerCount !== pageCount - 1) throw new Error('PDF header text count differs from the content page count');
    for (const page of expectedChromePages) {
      if (!extractedText.includes(`Página ${page} de ${pageCount}`)) throw new Error('PDF footer text is incomplete');
    }
    return { pageCount, rasterizedPageCount: rasters.length, headerPages, footerPages, dpi };
  } finally {
    await rm(rasterDirectory, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const auditDirectory = resolve(process.cwd(), CURRENT_AUDIT_PROFILE.outputDirectory);
  const verification = JSON.parse(await readFile(resolve(auditDirectory, 'pdf-verification.json'), 'utf8'));
  const result = await verifySecurityAuditPdf({
    pdfPath: resolve(auditDirectory, 'relatorio-auditoria-seguranca.pdf'),
    expectedPageCount: verification.pageCount,
    dpi: verification.minimumRasterDpi,
    expectedHeader: verification.headerText,
  });
  process.stdout.write(`PDF verification: PASS (${result.pageCount} A4 pages rasterized at ${result.dpi} DPI)\n`);
}
