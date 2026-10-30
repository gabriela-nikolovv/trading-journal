// Browser PDF renderer: the SAME report layout code that is tested in Node, with pdf-lib and fontkit
// loaded from their CDN <script> tags (globals PDFLib / fontkit).
//
// FONT: the report is set in Arial. Arial cannot be shipped with the website (it is licensed with
// Windows / macOS), but the browser can hand the page the copy installed on this computer:
// Chrome and Edge ask once ("allow this site to use fonts on your device?"). If that is not available
// or not allowed, Liberation Sans is used — it has exactly Arial's letter widths, so the layout is identical.
import { renderWeeklyReportPdfCore } from './engine/weeklyReportPdfCore.js';

async function installedArial() {
  if (typeof window.queryLocalFonts !== 'function') return null;
  const fonts = await window.queryLocalFonts({ postscriptNames: ['ArialMT', 'Arial-BoldMT'] });
  const pick = async (ps) => {
    const f = fonts.find((x) => x.postscriptName === ps);
    if (!f) return null;
    const bytes = new Uint8Array(await (await f.blob()).arrayBuffer());
    const parsed = window.fontkit.create(bytes);
    return parsed && typeof parsed.glyphForCodePoint === 'function' && parsed.hasGlyphForCodePoint?.(0x394) !== false ? bytes : null; // a single font that has Δ
  };
  const [regular, bold] = await Promise.all([pick('ArialMT'), pick('Arial-BoldMT')]);
  return regular && bold ? [regular, bold] : null;
}

export function browserPdf() {
  let fonts = null, fontName = null, arialAsked = null;
  const bundled = async () => Promise.all(['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf'].map(async (f) => {
    const res = await fetch(`assets/fonts/${f}`); if (!res.ok) throw new Error('Report fonts could not be loaded.');
    return new Uint8Array(await res.arrayBuffer());
  }));
  return {
    /** Call straight from a click: the browser only shows its font permission prompt for a user action. */
    prepareFonts() {
      if (!arialAsked && window.fontkit) arialAsked = installedArial().catch(() => null);
      return arialAsked;
    },
    get fontName() { return fontName; },
    async render(report) {
      if (!window.PDFLib || !window.fontkit) throw new Error('The PDF library did not load. Check your internet connection and reload.');
      if (!fonts) {
        const arial = await (arialAsked ?? Promise.resolve(null));
        if (arial) { fonts = arial; fontName = 'Arial'; }
        else { fonts = await bundled(); fontName = 'Liberation Sans (same letter widths as Arial)'; }
      }
      try {
        return await renderWeeklyReportPdfCore(report, { PDFDocument: window.PDFLib.PDFDocument, rgb: window.PDFLib.rgb, fontkit: window.fontkit, regularBytes: fonts[0], boldBytes: fonts[1] });
      } catch (e) {
        if (fontName !== 'Arial') throw e;
        fonts = await bundled(); fontName = 'Liberation Sans (same letter widths as Arial)'; // installed Arial could not be embedded
        return renderWeeklyReportPdfCore(report, { PDFDocument: window.PDFLib.PDFDocument, rgb: window.PDFLib.rgb, fontkit: window.fontkit, regularBytes: fonts[0], boldBytes: fonts[1] });
      }
    },
  };
}
