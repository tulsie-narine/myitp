importScripts('mapping.js', 'so-template-data.js');

const API_BASE = 'https://api.scalepad.com';
const LMX_REQUEST_TIMEOUT_MS = 30000;
const LMX_RETRY_DELAYS_MS = [500, 1200];
const REVIEW_TAB_TIMEOUT_MS = 30000;
const QUESTION_EXTRACTION_TIMEOUT_MS = 180000;

function timeoutError(label, milliseconds) {
  return new Error(`${label} timed out after ${Math.round(milliseconds / 1000)} seconds.`);
}

function reportMigrationProgress(message) {
  chrome.runtime.sendMessage({ type: 'MIGRATION_PROGRESS', message }).catch(() => {});
}

function simplifyRepeatedName(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const words = text.split(' ');
  for (let size = Math.floor(words.length / 2); size >= 1; size--) {
    const first = words.slice(0, size).join(' ');
    const second = words.slice(size, size * 2).join(' ');
    const remainder = words.slice(size * 2).join(' ');
    if (first && first.toLowerCase() === second.toLowerCase() && /\b(?:onboarding|review|assessment)\b/i.test(remainder)) return first;
  }
  if (words.length % 2 === 0) {
    const midpoint = words.length / 2;
    const first = words.slice(0, midpoint).join(' ');
    const second = words.slice(midpoint).join(' ');
    if (first.toLowerCase() === second.toLowerCase()) return first;
  }
  return text;
}

function truncateApiTitle(value, maxLength = 100) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

// ---------- storage helpers ----------

async function getConfig() {
  const { apiKey, clientMappings, evaluateUserId, soTemplateId, alignmentTemplateId, alignmentTemplateFingerprint, alignmentMigrations } = await chrome.storage.local.get([
    'apiKey', 'clientMappings', 'evaluateUserId', 'soTemplateId', 'alignmentTemplateId', 'alignmentTemplateFingerprint', 'alignmentMigrations',
  ]);
  return {
    apiKey: apiKey || null,
    clientMappings: clientMappings || {},
    evaluateUserId: evaluateUserId || null,
    soTemplateId: soTemplateId || null,
    alignmentTemplateId: alignmentTemplateId || null,
    alignmentTemplateFingerprint: alignmentTemplateFingerprint || null,
    alignmentMigrations: alignmentMigrations || {},
    extensionVersion: chrome.runtime.getManifest().version,
  };
}

async function setApiKey(apiKey) {
  await chrome.storage.local.set({ apiKey });
}

async function setEvaluateUser(evaluateUserId) {
  await chrome.storage.local.set({ evaluateUserId });
}

async function setSoTemplateId(soTemplateId) {
  await chrome.storage.local.set({ soTemplateId });
}

async function saveClientMapping(soClientName, lmxClient) {
  const { clientMappings } = await getConfig();
  clientMappings[soClientName] = lmxClient; // { id, label }
  await chrome.storage.local.set({ clientMappings });
}

async function clearClientMapping(soClientName) {
  const { clientMappings } = await getConfig();
  delete clientMappings[soClientName];
  await chrome.storage.local.set({ clientMappings });
}

// ---------- LMX API wrapper ----------

function shouldRetryLmx(method, error) {
  if (method !== 'GET') return false;
  const message = error?.message || String(error);
  return error?.retryable === true || /-> (429|500|502|503|504):/.test(message) || /timed out|network|fetch failed/i.test(message);
}

