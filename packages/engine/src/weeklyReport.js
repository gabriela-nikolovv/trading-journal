// Weekly Report data assembly (spec sections 26-30, 55).
//
// Three separate concerns, deliberately kept apart:
//  1. assembleWeeklyReportData  — combines what we CAN derive from the daily
//     Total Δ series with the PropReports-native fields that must be
//     supplied as-is (see project notes: Realized Net / BAT / W-L Ratio are
//     PropReports' own numbers, not something this app recomputes).
//  2. buildWeeklyCommentDraft   — turns that week's daily comments into a
//     suggested starting point for the "comment for this week" prompt.
//  3. applyManualOverrides      — layers presentation-only edits on top of
//     the computed data WITHOUT mutating it. This is the DATABASE TRUTH vs
//     REPORT PRESENTATION EDITS split from spec section 55: `baseData` is
//     what's stored/recomputed by the app, `overrides` is what the user
//     typed into the report just before export, and only the merged result
//     is ever handed to the PDF renderer.

import { computeWeeklyTotalDelta, computeAverageDailyDelta, computeUpDownDays, computeMaxDrawdown } from './reportTotals.js';

/**
 * @typedef {Object} ReportDay
 * @property {string} label      'Monday' etc.
 * @property {string} date       ISO date
 * @property {number} totalDelta
 * @property {number} accountValue
 */

/**
 * @typedef {Object} PropReportsNativeStats
 * @property {number} realizedNet
 * @property {number} quantity
 * @property {number} bat              fraction, e.g. 0.5 for 50%
 * @property {number} wlRatio
 * @property {number} avgSizeInPosition
 * @property {number} avgNetWinner
 * @property {number} avgNetLoser
 * @property {string} avgHoldTime      pre-formatted duration string, passed through
 * @property {number} biggestNetWinner
 * @property {number} biggestNetLoser
 */

/**
 * @param {Object} input
 * @param {string} input.accountName
 * @param {string} input.accountCode
 * @param {string} input.weekStart  ISO date (Monday)
 * @param {string} input.weekEnd    ISO date (Friday)
 * @param {ReportDay[]} input.days
 * @param {PropReportsNativeStats} input.propReportsNative
 * @param {string} [input.weeklyComment]
 */
export function assembleWeeklyReportData(input) {
  if (!input.days || input.days.length === 0) {
    throw new Error('assembleWeeklyReportData requires at least one trading day');
  }
  const totalDeltas = input.days.map((d) => d.totalDelta);
  const { up, down } = computeUpDownDays(totalDeltas);

  return {
    accountName: input.accountName,
    accountCode: input.accountCode,
    weekStart: input.weekStart,
    weekEnd: input.weekEnd,
    days: input.days,
    totals: {
      totalDeltaWeeklyPnl: computeWeeklyTotalDelta(totalDeltas),
      averageDailyDelta: computeAverageDailyDelta(totalDeltas),
      upDays: up,
      downDays: down,
      maxDrawdown: computeMaxDrawdown(totalDeltas),
    },
    propReportsNative: input.propReportsNative,
    weeklyComment: input.weeklyComment ?? '',
  };
}

/**
 * Builds the suggested weekly-comment text from that week's daily comments.
 * Only days that actually have a comment are included. Returns '' (an
 * empty, not fabricated, starting point) when nobody left any daily notes.
 * @param {{dayLabel:string, date:string, comment?:string}[]} dailyComments
 */
export function buildWeeklyCommentDraft(dailyComments) {
  const withComments = dailyComments.filter((d) => d.comment && d.comment.trim().length > 0);
  if (withComments.length === 0) return '';
  return withComments.map((d) => `${d.dayLabel}: ${d.comment.trim()}`).join('\n');
}

/**
 * Layers presentation-only edits over computed report data. Never mutates
 * `baseData` — the database truth stays exactly as computed; only the
 * returned object reflects the user's manual edits, and only that object
 * goes to the PDF renderer.
 * @param {ReturnType<typeof assembleWeeklyReportData>} baseData
 * @param {Partial<ReturnType<typeof assembleWeeklyReportData>>} overrides
 */
export function applyManualOverrides(baseData, overrides = {}) {
  return {
    ...baseData,
    ...overrides,
    totals: { ...baseData.totals, ...(overrides.totals ?? {}) },
    propReportsNative: { ...baseData.propReportsNative, ...(overrides.propReportsNative ?? {}) },
    days: overrides.days ?? baseData.days,
  };
}
