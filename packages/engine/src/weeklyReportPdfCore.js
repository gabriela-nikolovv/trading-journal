// Renders a Weekly Report PDF that visually matches the supplied template
// as closely as technically possible (spec sections 29, 58).
//
// Every measurement below (margins, bar heights, row heights, the grid's
// row height, the color palette) was taken directly off the real template:
// rasterized at 200dpi and color-sampled pixel-by-pixel, not eyeballed. See
// project notes for the sampling method. Uses pdf-lib for precise, low-level
// control over boxes/tables/typography — not an HTML-to-PDF print — and
// pdf-lib runs unmodified under Deno (the eventual Edge Function target) via
// an `npm:pdf-lib` specifier.
//
// FONT NOTE: the template's "Δ" (U+0394) is outside the WinAnsi encoding
// that pdf-lib's built-in StandardFonts use, so those can't render it at
// all — an easy thing to miss until it throws on the very first draw call.
// We embed real TTF fonts (Liberation Sans — metrically compatible with
// Arial, SIL Open Font License, freely redistributable — license kept
// alongside it in assets/fonts/) via @pdf-lib/fontkit instead, which
// subsets proper Unicode glyphs and renders Δ correctly.

// FONTS: the report is set in Arial. In the browser the user's own installed Arial is embedded when the
// browser lets the page read installed fonts (Chrome / Edge, after a one-time permission prompt); otherwise
// Liberation Sans — metrically identical to Arial, so every line breaks at the same place — is used.
//
// pdf-lib, fontkit and the font bytes are INJECTED so the exact same renderer runs in Node (tests) and in the browser.
let PDFDocument, rgb, fontkit, COLOR;
import {
  formatDollarSigned,
  formatSignedParen,
  formatPercent,
  formatInteger,
  formatSignedParenPair,
  formatCountPair,
  signColor,
} from './format.js';

const PAGE_WIDTH = 612; // US Letter, matching the source template exactly
const PAGE_HEIGHT = 792;
const MARGIN = 36;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

function hex(r, g, b) {
  return rgb(r / 255, g / 255, b / 255);
}
function makeColors() {
  return {
    navy: hex(28, 45, 66), blue: hex(51, 102, 153), red: hex(192, 57, 43), green: hex(27, 135, 56),
    cardBg: hex(244, 246, 248), border: hex(224, 224, 224), body: hex(51, 51, 51), labelGray: hex(102, 102, 102),
    white: rgb(1, 1, 1),
  };
}

function colorFor(kind) {
  if (kind === 'positive') return COLOR.green;
  if (kind === 'negative') return COLOR.red;
  return COLOR.body;
}

/** Wrap `text` into lines that fit `maxWidth` at `size` using `font`'s real metrics. */
function wrapText(font, text, size, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawCenteredText(page, { font, size, color, text, x, width, baselineY }) {
  const textWidth = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: x + (width - textWidth) / 2, y: baselineY, size, font, color });
}

function drawRightAlignedText(page, { font, size, color, text, rightX, baselineY }) {
  const textWidth = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: rightX - textWidth, y: baselineY, size, font, color });
}


/**
 * @param {ReturnType<typeof import('./weeklyReport.js').assembleWeeklyReportData>} report
 * @returns {Promise<Uint8Array>}
 */