async function lmxFetchOnce(path, { method, body, key }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LMX_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'x-api-key': key,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!res.ok) {
      const detail = data?.errors?.[0]?.detail || data?.errors?.[0]?.title || res.statusText;
      const error = new Error(`LMX API ${method} ${path} -> ${res.status}: ${detail}`);
      error.retryable = [429, 500, 502, 503, 504].includes(res.status);
      throw error;
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw timeoutError(`LMX API ${method} ${path}`, LMX_REQUEST_TIMEOUT_MS);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function lmxFetch(path, { method = 'GET', body, apiKey } = {}) {
  const key = apiKey || (await getConfig()).apiKey;
  if (!key) throw new Error('No LMX API key configured yet.');
  let attempt = 0;
  while (true) {
    try {
      return await lmxFetchOnce(path, { method, body, key });
    } catch (error) {
      if (!shouldRetryLmx(method, error) || attempt >= LMX_RETRY_DELAYS_MS.length) throw error;
      const delay = LMX_RETRY_DELAYS_MS[attempt++];
      reportMigrationProgress(`LMX ${method} ${path} failed; retrying in ${delay}ms (${attempt}/${LMX_RETRY_DELAYS_MS.length})…`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

const lmx = {
  lookupClients: (search) => lmxFetch(`/lifecycle-manager/v1/clients/lookup?search=${encodeURIComponent(search)}`),
  lookupClientsPage: ({ pageSize = 50, cursor } = {}) => lmxFetch(`/lifecycle-manager/v1/clients/lookup?page_size=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  listUsers: () => lmxFetch('/lifecycle-manager/v1/users'),
  listTemplates: () => lmxFetch('/lifecycle-manager/v1/assessment-templates'),
  getTemplate: (id) => lmxFetch(`/lifecycle-manager/v1/assessment-templates/${id}`),
  createTemplate: (body) => lmxFetch('/lifecycle-manager/v1/assessment-templates', { method: 'POST', body }),
  updateTemplate: (id, body) => lmxFetch(`/lifecycle-manager/v1/assessment-templates/${id}`, { method: 'PUT', body }),
  listAssessments: (pageSize = 50) => lmxFetch(`/lifecycle-manager/v1/assessments?page_size=${pageSize}`),
  createAssessment: (body) => lmxFetch('/lifecycle-manager/v1/assessments', { method: 'POST', body }),
  getAssessment: (id) => lmxFetch(`/lifecycle-manager/v1/assessments/${id}`),
  evaluate: (id, body) => lmxFetch(`/lifecycle-manager/v1/assessments/${id}/evaluate`, { method: 'PUT', body }),
  setQuestionInternalComment: (id, questionId, text) =>
    lmxFetch(`/lifecycle-manager/v1/assessments/${id}/questions/${questionId}/comment/internal`, {
      method: 'PUT', body: { comment_plain_text: text },
    }),
  setAssessmentInternalComment: (id, text) =>
    lmxFetch(`/lifecycle-manager/v1/assessments/${id}/internal-comment`, {
      method: 'PUT', body: { internal_comment: text },
    }),
  setCompletionStatus: (id, isCompleted) =>
    lmxFetch(`/lifecycle-manager/v1/assessments/${id}/completion-status`, {
      method: 'PUT', body: { is_completed: isCompleted },
    }),

  createInitiative: (body) => lmxFetch('/lifecycle-manager/v1/initiatives', { method: 'POST', body }),
  updateInitiativeSchedule: (id, body) => lmxFetch(`/lifecycle-manager/v1/initiatives/${id}/schedule`, { method: 'PUT', body }),
  updateInitiativeStatus: (id, body) => lmxFetch(`/lifecycle-manager/v1/initiatives/${id}/status`, { method: 'PUT', body }),
  updateInitiativeBudget: (id, body) => lmxFetch(`/lifecycle-manager/v1/initiatives/${id}/budget`, { method: 'PUT', body }),
};

async function allLmxClients() {
  const clients = new Map();
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const result = await lmx.lookupClientsPage({ pageSize: 50, cursor });
    for (const client of result.data || []) clients.set(client.id || client.label, client);
    if (!result.next_cursor) break;
    cursor = result.next_cursor;
  }
  return Array.from(clients.values());
}

async function recentEvaluators() {
  const list = await lmx.listUsers();
  return (list.data || []).filter((user) => user.status !== 'Disabled');
}

async function verifyAlignmentMigrations() {
  const config = await getConfig();
  const migrations = { ...(config.alignmentMigrations || {}) };
  let changed = false;
  for (const [reviewId, migration] of Object.entries(migrations)) {
    if (!migration.assessmentId) continue;
    try {
      const assessment = await lmx.getAssessment(migration.assessmentId);
      const clientLabel = assessment.assessment?.client?.label;
      migration.status = migration.status || 'completed';
      migration.lastVerifiedAt = new Date().toISOString();
      if (clientLabel && migration.lmxClientLabel !== clientLabel) {
        migration.lmxClientLabel = clientLabel;
        changed = true;
      }
    } catch (error) {
      const message = error.message || String(error);
      if (/404|NOT_FOUND|not found/i.test(message)) {
        delete migrations[reviewId];
        changed = true;
      }
    }
  }
  if (changed) await chrome.storage.local.set({ alignmentMigrations: migrations });
  return migrations;
}

async function deleteAlignmentMigration(reviewId, assessmentId) {
  // Lifecycle Manager's public API does not expose DELETE for assessments.
  // This operation releases the extension's local migration lock only; the
  // remote assessment must be removed from the LMX UI if it should be deleted.
  const config = await getConfig();
  const migrations = { ...(config.alignmentMigrations || {}) };
  delete migrations[reviewId];
  await chrome.storage.local.set({ alignmentMigrations: migrations });
  return migrations;
}

async function saveAlignmentMigration(reviewId, patch) {
  const config = await getConfig();
  const migrations = { ...(config.alignmentMigrations || {}) };
  migrations[reviewId] = { ...(migrations[reviewId] || {}), ...patch, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ alignmentMigrations: migrations });
  return migrations[reviewId];
}

// The same fixed 4-value criterion set on every question - LMX's "MultiResponse" criterion
// type is restricted server-side to these exact label_enum values (verified live; the docs'
// claim that custom label_enum strings are accepted is wrong - arbitrary values 500'd).
const STANDARD_CRITERIA = [
  { label_enum: 'Satisfactory', description: 'Healthy / up to standard.' },
  { label_enum: 'NeedsAttention', description: 'Minor risk - not fully aligned with standards, or a healthy item with a proactive upgrade in progress.' },
  { label_enum: 'AtRisk', description: 'Identified risk / liability, or currently at risk while a remediation is in progress.' },
  { label_enum: 'NotApplicable', description: 'Not applicable to this business. Excluded from scoring.' },
];

/**
 * Build the POST /assessment-templates body that mirrors SO_TEMPLATE_DATA 1:1:
 * one LMX category per SO group, one LMX question per SO item.
 */
function buildSOTemplatePayload() {
  return {
    assessment_template: {
      title: 'My IT Process - Technology Assessment (mirrored)',
      description: 'Auto-generated to mirror this account\'s My IT Process assessment structure for migrating assessment templates and responses into Lifecycle Manager X 1:1.',
      is_category_weight_evenly_distributed: true,
      categories: self.SO_TEMPLATE_DATA.map((group) => ({
        title: group.group,
        description: group.description || null,
        is_question_weight_evenly_distributed: true,
        weight_in_percentage: null,
        questions: group.items.map((item) => ({
          title: item.name,
          description: item.description || item.healthStandard || item.name,
          remediation_tips: item.solutionOptions || null,
          criterion_label_type_enum: 'MultiResponse',
          scoring_instructions: item.healthStandard || null,
          weight_in_percentage: null,
          tag_ids: [],
          criteria: STANDARD_CRITERIA,
        })),
      })),
    },
  };
}

async function createSOTemplate() {
  const payload = buildSOTemplatePayload();
  const result = await lmx.createTemplate(payload);
  await setSoTemplateId(result.assessment_template_id);
  return result.assessment_template_id;
}

const ALIGNMENT_TEMPLATE_TITLE = 'My IT Process - Alignment (mirrored)';
const ALIGNMENT_TEMPLATE_SCHEMA_VERSION = 'alignment-v2-myitp-labels';
const ALIGNMENT_CRITERIA = [
  { label_enum: 'Satisfactory', description: 'The Alignment item is satisfied.' },
  { label_enum: 'NeedsAttention', description: 'The Alignment item is marginal or needs attention.' },
  { label_enum: 'AtRisk', description: 'The Alignment item is not satisfied.' },
  { label_enum: 'NotApplicable', description: 'The Alignment item does not apply.' },
];

const MYITP_ALIGNMENT_CRITERIA = [
  { label_enum: 'Aligned', description: 'The Alignment item is satisfied.' },
  { label_enum: 'Marginal', description: 'The Alignment item is marginal or needs attention.' },
  { label_enum: 'Vulnerable', description: 'The Alignment item is not satisfied.' },
  { label_enum: 'N/A', description: 'The Alignment item does not apply.' },
];

const ALIGNMENT_CRITERION_ALIASES = {
  Satisfactory: ['satisfactory', 'aligned', 'align'],
  NeedsAttention: ['needsattention', 'needs attention', 'marginal'],
  AtRisk: ['atrisk', 'at risk', 'vulnerable'],
  NotApplicable: ['notapplicable', 'not applicable', 'n/a', 'na'],
};

function canonicalAlignmentCriterion(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return Object.entries(ALIGNMENT_CRITERION_ALIASES).find(([, aliases]) => aliases.includes(normalized))?.[0] || null;
}

function templateHasAlignmentCriteria(template) {
  const labels = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const key of ['label_enum', 'label_key', 'display_label']) {
      const canonical = canonicalAlignmentCriterion(value[key]);
      if (canonical) labels.add(canonical);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(template);
  return ALIGNMENT_CRITERIA.every((criterion) => labels.has(criterion.label_enum));
}

function templateUsesMyItProcessLabels(template) {
  const labels = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const key of ['label_enum', 'label_key', 'display_label']) {
      const normalized = String(value[key] || '').trim().toLowerCase();
      if (normalized) labels.add(normalized);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(template);
  return ['aligned', 'align'].some((label) => labels.has(label))
    && labels.has('marginal')
    && labels.has('vulnerable')
    && (labels.has('n/a') || labels.has('na'));
}

function templateMatchesAlignmentGroups(template, groups) {
  const categories = template?.categories || [];
  if (categories.length !== groups.length) return false;
  return groups.every((group) => {
    const category = categories.find((candidate) => candidate.title === group.title);
    if (!category || (category.questions || []).length !== group.questions.length) return false;
    const questionTitles = new Set((category.questions || []).map((question) => question.title));
    return group.questions.every((question) => questionTitles.has(alignmentItemTitle(question)));
  });
}

function alignmentItemTitle(item) {
  const title = String(item?.title || '').replace(/\s+/g, ' ').trim();
  const question = String(item?.question || '').replace(/\s+/g, ' ').trim();
  if (!question || title.includes(question)) return title;
  return `${title} | ${question}`;
}

function alignmentStructureFingerprint(groups) {
  const source = JSON.stringify((groups || []).map((group) => ({
    title: group.title,
    questions: group.questions.map((item) => ({ title: item.title, question: item.question })),
  })));
  const fingerprintSource = JSON.stringify({
    schema: ALIGNMENT_TEMPLATE_SCHEMA_VERSION,
    labels: MYITP_ALIGNMENT_CRITERIA,
    source,
  });
  let hash = 2166136261;
  for (let index = 0; index < fingerprintSource.length; index++) {
    hash ^= fingerprintSource.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function buildAlignmentTemplatePayload(groups, title = ALIGNMENT_TEMPLATE_TITLE) {
  return {
    assessment_template: {
      title,
      description: 'Mirrored from the My IT Process Alignment questionnaire.',
      is_category_weight_evenly_distributed: true,
      categories: groups.map((group) => ({
        title: group.title,
        description: `My IT Process Alignment category: ${group.title}`,
        is_question_weight_evenly_distributed: true,
        weight_in_percentage: null,
        questions: group.questions.map((item) => ({
          title: alignmentItemTitle(item),
          description: 'Mirrored from My IT Process Alignment.',
          remediation_tips: null,
          criterion_label_type_enum: 'MultiResponse',
          scoring_instructions: 'Yes or Aligned = Satisfactory; Marginal = Needs Attention; No or Vulnerable = At Risk; N/A = Not Applicable.',
          weight_in_percentage: null,
          tag_ids: [],
          criteria: ALIGNMENT_CRITERIA,
        })),
      })),
    },
  };
}

function buildAlignmentTemplateUpdatePayload(template, criteria) {
  return {
    assessment_template: {
      title: template.title,
      description: template.description || 'Mirrored from the My IT Process Alignment questionnaire.',
      is_category_weight_evenly_distributed: Boolean(template.is_category_weight_evenly_distributed),
      categories: (template.categories || []).map((category) => ({
        assessment_template_category_id: category.assessment_template_category_id,
        title: category.title,
        description: category.description || null,
        is_question_weight_evenly_distributed: Boolean(category.is_question_weight_evenly_distributed),
        weight_in_percentage: category.weight_in_percentage ?? null,
        questions: (category.questions || []).map((question) => ({
          assessment_template_question_id: question.assessment_template_question_id,
          title: question.title,
          description: question.description || question.title,
          remediation_tips: question.remediation_tips || null,
          criterion_label_type_enum: question.criterion_label_type_enum || 'MultiResponse',
          criteria: criteria.map((criterion, index) => ({
            assessment_template_criterion_id: question.criteria?.[index]?.assessment_template_criterion_id || null,
            // LMX protects the internal enum values. Only update the visible description/value.
            label_enum: question.criteria?.[index]?.label_enum || criterion.label_enum,
            description: criterion.description,
          })),
          scoring_instructions: question.scoring_instructions || null,
          weight_in_percentage: question.weight_in_percentage ?? null,
          tag_ids: (question.tags || []).map((tag) => tag.tag_id).filter(Boolean),
        })),
      })),
    },
  };
}

async function applyMyItProcessAlignmentLabels(templateId) {
  const full = await lmx.getTemplate(templateId);
  if (!full?.assessment_template) throw new Error('LMX returned no assessment template after creation.');
  await lmx.updateTemplate(templateId, buildAlignmentTemplateUpdatePayload(full.assessment_template, ALIGNMENT_CRITERIA));
}

async function applyAlignmentValuesIfSafe(templateId, template, groups, fingerprint) {
  if (template.is_in_use || templateUsesMyItProcessLabels(template)) return false;
  await applyMyItProcessAlignmentLabels(templateId);
  const verified = await lmx.getTemplate(templateId);
  if (!verified?.assessment_template || !templateMatchesAlignmentGroups(verified.assessment_template, groups)) {
    throw new Error(`LMX template ${templateId} did not retain its structure after updating values.`);
  }
  await chrome.storage.local.set({ alignmentTemplateId: templateId, alignmentTemplateFingerprint: fingerprint });
  return true;
}

async function getOrCreateAlignmentTemplate(groups, clientName) {
  const config = await getConfig();
  const fingerprint = alignmentStructureFingerprint(groups);
  let storedTemplate = null;
  if (config.alignmentTemplateId) {
    try {
      const existing = await lmx.getTemplate(config.alignmentTemplateId);
      if (existing?.assessment_template && templateHasAlignmentCriteria(existing.assessment_template)
        && templateMatchesAlignmentGroups(existing.assessment_template, groups)
        && (!config.alignmentTemplateFingerprint || config.alignmentTemplateFingerprint === fingerprint)) {
        storedTemplate = existing.assessment_template;
        if (templateUsesMyItProcessLabels(storedTemplate)) {
          await chrome.storage.local.set({ alignmentTemplateFingerprint: fingerprint });
          return config.alignmentTemplateId;
        }
      }
    } catch (_) { /* stored template was deleted or inaccessible; discover/create below */ }
  }

  const templates = await lmx.listTemplates();
  const listedTemplates = templates.data || [];
  const fullTemplates = [];
  for (const candidate of listedTemplates) {
    try {
      const full = await lmx.getTemplate(candidate.assessment_template_id);
      if (full?.assessment_template && templateMatchesAlignmentGroups(full.assessment_template, groups)) {
        fullTemplates.push({ id: candidate.assessment_template_id, template: full.assessment_template });
      }
    } catch (_) { /* ignore inaccessible or stale templates */ }
  }

  // Prefer an existing template with the original My IT Process labels.
  const customMatch = fullTemplates.find(({ template }) => templateUsesMyItProcessLabels(template));
  if (customMatch) {
    await chrome.storage.local.set({ alignmentTemplateId: customMatch.id, alignmentTemplateFingerprint: fingerprint });
    return customMatch.id;
  }

  const versionedTitle = `${ALIGNMENT_TEMPLATE_TITLE} [${fingerprint}]`;
  const standardMatch = fullTemplates.find(({ id, template }) =>
    templateHasAlignmentCriteria(template) && (template.title === versionedTitle || id === config.alignmentTemplateId
      || template.title === ALIGNMENT_TEMPLATE_TITLE || template.title.startsWith(`${ALIGNMENT_TEMPLATE_TITLE} [`)));
  if (standardMatch) {
    await applyAlignmentValuesIfSafe(standardMatch.id, standardMatch.template, groups, fingerprint);
    await chrome.storage.local.set({ alignmentTemplateId: standardMatch.id, alignmentTemplateFingerprint: fingerprint });
    return standardMatch.id;
  }

  const clientSuffix = ` [${simplifyRepeatedName(clientName) || 'client'}]`;
  const title = truncateApiTitle(`${versionedTitle}${clientSuffix}`);
  const created = await lmx.createTemplate(buildAlignmentTemplatePayload(groups, title));
  await chrome.storage.local.set({ alignmentTemplateId: created.assessment_template_id, alignmentTemplateFingerprint: fingerprint });
  return created.assessment_template_id;
}

// ---------- migration orchestration ----------

/**
 * Build { [categoryTitle]: { [questionTitle]: { instanceQuestionId, criteriaByLabel } } }
 * from a freshly created/fetched assessment instance.
 */
function indexAssessmentQuestions(assessment) {
  const byCategory = {};
  for (const cat of assessment.category_list) {
    const questions = {};
    for (const q of cat.question_list) {
      const criteriaByLabel = {};
      for (const c of q.criteria_list) {
        const key = canonicalAlignmentCriterion(c.label_key || c.label_enum || c.display_label);
        if (key) criteriaByLabel[key] = c.assessment_criterion_id;
      }
      questions[q.title] = { instanceQuestionId: q.assessment_question_id, criteriaByLabel };
    }
    byCategory[cat.title] = questions;
  }
  return byCategory;
}

function indexAlignmentAssessmentQuestions(assessment) {
  const byCategory = {};
  for (const cat of assessment.category_list) {
    const byTitle = {};
    for (const q of cat.question_list) {
      const criteriaByLabel = {};
      for (const c of q.criteria_list) {
        const key = canonicalAlignmentCriterion(c.label_key || c.label_enum || c.display_label);
        if (key) criteriaByLabel[key] = c.assessment_criterion_id;
      }
      if (!byTitle[q.title]) byTitle[q.title] = [];
      byTitle[q.title].push({ instanceQuestionId: q.assessment_question_id, criteriaByLabel });
    }
    byCategory[cat.title] = byTitle;
  }
  return byCategory;
}

async function runMigration({ soGroups, soClientName, lmxClientId, lmxClientLabel, templateId, evaluateUserId, markComplete }) {
  const log = [];
  const push = (msg) => { log.push(msg); };

  if (!lmxClientId) throw new Error('No LMX client mapped for this My IT Process client yet.');
  if (!evaluateUserId) throw new Error('No LMX evaluating user selected yet.');
  if (!templateId) throw new Error('No LMX template selected yet - create the mirrored template first.');

  push('Creating assessment in LMX...');
  const created = await lmx.createAssessment({
    client_key: { id: lmxClientId, name: lmxClientLabel },
    title: truncateApiTitle(`${soClientName} - Migrated from My IT Process`),
    assessment_template_id: templateId,
    evaluate_user_id: evaluateUserId,
    evaluate_at: new Date().toISOString(),
  });
  const assessmentId = created.id;
  push(`Created LMX assessment ${assessmentId}.`);

  const full = await lmx.getAssessment(assessmentId);
  const byCategory = indexAlignmentAssessmentQuestions(full.assessment);
  const titleOccurrences = {};

  const questionEvaluations = [];
  const commentJobs = [];
  const unmatched = [];

  for (const g of soGroups) {
    const questions = byCategory[g.group];
    if (!questions) { unmatched.push(`[group not found in LMX template] ${g.group} (${g.items.length} item(s))`); continue; }

    for (const item of g.items) {
      const target = questions[item.name];
      if (!target) { unmatched.push(`[${g.group}] ${item.name} (no matching LMX question - template out of sync?)`); continue; }

      const criterion = self.SO_LMX_MAPPING.gradeKeyToLMXCriterion(item.gradeKey);
      if (criterion && target.criteriaByLabel[criterion]) {
        questionEvaluations.push({
          question_id: target.instanceQuestionId,
          selected_criteria_id: target.criteriaByLabel[criterion],
        });
      }
      const hasDetail = item.status || item.risk || item.solution || item.budget;
      if (hasDetail) {
        commentJobs.push({ questionId: target.instanceQuestionId, text: self.SO_LMX_MAPPING.buildItemComment(item) });
      }
    }
  }

  if (questionEvaluations.length) {
    push(`Setting ${questionEvaluations.length} question answer(s)...`);
    try {
      await lmx.evaluate(assessmentId, { question_evaluations: questionEvaluations });
    } catch (err) {
      push(`Warning: setting question answers failed (${err.message}) - continuing to write comments so SO detail isn't lost.`);
    }
  }

  push(`Writing ${commentJobs.length} internal comment(s)...`);
  let commentFailures = 0;
  for (const job of commentJobs) {
    try {
      await lmx.setQuestionInternalComment(assessmentId, job.questionId, job.text);
    } catch (err) {
      commentFailures++;
      push(`  - failed to write comment on question ${job.questionId}: ${err.message}`);
    }
  }
  if (commentFailures) push(`Warning: ${commentFailures} of ${commentJobs.length} comment(s) failed to save (see above) - the rest of the migration continued.`);

  if (unmatched.length) {
    const text = unmatched.slice(0, 40).join('\n') + (unmatched.length > 40 ? `\n...(+${unmatched.length - 40} more)` : '');
    try {
      await lmx.setAssessmentInternalComment(assessmentId, `[Items that could not be matched to this LMX template]\n${text}`.slice(0, 1000));
      push(`Logged ${unmatched.length} unmatched item(s) as an assessment-level internal comment.`);
    } catch (err) {
      push(`Warning: failed to write the assessment-level internal comment: ${err.message}`);
    }
  } else {
    push('Every SO item matched a question in the LMX template.');
  }

  if (markComplete) {
    await lmx.setCompletionStatus(assessmentId, true);
    push('Marked assessment as completed.');
  }

  return { assessmentId, log };
}

function alignmentResponseToCriterion(response) {
  const value = String(response || '').trim().toLowerCase();
  if (value === 'yes' || value === 'aligned') return 'Satisfactory';
  if (value === 'marginal' || value === 'needs attention' || value === 'needsattention') return 'NeedsAttention';
  if (value === 'no' || value === 'vulnerable') return 'AtRisk';
  if (value === 'n/a' || value === 'na' || value === 'not applicable') return 'NotApplicable';
  return null;
}

function groupAlignmentQuestions(questions) {
  const groups = new Map();
  for (const item of questions || []) {
    const title = item.category || 'Alignment';
    if (!groups.has(title)) groups.set(title, { title, questions: [] });
    groups.get(title).questions.push(item);
  }
  return Array.from(groups.values());
}

async function runAlignmentMigration({ questions, expectedQuestionCount, clientName, lmxClientId, lmxClientLabel, evaluateUserId, bothComplete, engineerReviewName, vcioReviewName }) {
  const log = [];
  const push = (message) => log.push(message);
  if (!lmxClientId) throw new Error('No LMX client mapped for this My IT Process client yet.');
  if (!evaluateUserId) throw new Error('No LMX evaluating user selected yet.');
  if (!questions?.length) throw new Error('No Alignment questions found on this review.');
  if (expectedQuestionCount && questions.length < expectedQuestionCount) {
    throw new Error(`Incomplete Alignment extraction: collected ${questions.length} of ${expectedQuestionCount} expected question(s).`);
  }
  reportMigrationProgress(`Extracted ${questions.length}/${expectedQuestionCount || questions.length} Alignment question(s).`);

  const groups = groupAlignmentQuestions(questions);
  reportMigrationProgress(`Checking the mirrored template across ${groups.length} category group(s).`);
  push(`Checking for the ${ALIGNMENT_TEMPLATE_TITLE} template...`);
  const normalizedClientName = simplifyRepeatedName(clientName);
  const templateId = await getOrCreateAlignmentTemplate(groups, normalizedClientName);
  push(`Using LMX template ${templateId}.`);

  const assessmentTitle = truncateApiTitle(`${normalizedClientName} - My IT Process Alignment`);
  let existing = (await lmx.listAssessments(100)).data?.find((assessment) =>
    assessment.title === assessmentTitle && assessment.client?.id === lmxClientId
  );
  if (existing) {
    try {
      const existingFull = await lmx.getAssessment(existing.id);
      const existingTemplateId = existingFull.assessment?.assessment_template_id;
      if (existingTemplateId && existingTemplateId !== templateId) {
        push(`Existing assessment ${existing.id} uses an older LMX template; creating a new assessment from ${templateId}.`);
        existing = null;
      }
    } catch (_) { /* use the existing assessment if its details cannot be read */ }
  }
  let assessmentId;
  let assessmentCreated = false;
  if (existing) {
    assessmentId = existing.id;
    push(`Reusing existing LMX assessment ${assessmentId}; no duplicate was created.`);
  } else {
    const created = await lmx.createAssessment({
      client_key: { id: lmxClientId, name: lmxClientLabel },
      title: assessmentTitle,
      assessment_template_id: templateId,
      evaluate_user_id: evaluateUserId,
      evaluate_at: new Date().toISOString(),
    });
    assessmentId = created.id;
    assessmentCreated = true;
    push(`Created LMX assessment ${assessmentId}.`);
  }
  reportMigrationProgress(`Using LMX assessment ${assessmentId}.`);

  const reviewerComment = [
    engineerReviewName ? `Engineer Review: ${engineerReviewName}` : '',
    vcioReviewName ? `vCIO Review: ${vcioReviewName}` : '',
  ].filter(Boolean).join('\n');
  if (assessmentCreated && reviewerComment) {
    await lmx.setAssessmentInternalComment(assessmentId, reviewerComment.slice(0, 1000));
    push('Added Engineer Review and vCIO Review names to the assessment internal comment.');
  }

  const full = await lmx.getAssessment(assessmentId);
  const byCategory = indexAlignmentAssessmentQuestions(full.assessment);
  const titleOccurrences = {};
  const questionEvaluations = [];
  const commentJobs = [];
  const unmatched = [];
  const unanswered = [];
  let evaluationFailures = 0;
  let commentFailures = 0;

  for (const item of questions) {
    const category = byCategory[item.category || 'Alignment'];
    const occurrenceKey = `${item.category || 'Alignment'}:${alignmentItemTitle(item)}`;
    const occurrence = titleOccurrences[occurrenceKey] || 0;
    const target = category?.[alignmentItemTitle(item)]?.[occurrence];
    titleOccurrences[occurrenceKey] = occurrence + 1;
    if (!target) {
      unmatched.push(`[${item.category || 'Alignment'}] ${item.title}`);
      continue;
    }
    const criterion = alignmentResponseToCriterion(item.engineerResponse || item.response);
    if (criterion && target.criteriaByLabel[criterion]) {
      questionEvaluations.push({
        question_id: target.instanceQuestionId,
        selected_criteria_id: target.criteriaByLabel[criterion],
      });
    } else if (!criterion) {
      unanswered.push(`[${item.category || 'Alignment'}] ${item.title}`);
    }
    const commentLines = [];
    if (item.alignmentResponse) {
      commentLines.push(`${item.alignmentPrompt} ${item.alignmentResponse}`);
    }
    if (item.technicalAnalysis) {
      commentLines.push(`Technical Analysis: ${item.technicalAnalysis}`);
    }
    if (commentLines.length) {
      commentJobs.push({
        questionId: target.instanceQuestionId,
        text: commentLines.join('\n').slice(0, self.SO_LMX_MAPPING.LMX_COMMENT_MAX_LENGTH),
      });
    }
  }

  const responseSources = questions.reduce((counts, item) => {
    if (item.response) counts[item.responseSource || 'unknown'] = (counts[item.responseSource || 'unknown'] || 0) + 1;
    return counts;
  }, {});
  push(`Captured source responses: Engineer ${responseSources.engineer || 0}, vCIO ${responseSources.vcio || 0}, other ${responseSources.alignment || 0}.`);

  if (questionEvaluations.length) {
    push(`Setting ${questionEvaluations.length} question answer(s) from Engineer responses...`);
    reportMigrationProgress(`Applying ${questionEvaluations.length} response(s) to LMX.`);
    for (let offset = 0; offset < questionEvaluations.length; offset += 25) {
      const batch = questionEvaluations.slice(offset, offset + 25);
      try {
        await lmx.evaluate(assessmentId, { question_evaluations: batch });
        push(`Applied answers ${offset + 1}-${offset + batch.length} of ${questionEvaluations.length}.`);
      } catch (error) {
        evaluationFailures++;
        push(`Warning: answer batch ${offset + 1}-${offset + batch.length} failed: ${error.message}`);
      }
    }
    if (evaluationFailures) push(`${evaluationFailures} answer batch(es) failed; the assessment remains retryable.`);
  }
  if (unanswered.length) push(`No usable Engineer response for ${unanswered.length} question(s); left those unanswered.`);
  push(`Writing ${commentJobs.length} source-context note(s) to LMX internal comments...`);
  reportMigrationProgress(`Writing ${commentJobs.length} source-context comment(s).`);
  for (const job of commentJobs) {
    try {
      await lmx.setQuestionInternalComment(assessmentId, job.questionId, job.text);
    } catch (error) {
      commentFailures++;
      push(`Warning: question comment ${job.questionId} failed: ${error.message}`);
    }
  }
  if (unmatched.length) {
    const unmatchedComment = `[Items that could not be matched]\n${unmatched.join('\n')}`;
    await lmx.setAssessmentInternalComment(assessmentId, [reviewerComment, unmatchedComment].filter(Boolean).join('\n\n').slice(0, 1000));
    push(`Logged ${unmatched.length} unmatched question(s).`);
  }
  const migrationComplete = bothComplete && evaluationFailures === 0 && commentFailures === 0 && unmatched.length === 0 && unanswered.length === 0;
  if (migrationComplete) {
    await lmx.setCompletionStatus(assessmentId, true);
    push('Both My IT Process reviews were complete; marked the LMX assessment completed.');
  } else {
    push('Assessment created with warnings; left the LMX assessment in progress for follow-up.');
  }
  reportMigrationProgress('Migration steps completed; saving migration record.');
  return {
    assessmentId,
    templateId,
    assessmentCreated,
    expectedQuestionCount: expectedQuestionCount || questions.length,
    log,
    answeredCount: questionEvaluations.length,
    unmatchedCount: unmatched.length,
    unansweredCount: unanswered.length,
    unmatched,
    unanswered,
    evaluationFailures,
    commentFailures,
    warningCount: unmatched.length + unanswered.length + evaluationFailures + commentFailures,
    retryable: evaluationFailures > 0 || commentFailures > 0 || unmatched.length > 0,
    partial: !migrationComplete,
  };
}

async function requestAlignmentExtraction(tabId) {
  reportMigrationProgress(`Waiting for questionnaire extraction response from tab ${tabId}…`);
  return Promise.race([new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'MYITP_EXTRACT_ALIGNMENT' }, (response) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(response);
    });
  }), new Promise((_, reject) => setTimeout(() => reject(timeoutError('My IT Process questionnaire extraction', QUESTION_EXTRACTION_TIMEOUT_MS)), QUESTION_EXTRACTION_TIMEOUT_MS))]);
}

