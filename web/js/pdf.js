// Browser PDF renderer: the SAME report layout code that is tested in Node, with pdf-lib and fontkit
// loaded from their CDN <script> tags (globals PDFLib / fontkit) and the fonts fetched from this site.
import { renderWeeklyReportPdfCore } from './engine/weeklyReportPdfCore.js';

export function browserPdf() {
  let fonts = null;
  return {
    async render(report) {
      if (!window.PDFLib || !window.fontkit) throw new Error('The PDF library did not load. Check your internet connection and reload.');
      fonts ??= await Promise.all(['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf'].map(async (f) => {
        const res = await fetch(`assets/fonts/${f}`); if (!res.ok) throw new Error('Report fonts could not be loaded.');
        return new Uint8Array(await res.arrayBuffer());
      }));
      return renderWeeklyReportPdfCore(report, { PDFDocument: window.PDFLib.PDFDocument, rgb: window.PDFLib.rgb, fontkit: window.fontkit, regularBytes: fonts[0], boldBytes: fonts[1] });
    },
  };
}
