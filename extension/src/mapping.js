/**
 * My IT Process's assessment uses 8 distinct grades (confirmed via a live export of the account's
 * Grade config, Grades_07_23_2026.xlsx) - richer than the tooltip text alone reveals, since
 * two grades ("In Progress - Proactive" and "In Progress - Remediation") share the word "cog"
 * in casual DOM text but are rendered with different icon classes/colors and mean opposite
 * things (one is healthy-in-progress, the other is at-risk-in-progress). Grade detection
 * reads the icon's FontAwesome class + inline color, not the tooltip string.
 *
 * icon/color pairs and LMX_CRITERION are both sourced directly from that export.
 */
const GRADE_DEFINITIONS = [
  { key: 'Question', iconClass: 'fa-question', color: '#004bff', lmxCriterion: null }, // needs discovery - leave unanswered
  { key: 'Healthy', iconClass: 'fa-square-check', color: '#028304', lmxCriterion: 'Satisfactory' },
  { key: 'Warning', iconClass: 'fa-triangle-exclamation', color: '#d68b03', lmxCriterion: 'NeedsAttention' },
  { key: 'Danger', iconClass: 'fa-circle-exclamation', color: '#ff0606', lmxCriterion: 'AtRisk' },
  { key: 'InProgressProactive', iconClass: 'fa-gear', color: '#028304', lmxCriterion: 'Satisfactory' }, // healthy, proactive upgrade
  { key: 'InProgressRemediation', iconClass: 'fa-gear', color: '#d68b03', lmxCriterion: 'NeedsAttention' }, // at-risk until upgrade finishes
  { key: 'NotApplicable', iconClass: 'fa-circle-xmark', color: '#959595', lmxCriterion: 'NotApplicable' },
  { key: 'Hidden', iconClass: 'fa-eye-slash', color: '#717171', lmxCriterion: null }, // excluded from client-facing report
];

/**
 * Resolve a My IT Process grade cell's icon (className + inline color) to a grade key.
 * Falls back to matching on icon class alone if the color doesn't match exactly
 * (inline colors are occasionally represented as rgb(...) vs hex upstream).
 */
function resolveGradeKey(iconClassName, colorStyle) {
  const cls = (iconClassName || '');
  const norm = normalizeColor(colorStyle);
  let match = GRADE_DEFINITIONS.find((g) => cls.includes(g.iconClass) && normalizeColor(g.color) === norm);
  if (!match) match = GRADE_DEFINITIONS.find((g) => cls.includes(g.iconClass));
  return match ? match.key : null;
}

function normalizeColor(value) {
  if (!value) return null;
  const hexMatch = value.match(/#([0-9a-f]{6})/i);
  if (hexMatch) return hexMatch[1].toLowerCase();
  const rgbMatch = value.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/i);
  if (rgbMatch) {
    return rgbMatch.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('').toLowerCase();
  }
  return value.toLowerCase();
}

function gradeKeyToLMXCriterion(gradeKey) {
  const def = GRADE_DEFINITIONS.find((g) => g.key === gradeKey);
  return def ? def.lmxCriterion : null;
}

const LMX_COMMENT_MAX_LENGTH = 1000; // enforced server-side by the comment/internal and comment/public endpoints

/**
 * Build a single SO item's internal-comment text (status/risk/solution/budget), bounded to
 * LMX's 1000-char comment limit. With the 1:1 item->question mapping this should basically
 * never need to truncate, but stays as a safety net.
 */
function buildItemComment(item) {
  const parts = [];
  if (item.status) parts.push(`Status: ${item.status}`);
  if (item.risk) parts.push(`Risk: ${item.risk}`);
  if (item.solution) parts.push(`Solution: ${item.solution}`);
  if (item.month || item.year) parts.push(`Date: ${[item.month, item.year].filter(Boolean).join(' ')}`);
  if (item.budget) parts.push(`Budget: $${item.budget}`);
  if (item.recurring) {
    const recurBits = [item.recurring];
    if (item.period) recurBits.push(item.period);
    if (item.qty) recurBits.push(`x${item.qty}`);
    parts.push(`Recurring: ${recurBits.join(' ')}`);
    if (item.total) parts.push(`Recurring Total: $${item.total}`);
    if (item.effective) parts.push(`Effective: ${item.effective}`);
    if (item.cancelation) parts.push(`Cancelation: ${item.cancelation}`);
  }

  const full = '[Migrated from My IT Process]\n' + parts.join('\n');
  if (full.length <= LMX_COMMENT_MAX_LENGTH) return full;
  return full.slice(0, LMX_COMMENT_MAX_LENGTH - 15) + '\n...(truncated)';
}