async function waitForReviewTabComplete(tabId) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === 'complete') return;
  await Promise.race([new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  }), new Promise((_, reject) => setTimeout(() => reject(timeoutError('My IT Process review page load', REVIEW_TAB_TIMEOUT_MS)), REVIEW_TAB_TIMEOUT_MS))]);
}

async function extractAlignmentFromReviewTab(reviewUrl, sourceTabId) {
  const tab = await chrome.tabs.create({ url: reviewUrl, active: true });
  let extractionSucceeded = false;
  try {
    reportMigrationProgress(`Opened the My IT Process assessment page for question extraction; the source tab is unchanged.`);
    await waitForReviewTabComplete(tab.id);
    let result = await requestAlignmentExtraction(tab.id);
    for (let retry = 1; result?.ok && result.expectedQuestionCount && result.questions.length < result.expectedQuestionCount && retry <= 2; retry++) {
      reportMigrationProgress(`Questionnaire was incomplete (${result.questions.length}/${result.expectedQuestionCount}); reloading for extraction retry ${retry}/2…`);
      await chrome.tabs.reload(tab.id);
      await waitForReviewTabComplete(tab.id);
      result = await requestAlignmentExtraction(tab.id);
    }
    if (result?.ok && result.expectedQuestionCount && result.questions.length > result.expectedQuestionCount) {
      throw new Error(`Invalid Alignment extraction: collected ${result.questions.length} of ${result.expectedQuestionCount} expected question(s). Retry stopped before writing to LMX.`);
    }
    if (result?.ok && result.questions?.length) {
      extractionSucceeded = true;
      return result;
    }
    if (result?.error) throw new Error(`My IT Process extraction failed: ${result.error}`);
    throw new Error('My IT Process content script did not respond. Reload the review page and try again.');
  } finally {
    if (tab.id && extractionSucceeded) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    } else if (tab.id) {
      reportMigrationProgress('The My IT Process assessment tab was left open for review after extraction failed.');
    }
  }
}