export async function renderWeeklyReportPdfCore(report, deps) {
  ({ PDFDocument, rgb, fontkit } = deps);
  COLOR = makeColors();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`${report.accountName || report.accountCode} — Weekly Trading Report — ${report.weekStart} to ${report.weekEnd}`);
  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

  const regular = await pdf.embedFont(deps.regularBytes, { subset: true });
  const bold = await pdf.embedFont(deps.boldBytes, { subset: true });

  /** Convert "distance from top of page" to pdf-lib's bottom-up Y. */
  const fromTop = (topOffset) => PAGE_HEIGHT - topOffset;

  // ---------------------------------------------------------------
  // Header block: name/account on the left, period/title on the right
  // ---------------------------------------------------------------
  page.drawText(report.accountName || '', {
    x: MARGIN,
    y: fromTop(60),
    size: 24,
    font: bold,
    color: COLOR.navy,
  });

  const periodLabel = 'Period: ';
  const periodValue = `${formatDateRange(report.weekStart, report.weekEnd)}`;
  const periodLabelWidth = bold.widthOfTextAtSize(periodLabel, 12);
  const periodValueWidth = regular.widthOfTextAtSize(periodValue, 12);
  const periodTotalWidth = periodLabelWidth + periodValueWidth;
  page.drawText(periodLabel, {
    x: MARGIN + CONTENT_WIDTH - periodTotalWidth,
    y: fromTop(46),
    size: 12,
    font: bold,
    color: COLOR.body,
  });
  page.drawText(periodValue, {
    x: MARGIN + CONTENT_WIDTH - periodValueWidth,
    y: fromTop(46),
    size: 12,
    font: regular,
    color: COLOR.body,
  });

  page.drawText(`Account: ${report.accountCode}`, {
    x: MARGIN,
    y: fromTop(80),
    size: 12,
    font: regular,
    color: COLOR.labelGray,
  });
  drawRightAlignedText(page, {
    font: regular,
    size: 13,
    color: COLOR.labelGray,
    text: 'Weekly Trading Report',
    rightX: MARGIN + CONTENT_WIDTH,
    baselineY: fromTop(80),
  });

  // ---------------------------------------------------------------
  // Day table: header row + Total Δ row + Account value row.
  // Everything 9 pt and centred; the first row and the first column bold.
  // ---------------------------------------------------------------
  const TABLE_SIZE = 9;
  const LABEL_COL_WIDTH = 84;
  const dayColWidth = (CONTENT_WIDTH - LABEL_COL_WIDTH) / 5;
  const tableTop = 106;
  const headerHeight = 24;
  const rowHeight = 26;
  const colX = (i) => MARGIN + (i === 0 ? 0 : LABEL_COL_WIDTH + (i - 1) * dayColWidth);
  const colW = (i) => (i === 0 ? LABEL_COL_WIDTH : dayColWidth);
  const mid = (top, height) => fromTop(top + height / 2 + TABLE_SIZE * 0.35);

  page.drawRectangle({ x: MARGIN, y: fromTop(tableTop + headerHeight), width: CONTENT_WIDTH, height: headerHeight, color: COLOR.blue });
  ['Day', ...report.days.map((d) => d.label)].forEach((label, i) => {
    drawCenteredText(page, { font: bold, size: TABLE_SIZE, color: COLOR.white, text: label, x: colX(i), width: colW(i), baselineY: mid(tableTop, headerHeight) });
  });

  const rows = [
    { label: 'Total Δ', values: report.days.map((d) => d.totalDelta), colorize: true },
    { label: 'Account value', values: report.days.map((d) => d.accountValue), colorize: false },
  ];
  rows.forEach((row, rowIndex) => {
    const rowTop = tableTop + headerHeight + rowIndex * rowHeight;
    drawCenteredText(page, { font: bold, size: TABLE_SIZE, color: COLOR.body, text: row.label, x: colX(0), width: colW(0), baselineY: mid(rowTop, rowHeight) });
    row.values.forEach((value, i) => {
      const color = row.colorize ? colorFor(signColor(value)) : COLOR.body;
      drawCenteredText(page, { font: regular, size: TABLE_SIZE, color, text: formatSignedParen(value), x: colX(i + 1), width: colW(i + 1), baselineY: mid(rowTop, rowHeight) });
    });
  });

  const tableBottom = tableTop + headerHeight + rowHeight * 2;
  strokeGrid(page, {
    x: MARGIN, topY: tableTop, bottomY: tableBottom,
    colWidths: [LABEL_COL_WIDTH, ...Array(5).fill(dayColWidth)],
    rowHeights: [headerHeight, rowHeight, rowHeight], fromTop,
  });

  // ---------------------------------------------------------------
  // PERFORMANCE banner — set apart from the day table so it reads as its own table
  // ---------------------------------------------------------------
  const TABLE_GAP = 16;
  const bannerTop = tableBottom + TABLE_GAP;
  const bannerHeight = 26;
  page.drawRectangle({
    x: MARGIN,
    y: fromTop(bannerTop + bannerHeight),
    width: CONTENT_WIDTH,
    height: bannerHeight,
    color: COLOR.blue,
  });
  page.drawText('PERFORMANCE', {
    x: MARGIN + 10,
    y: fromTop(bannerTop + bannerHeight / 2 + 4),
    size: 12,
    font: bold,
    color: COLOR.white,
  });

  // ---------------------------------------------------------------
  // Performance grid: 3 rows x 4 columns
  // ---------------------------------------------------------------
  const t = report.totals;
  const p = report.propReportsNative;
  const gridTop = bannerTop + bannerHeight + 13;
  const gridRowHeight = 55;
  const gridColWidth = CONTENT_WIDTH / 4;

  const cells = [
    [
      { lines: ['TOTAL Δ (Weekly P&L)'], value: formatDollarSigned(t.totalDeltaWeeklyPnl), color: colorFor(signColor(t.totalDeltaWeeklyPnl)) },
      { lines: ['REALIZED NET'], value: formatDollarSigned(p.realizedNet), color: colorFor(signColor(p.realizedNet)) },
      { lines: ['QUANTITY'], value: formatInteger(p.quantity), color: COLOR.body },
      { lines: ['UP / DOWN DAYS'], value: formatCountPair(t.upDays, t.downDays), color: COLOR.body },
    ],
    [
      { lines: ['BAT'], value: formatPercent(p.bat), color: COLOR.body },
      { lines: ['W/L RATIO'], value: formatSignedParen(p.wlRatio), color: COLOR.body },
      { lines: ['AVG SIZE IN POSITION'], value: formatInteger(p.avgSizeInPosition), color: COLOR.body },
      { lines: ['AVG NET WINNER /', 'AVG NET LOSER'], value: formatSignedParenPair(p.avgNetWinner, p.avgNetLoser), color: COLOR.body },
    ],
    [
      { lines: ['MAX DRAWDOWN'], value: formatSignedParen(t.maxDrawdown), color: COLOR.body },
      { lines: ['AVERAGE DAILY Δ'], value: formatSignedParen(t.averageDailyDelta), color: COLOR.body },
      { lines: ['AVG HOLD TIME'], value: p.avgHoldTime, color: COLOR.body },
      { lines: ['BIGGEST NET WINNER /', 'BIGGEST NET LOSER'], value: formatSignedParenPair(p.biggestNetWinner, p.biggestNetLoser), color: COLOR.body },
    ],
  ];

  page.drawRectangle({
    x: MARGIN,
    y: fromTop(gridTop + gridRowHeight * 3),
    width: CONTENT_WIDTH,
    height: gridRowHeight * 3,
    color: COLOR.cardBg,
  });

  // Labels 8 pt, figures 15 pt bold. Every figure in a row sits on the same line, even when a
  // neighbouring label wraps onto two lines.
  const LABEL_SIZE = 8, VALUE_SIZE = 15;
  cells.forEach((rowCells, rowIndex) => {
    const rowLines = Math.max(...rowCells.map((c) => c.lines.length));
    rowCells.forEach((cell, colIndex) => {
      const cellX = MARGIN + colIndex * gridColWidth;
      const cellTop = gridTop + rowIndex * gridRowHeight;
      const labelBaseline = fromTop(cellTop + 20);
      cell.lines.forEach((line, li) => {
        page.drawText(line, {
          x: cellX + 12,
          y: labelBaseline - li * 10,
          size: LABEL_SIZE,
          font: bold,
          color: COLOR.labelGray,
        });
      });
      const valueBaseline = fromTop(cellTop + (rowLines > 1 ? 45 : 40));
      page.drawText(String(cell.value ?? ''), {
        x: cellX + 12,
        y: valueBaseline,
        size: VALUE_SIZE,
        font: bold,
        color: cell.color,
      });
    });
  });

  strokeGrid(page, {
    x: MARGIN,
    topY: gridTop,
    bottomY: gridTop + gridRowHeight * 3,
    colWidths: Array(4).fill(gridColWidth),
    rowHeights: Array(3).fill(gridRowHeight),
    fromTop,
  });

  // ---------------------------------------------------------------
  // Comment box: label row + wrapped comment text, height grows to fit
  // ---------------------------------------------------------------
  const commentTop = gridTop + gridRowHeight * 3 + 15;
  const commentLabelHeight = 20;
  const commentPadding = 10;
  const commentFontSize = 9;
  const commentLineHeight = 11.5;
  const commentLines = wrapText(bold, report.weeklyComment || '', commentFontSize, CONTENT_WIDTH - commentPadding * 2);
  const commentTextHeight = Math.max(commentLines.length, 1) * commentLineHeight + commentPadding * 2;

  page.drawText('COMMENT:', {
    x: MARGIN + 8,
    y: fromTop(commentTop + commentLabelHeight / 2 + 3),
    size: 9,
    font: bold,
    color: COLOR.body,
  });

  commentLines.forEach((line, i) => {
    page.drawText(line, {
      x: MARGIN + commentPadding,
      y: fromTop(commentTop + commentLabelHeight + commentPadding + (i + 1) * commentLineHeight - 3),
      size: commentFontSize,
      font: bold,
      color: COLOR.body,
    });
  });

  strokeGrid(page, {
    x: MARGIN,
    topY: commentTop,
    bottomY: commentTop + commentLabelHeight + commentTextHeight,
    colWidths: [CONTENT_WIDTH],
    rowHeights: [commentLabelHeight, commentTextHeight],
    fromTop,
  });

  return pdf.save();
}

