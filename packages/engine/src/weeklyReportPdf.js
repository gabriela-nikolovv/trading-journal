// Node entry point (tests + any server-side use): loads pdf-lib and the bundled
// Liberation Sans fonts, then delegates to the environment-neutral renderer.
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderWeeklyReportPdfCore } from './weeklyReportPdfCore.js';

const dir = dirname(fileURLToPath(import.meta.url));
const font = (n) => readFileSync(join(dir, '..', 'assets', 'fonts', n));

/** @param {ReturnType<typeof import('./weeklyReport.js').assembleWeeklyReportData>} report */
export function renderWeeklyReportPdf(report) {
  return renderWeeklyReportPdfCore(report, {
    PDFDocument, rgb, fontkit,
    regularBytes: font('LiberationSans-Regular.ttf'), boldBytes: font('LiberationSans-Bold.ttf'),
  });
}