function canonicalReviewUrl(review) {
  // /view-details/psa is the PSA/Tickets side panel. It contains the client
  // grid but not the rendered Alignment question wrappers. Extraction must
  // use the direct review route, where categories and questions are present.
  return new URL(`/alignment/${review.reviewId}`, 'https://new.live.myitprocess.com').href;
}

async function runSelectedAlignmentMigrations({ reviews, evaluateUserId, sourceTabId }) {
  const log = [];
  const results = [];
  const config = await getConfig();
  const migrations = config.alignmentMigrations || {};
  let sourceReviewId = null;
  if (sourceTabId) {
    const sourceTab = await chrome.tabs.get(sourceTabId).catch(() => null);
    const sourcePath = sourceTab?.url ? new URL(sourceTab.url).pathname : '';
    const sourceMatch = sourcePath.match(/^\/alignment\/(\d+)(?:\/|$)/);
    if (sourceMatch) sourceReviewId = sourceMatch[1];
  }
  for (const review of reviews || []) {
    const effectiveReview = sourceReviewId && reviews.length === 1
      ? { ...review, reviewId: sourceReviewId }
      : review;
    if (effectiveReview.reviewId !== review.reviewId) {
      reportMigrationProgress(`Using the currently opened My IT Process alignment ${effectiveReview.reviewId}.`);
    }
    log.push(`\n${effectiveReview.clientName} — ${effectiveReview.reviewTitle}`);
    reportMigrationProgress(`Starting ${effectiveReview.clientName} — ${effectiveReview.reviewTitle}.`);
    const previous = migrations[effectiveReview.reviewId];
    const previousStatus = previous?.status || (previous ? 'completed' : null);
    if (previous && previousStatus === 'completed') {
      log.push(`Skipped: already migrated to LMX assessment ${previous.assessmentId}.`);
      results.push({ reviewId: effectiveReview.reviewId, skipped: true, assessmentId: previous.assessmentId });
      continue;
    }
    migrations[effectiveReview.reviewId] = {
      ...(previous || {}),
      status: 'running',
      clientName: simplifyRepeatedName(effectiveReview.clientName),
      lmxClientLabel: effectiveReview.lmxClient.label,
      startedAt: new Date().toISOString(),
      lastError: null,
    };
    await chrome.storage.local.set({ alignmentMigrations: migrations });
    try {
      reportMigrationProgress('Extracting the My IT Process questionnaire.');
      const reviewUrl = canonicalReviewUrl(effectiveReview);
      reportMigrationProgress(`Opening ${simplifyRepeatedName(effectiveReview.clientName)} alignment ${effectiveReview.reviewId}.`);
      const extracted = await extractAlignmentFromReviewTab(reviewUrl, sourceTabId);
      const result = await runAlignmentMigration({
        questions: extracted.questions,
        expectedQuestionCount: extracted.expectedQuestionCount,
        clientName: simplifyRepeatedName(effectiveReview.clientName),
        lmxClientId: effectiveReview.lmxClient.id,
        lmxClientLabel: effectiveReview.lmxClient.label,
        evaluateUserId,
        bothComplete: effectiveReview.bothComplete,
        engineerReviewName: effectiveReview.engineerReviewName,
        vcioReviewName: effectiveReview.vcioReviewName,
      });
      log.push(...result.log);
      log.push(`Done. LMX assessment id: ${result.assessmentId}`);
      migrations[effectiveReview.reviewId] = {
        ...(migrations[effectiveReview.reviewId] || {}),
        assessmentId: result.assessmentId,
        templateId: result.templateId,
        clientName: simplifyRepeatedName(effectiveReview.clientName),
        lmxClientLabel: effectiveReview.lmxClient.label,
        migratedAt: new Date().toISOString(),
        status: result.partial ? 'partial' : 'completed',
        completed: !!effectiveReview.bothComplete,
        lastError: null,
      };
      await chrome.storage.local.set({ alignmentMigrations: migrations });
      results.push({
        reviewId: effectiveReview.reviewId,
        skipped: false,
        assessmentId: result.assessmentId,
        assessmentCreated: result.assessmentCreated,
        expectedQuestionCount: result.expectedQuestionCount,
        answeredCount: result.answeredCount,
        unmatchedCount: result.unmatchedCount,
        unansweredCount: result.unansweredCount,
        unmatched: result.unmatched,
        unanswered: result.unanswered,
        evaluationFailures: result.evaluationFailures,
        commentFailures: result.commentFailures,
        warningCount: result.warningCount,
        retryable: result.retryable,
        partial: !!result.partial,
      });
    } catch (err) {
      const errorMessage = err.message || String(err);
      log.push(`Error: ${errorMessage}`);
      migrations[effectiveReview.reviewId] = {
        ...(migrations[effectiveReview.reviewId] || {}),
        status: 'failed',
        lastError: errorMessage,
        failedAt: new Date().toISOString(),
      };
      await chrome.storage.local.set({ alignmentMigrations: migrations });
      results.push({ reviewId: effectiveReview.reviewId, error: errorMessage });
    }
  }
  return { log, results };
}