// ---------------------------------------------------------------------------
// IT Plan -> LMX Roadmap (Initiatives)
// ---------------------------------------------------------------------------

/**
 * SO Plan item status -> LMX initiative_status_id. LMX's valid set (verified live):
 * Draft/New/Proposed/Approved/InProgress/OnHold/Declined/Completed.
 * My IT Process's Plan only exposes Completed/In Progress/Open/Future in the UI we've seen -
 * "Open" (scheduled into a quarter, not yet started) reads closest to "New"; "Future"
 * (Backlog, no quarter assigned) reads closest to "Proposed" (not yet committed).
 */
const PLAN_STATUS_TO_LMX = {
  Completed: 'Completed',
  'In Progress': 'InProgress',
  Open: 'New',
  Future: 'Proposed',
};

function planStatusToLMX(soStatus) {
  return PLAN_STATUS_TO_LMX[soStatus] || 'New';
}

function quarterLabelToNumber(label) {
  const m = (label || '').match(/Q([1-4])/i);
  return m ? Number(m[1]) : null;
}

/**
 * Parse a year out of either the item's own "Budget Year" column (authoritative when
 * present) or the group label it's nested under (e.g. "2026", possibly with a trailing
 * item-count badge glued on like "2026 4" - matched at the start only, so a non-numeric
 * placeholder like "202X" still intentionally fails to match rather than fabricating a year).
 */
function parseYear(value) {
  const m = (value || '').trim().match(/^(\d{4})\b/);
  return m ? Number(m[1]) : null;
}

/**
 * Parse a currency string like "15000.0000000000" (as rendered by SO) into integer cents
 * for LMX's cost_subunits. Returns null for blank/unparseable input.
 */
function parseMoneyToSubunits(value) {
  if (!value) return null;
  const n = Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/**
 * Build the internal-comment / fallback text for anything about a plan item that doesn't
 * become a first-class LMX initiative field (raw SO status wording, budget month, any of
 * the secondary columns like assignee/quantity/recurring/site if the account has them enabled).
 */
function buildPlanItemComment(item) {
  const parts = [`[Migrated from My IT Process] Original status: ${item.status || '(none)'}`];
  if (item.yearLabel || item.quarterLabel) {
    parts.push(`SO schedule bucket: ${[item.yearLabel, item.quarterLabel].filter(Boolean).join(' / ')}`);
  }
  if (item.budgetYear || item.budgetMonth) {
    parts.push(`SO budget date: ${[item.budgetMonth, item.budgetYear].filter(Boolean).join(' ')}`);
  }
  if (item.estimatedBudget) parts.push(`Estimated Budget: $${item.estimatedBudget}`);
  if (item.confirmedBudget) parts.push(`Confirmed Budget: $${item.confirmedBudget}`);
  if (item.assignedTo) parts.push(`Assigned to (SO): ${item.assignedTo}`);
  if (item.site) parts.push(`Site: ${item.site}`);

  const full = parts.join('\n');
  if (full.length <= LMX_COMMENT_MAX_LENGTH) return full;
  return full.slice(0, LMX_COMMENT_MAX_LENGTH - 15) + '\n...(truncated)';
}

/**
 * Build the executive_summary text (Explanation/Risk + Next Steps) for a plan item.
 */
function buildPlanExecutiveSummary(item) {
  const parts = [];
  if (item.explanationRisk) parts.push(`Explanation / Risk: ${item.explanationRisk}`);
  if (item.nextSteps) parts.push(`Next Steps: ${item.nextSteps}`);
  return parts.join('\n\n');
}

/**
 * Full executive_summary sent to LMX: the human-facing explanation/next-steps, plus
 * everything from buildPlanItemComment() that isn't a first-class LMX initiative field.
 * Initiatives (unlike assessment questions) have no separate per-item internal-comment
 * endpoint, so this is the one place all of My IT Process's detail ends up.
 */
function buildPlanFullSummary(item) {
  const primary = buildPlanExecutiveSummary(item);
  const detail = buildPlanItemComment(item);
  return [primary, detail].filter(Boolean).join('\n\n---\n');
}

const SO_LMX_MAPPING = {
  GRADE_DEFINITIONS,
  LMX_COMMENT_MAX_LENGTH,
  resolveGradeKey,
  gradeKeyToLMXCriterion,
  buildItemComment,
  planStatusToLMX,
  quarterLabelToNumber,
  parseYear,
  parseMoneyToSubunits,
  buildPlanItemComment,
  buildPlanExecutiveSummary,
  buildPlanFullSummary,
};

if (typeof self !== 'undefined') self.SO_LMX_MAPPING = SO_LMX_MAPPING;
if (typeof module !== 'undefined') module.exports = SO_LMX_MAPPING;