/** Draws an outer border plus internal row/column divider lines for a grid region. */
function strokeGrid(page, { x, topY, bottomY, colWidths, rowHeights, fromTop }) {
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  const lineColor = COLOR.border;
  const thickness = 0.75;

  // Horizontal lines (top, between rows, bottom)
  let runningTop = topY;
  page.drawLine({ start: { x, y: fromTop(runningTop) }, end: { x: x + totalWidth, y: fromTop(runningTop) }, thickness, color: lineColor });
  for (const h of rowHeights) {
    runningTop += h;
    page.drawLine({ start: { x, y: fromTop(runningTop) }, end: { x: x + totalWidth, y: fromTop(runningTop) }, thickness, color: lineColor });
  }

  // Vertical lines (left, between columns, right)
  let runningX = x;
  page.drawLine({ start: { x: runningX, y: fromTop(topY) }, end: { x: runningX, y: fromTop(bottomY) }, thickness, color: lineColor });
  for (const w of colWidths) {
    runningX += w;
    page.drawLine({ start: { x: runningX, y: fromTop(topY) }, end: { x: runningX, y: fromTop(bottomY) }, thickness, color: lineColor });
  }
}

function formatDateRange(startIso, endIso) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const opts = { month: 'short', day: '2-digit' };
  const startStr = start.toLocaleDateString('en-US', opts);
  const endStr = end.toLocaleDateString('en-US', { ...opts, year: 'numeric' });
  return `${startStr} \u2013 ${endStr}`;
}