/**
 * IT Plan -> LMX Roadmap. Each SO plan item becomes one LMX initiative: name + summary at
 * creation, then schedule/status/budget set via their dedicated update endpoints (mirrors
 * how assessments needed a create -> GET -> per-field-update flow). Unlike assessment
 * questions, initiatives have no separate internal-comment endpoint, so everything that
 * isn't a first-class field (raw SO status wording, budget month, schedule bucket text)
 * gets folded into the executive summary instead - see buildPlanFullSummary().
 */
async function runPlanMigration({ planItems, soClientName, lmxClientId, lmxClientLabel }) {
  const log = [];
  const push = (msg) => { log.push(msg); };

  if (!lmxClientId) throw new Error('No LMX client mapped for this My IT Process client yet.');
  if (!planItems || !planItems.length) throw new Error('No IT Plan items found on this page.');

  push(`Migrating ${planItems.length} IT Plan item(s) to LMX Roadmap...`);

  const unscheduled = [];
  const failed = [];
  let createdCount = 0;

  for (const item of planItems) {
    let initiativeId;
    try {
      const created = await lmx.createInitiative({
        client_key: { id: lmxClientId, name: lmxClientLabel },
        name: item.name,
        executive_summary: self.SO_LMX_MAPPING.buildPlanFullSummary(item),
      });
      initiativeId = created.id;
      createdCount++;
    } catch (err) {
      failed.push(`${item.name}: create failed - ${err.message}`);
      continue;
    }

    const quarter = self.SO_LMX_MAPPING.quarterLabelToNumber(item.quarterLabel);
    const year = self.SO_LMX_MAPPING.parseYear(item.budgetYear) || self.SO_LMX_MAPPING.parseYear(item.yearLabel);
    if (quarter && year) {
      try {
        await lmx.updateInitiativeSchedule(initiativeId, { fiscal_quarter: { year, quarter } });
      } catch (err) {
        push(`  - ${item.name}: failed to set schedule - ${err.message}`);
      }
    } else {
      unscheduled.push(`${item.name} (SO bucket: ${[item.yearLabel, item.quarterLabel].filter(Boolean).join(' / ') || 'none'})`);
    }

    try {
      await lmx.updateInitiativeStatus(initiativeId, { initiative_status_id: self.SO_LMX_MAPPING.planStatusToLMX(item.status) });
    } catch (err) {
      push(`  - ${item.name}: failed to set status - ${err.message}`);
    }

    const budgetSubunits = self.SO_LMX_MAPPING.parseMoneyToSubunits(item.confirmedBudget) ?? self.SO_LMX_MAPPING.parseMoneyToSubunits(item.estimatedBudget);
    if (budgetSubunits) {
      const label = item.confirmedBudget ? 'Confirmed Budget (from My IT Process)' : 'Estimated Budget (from My IT Process)';
      try {
        await lmx.updateInitiativeBudget(initiativeId, {
          budget_line_items: [{ label, cost_subunits: budgetSubunits, cost_type: 'Fixed', display_order: 0 }],
        });
      } catch (err) {
        push(`  - ${item.name}: failed to set budget - ${err.message}`);
      }
    }
  }

  push(`Created ${createdCount} of ${planItems.length} initiative(s) in LMX.`);
  if (failed.length) push(`Warning: ${failed.length} item(s) failed entirely:\n  ${failed.join('\n  ')}`);
  if (unscheduled.length) {
    push(`${unscheduled.length} item(s) had no parseable year/quarter and were left unscheduled in LMX (SO used a placeholder or non-numeric year label - schedule them manually):\n  ${unscheduled.join('\n  ')}`);
  }

  return { createdCount, log };
}

// ---------- message router ----------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'GET_CONFIG':
          return sendResponse({ ok: true, data: await getConfig() });
        case 'SET_API_KEY':
          await setApiKey(message.apiKey);
          return sendResponse({ ok: true });
        case 'SET_EVALUATE_USER':
          await setEvaluateUser(message.evaluateUserId);
          return sendResponse({ ok: true });
        case 'SEARCH_LMX_CLIENTS':
          return sendResponse({ ok: true, data: await lmx.lookupClients(message.query) });
        case 'LIST_LMX_CLIENTS':
          return sendResponse({ ok: true, data: await allLmxClients() });
        case 'SAVE_CLIENT_MAPPING':
          await saveClientMapping(message.soClientName, message.lmxClient);
          return sendResponse({ ok: true });
        case 'CLEAR_CLIENT_MAPPING':
          await clearClientMapping(message.soClientName);
          return sendResponse({ ok: true });
        case 'RECENT_EVALUATORS':
          return sendResponse({ ok: true, data: await recentEvaluators() });
        case 'VERIFY_ALIGNMENT_MIGRATIONS':
          return sendResponse({ ok: true, data: await verifyAlignmentMigrations() });
        case 'DELETE_ALIGNMENT_MIGRATION':
          return sendResponse({ ok: true, data: await deleteAlignmentMigration(message.reviewId, message.assessmentId) });
        case 'CREATE_SO_TEMPLATE': {
          const id = await createSOTemplate();
          return sendResponse({ ok: true, data: { templateId: id } });
        }
        case 'GET_SO_TEMPLATE': {
          const { soTemplateId } = await getConfig();
          if (!soTemplateId) return sendResponse({ ok: true, data: null });
          const tmpl = await lmx.getTemplate(soTemplateId);
          return sendResponse({ ok: true, data: { templateId: soTemplateId, title: tmpl.assessment_template.title } });
        }
        case 'GET_ALIGNMENT_TEMPLATE': {
          const { alignmentTemplateId } = await getConfig();
          if (!alignmentTemplateId) return sendResponse({ ok: true, data: null });
          const tmpl = await lmx.getTemplate(alignmentTemplateId);
          return sendResponse({ ok: true, data: { templateId: alignmentTemplateId, title: tmpl.assessment_template.title } });
        }
        case 'RUN_ALIGNMENT_MIGRATION': {
          const result = await runAlignmentMigration(message.payload);
          return sendResponse({ ok: true, data: result });
        }
        case 'RUN_SELECTED_ALIGNMENT_MIGRATIONS': {
          const result = await runSelectedAlignmentMigrations(message.payload);
          return sendResponse({ ok: true, data: result });
        }
        case 'RUN_MIGRATION': {
          const result = await runMigration(message.payload);
          return sendResponse({ ok: true, data: result });
        }
        case 'RUN_PLAN_MIGRATION': {
          const result = await runPlanMigration(message.payload);
          return sendResponse({ ok: true, data: result });
        }
        default:
          return sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      return sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true; // keep the message channel open for the async response
});
