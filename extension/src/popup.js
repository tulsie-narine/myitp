const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 20;
const SELECTION_STORAGE_KEY = 'alignmentSelectionsV2';

const state = { config: null, reviews: [], currentPageType: null, currentPage: 1, savedSelections: {}, filter: 'all', minimumCompletion: 0 };

function send(message) { return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve)); }

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'MIGRATION_PROGRESS') return;
  const log = $('logOutput');
  if (!log || log.classList.contains('hidden')) return;
  log.textContent += `[${new Date().toLocaleTimeString()}] ${message.message}\n`;
  log.scrollTop = log.scrollHeight;
});
async function activeTab() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return tab; }
function pageType(url) { if (/\/alignment\/?$/.test(url || '')) return 'list'; if (/\/alignment\/\d+\/view-details(?:\/.*)?\/?$/.test(url || '')) return 'list'; if (/\/alignment\/\d+\/?$/.test(url || '')) return 'detail'; return null; }
function normalize(value) { return (value || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function escapeHtml(value) { return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function compactRepeatedName(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const words = text.split(' ');
  for (let midpoint = Math.floor(words.length / 2); midpoint >= 1; midpoint--) {
    if (words.length % midpoint !== 0 || words.length / midpoint < 2) continue;
    const first = words.slice(0, midpoint).join(' ');
    const repeated = Array.from({ length: words.length / midpoint }, (_, index) => words.slice(index * midpoint, (index + 1) * midpoint).join(' ')).every((part) => normalize(part) === normalize(first));
    if (repeated) return first;
  }
  return text;
}
function compactAssessmentTitle(title, clientName) {
  const compactClient = compactRepeatedName(clientName);
  let result = String(title || '').replace(/\s+/g, ' ').trim();
  while (compactClient && normalize(result).startsWith(normalize(compactClient))) result = result.slice(compactClient.length).trim();
  return result || 'Alignment review';
}
function sourceDisplay(review) {
  const raw = String(review.clientName || '').replace(/\s+/g, ' ').trim();
  const match = raw.match(/^(.*?)(?:\s+)(Onboarding review|Alignment review|Review)$/i);
  const rawName = match ? match[1] : raw;
  const name = compactRepeatedName(rawName);
  const assessment = match ? match[2] : compactAssessmentTitle(review.reviewTitle, name);
  return { name: name || 'Unknown client', assessment: assessment || 'Alignment review' };
}

function renderSettings() {
  $('settingsStatus').textContent = state.config?.apiKey ? 'Connected' : 'Not connected';
  $('keyStatus').textContent = state.config?.apiKey ? 'API key saved.' : 'No key saved yet.';
}

function setReadiness(id, ready, stateText) {
  const element = $(id);
  element.classList.toggle('ready', ready);
  element.querySelector('.readiness-state').textContent = stateText;
}

function renderSelectionStatus() {
  const selected = state.reviews.filter((review) => review.selected && !review.migrated);
  const ready = selected.filter((review) => review.lmxClient);
  $('selectionStatus').textContent = selected.length ? `${selected.length} review(s) selected · ${ready.length} matched to LMX` : 'No reviews selected.';
  $('migrateBtn').disabled = !state.config?.apiKey || !state.config?.evaluateUserId || !ready.length || ready.length !== selected.length;
}

function reviewStatus(review) {
  if (review.migration?.status === 'failed') return `Previous migration failed · retry available${review.migration.lastError ? ` · ${review.migration.lastError}` : ''}`;
  if (review.migration?.status === 'running') return 'Migration in progress · retry available if it fails';
  if (review.migrated) return 'Already migrated to LMX';
  return review.bothComplete ? 'Both reviews complete → LMX will be completed' : 'In progress → LMX will remain in progress';
}

function completionPercent(review) {
  // Submitted Engineer reviews show "(Submitted MM/DD/YYYY)" with no percentage; treat them as 100%.
  if (review.engineerState === 'complete' || /submitted/i.test(review.engineerStatus || '')) return 100;
  const match = String(review.engineerStatus || '').match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) : 0;
}

function meetsCompletionFilter(review) {
  return completionPercent(review) >= state.minimumCompletion;
}

function persistSelections() {
  for (const review of state.reviews) state.savedSelections[review.reviewId] = !!review.selected;
  chrome.storage.local.set({ [SELECTION_STORAGE_KEY]: state.savedSelections });
}

function visibleReviews() {
  return state.reviews.filter((review) => {
    if (!meetsCompletionFilter(review)) return false;
    if (state.filter === 'migrated') return review.migrated;
    if (state.filter === 'unmatched') return !review.lmxClient && !review.migrated;
    if (state.filter === 'failed') return review.migration?.status === 'failed' || review.migration?.status === 'partial';
    if (state.filter === 'ready') return !!review.lmxClient && !review.migrated;
    return true;
  });
}

function updateFilterCounts() {
  const eligible = state.reviews.filter(meetsCompletionFilter);
  const counts = {
    all: eligible.length,
    ready: eligible.filter((review) => !!review.lmxClient && !review.migrated).length,
    unmatched: eligible.filter((review) => !review.lmxClient && !review.migrated).length,
    failed: eligible.filter((review) => ['failed', 'partial'].includes(review.migration?.status)).length,
    migrated: eligible.filter((review) => review.migrated).length,
  };
  const labels = {
    all: 'All reviews',
    ready: 'Ready to migrate',
    unmatched: 'Needs client match',
    failed: 'Needs retry',
    migrated: 'Migrated',
  };
  for (const option of $('reviewFilter').options) option.textContent = `${labels[option.value]} (${counts[option.value]})`;
}

function renderPager() {
  const totalPages = Math.max(1, Math.ceil(visibleReviews().length / PAGE_SIZE));
  state.currentPage = Math.min(state.currentPage, totalPages);
  $('reviewPager').classList.toggle('hidden', totalPages <= 1);
  $('pageIndicator').textContent = `Page ${state.currentPage} of ${totalPages}`;
  $('previousPageBtn').disabled = state.currentPage <= 1;
  $('nextPageBtn').disabled = state.currentPage >= totalPages;
}

function attachMatchSearch(row, review) {
  const input = row.querySelector('.match-input');
  const results = row.querySelector('.match-results');
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const query = input.value.trim();
    results.innerHTML = '';
    if (query.length < 2) return;
    timer = setTimeout(async () => {
      const response = await send({ type: 'SEARCH_LMX_CLIENTS', query });
      const candidates = response.ok ? Array.from(new Map((response.data.data || []).map((candidate) => [candidate.id || candidate.label, candidate])).values()) : [];
      for (const candidate of candidates.slice(0, 8)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'match-result';
        button.textContent = candidate.label;
        button.addEventListener('click', async () => {
          review.lmxClient = { id: candidate.id, label: candidate.label };
          await send({ type: 'SAVE_CLIENT_MAPPING', soClientName: sourceDisplay(review).name, lmxClient: review.lmxClient });
          renderReviews();
        });
        results.appendChild(button);
      }
    }, 250);
  });
}

function attachRemap(row, review) {
  const button = row.querySelector('.remap-client-btn');
  if (!button) return;
  button.addEventListener('click', async () => {
    button.disabled = true;
    const sourceName = sourceDisplay(review).name;
    await send({ type: 'CLEAR_CLIENT_MAPPING', soClientName: review.clientName });
    if (sourceName !== review.clientName) await send({ type: 'CLEAR_CLIENT_MAPPING', soClientName: sourceName });
    review.lmxClient = null;
    renderReviews();
  });
}

function renderReviews() {
  const list = $('reviewList');
  list.innerHTML = '';
  updateFilterCounts();
  const availableCount = state.reviews.filter(meetsCompletionFilter).length;
  $('pageStatus').textContent = state.minimumCompletion
    ? `Found ${state.reviews.length} Alignment reviews · ${availableCount} at or above ${state.minimumCompletion}% Engineer completion · showing ${PAGE_SIZE} per page.`
    : `Found ${state.reviews.length} Alignment reviews · showing ${PAGE_SIZE} per page.`;
  if (!state.reviews.length) {
    list.innerHTML = '<p class="hint">No Alignment reviews were found on this page.</p>';
    $('reviewPager').classList.add('hidden');
    renderSelectionStatus();
    return;
  }
  const filteredReviews = visibleReviews();
  if (!filteredReviews.length) {
    list.innerHTML = '<p class="hint">No Alignment reviews meet the selected completion threshold.</p>';
    $('reviewPager').classList.add('hidden');
    renderSelectionStatus();
    return;
  }
  const start = (state.currentPage - 1) * PAGE_SIZE;
  for (const review of filteredReviews.slice(start, start + PAGE_SIZE)) {
    try {
      const row = document.createElement('div');
      row.className = 'review-row';
    const retryable = ['failed', 'partial', 'running'].includes(review.migration?.status);
    const retryDelete = retryable
      ? `<span class="review-match ${review.migration.status === 'failed' ? 'unmatched' : ''}">${escapeHtml(review.migration.lmxClientLabel || review.lmxClient?.label || 'LMX')} · ${escapeHtml(review.migration.status)}</span><button type="button" class="delete-migration-btn">${review.migration?.assessmentId ? 'Release record (assessment stays in LMX)' : 'Release failed migration'}</button>`
      : null;
    const match = review.migrated && !retryable
      ? `<span class="review-match">Migrated to ${escapeHtml(review.migration?.lmxClientLabel || 'LMX')}${review.migration?.assessmentId ? ` · ${escapeHtml(review.migration.assessmentId)}` : ''}</span><button type="button" class="delete-migration-btn">Release migration record</button>`
      : retryDelete || (review.lmxClient
        ? `<span class="review-match">${escapeHtml(review.lmxClient.label)}</span><button type="button" class="remap-client-btn">Change</button>`
        : `<span class="review-match unmatched">No automatic match</span><div class="match-tools"><input class="input match-input" placeholder="Search LMX clients…" autocomplete="off" /><div class="match-results"></div></div>`);
    const source = sourceDisplay(review);
    row.innerHTML = `<input type="checkbox" ${review.selected ? 'checked' : ''} ${review.migrated && !retryable ? 'disabled' : ''} /><span class="review-main"><span class="review-source"><span class="review-client">${escapeHtml(source.name)}</span><span class="review-title">${escapeHtml(source.assessment)}</span><span class="review-meta"><span>Engineer: ${escapeHtml(review.engineerStatus || 'Unknown')}</span><span>vCIO: ${escapeHtml(review.vcioStatus || 'Unknown')}</span></span><span class="review-state">${reviewStatus(review)}</span></span><span class="review-target">${match}</span></span>`;
    const checkbox = row.querySelector('input[type="checkbox"]');
    checkbox.addEventListener('change', (event) => { review.selected = event.target.checked; persistSelections(); renderSelectionStatus(); });
    const deleteButton = row.querySelector('.delete-migration-btn');
    if (deleteButton) deleteButton.addEventListener('click', async () => {
      const assessmentId = review.migration?.assessmentId;
      const prompt = assessmentId
        ? `Release the local migration record for ${review.clientName}? The LMX assessment will remain in LMX and must be deleted there separately if needed.`
        : `Release the failed migration record for ${review.clientName}? No LMX assessment was created.`;
      if (!confirm(prompt)) return;
      deleteButton.disabled = true;
      const response = await send({ type: 'DELETE_ALIGNMENT_MIGRATION', reviewId: review.reviewId, assessmentId });
      if (!response.ok) {
        deleteButton.disabled = false;
        alert(`Could not delete the LMX assessment: ${response.error}`);
        return;
      }
      review.migrated = false;
      review.migration = null;
      review.selected = false;
      state.config.alignmentMigrations = response.data;
      state.savedSelections[review.reviewId] = false;
      persistSelections();
      renderReviews();
    });
    if (!review.lmxClient && (!review.migrated || retryable)) attachMatchSearch(row, review);
    if (review.lmxClient && !review.migrated) attachRemap(row, review);
      list.appendChild(row);
    } catch (error) {
      console.error('Could not render Alignment review row', review, error);
      const fallback = document.createElement('div');
      fallback.className = 'review-row';
      fallback.textContent = `${String(review.clientName || 'Unknown client')} — Unable to render this review row.`;
      list.appendChild(fallback);
    }
  }
  renderPager();
  renderSelectionStatus();
}

async function matchReviews() {
  if (!state.config?.apiKey) return;
  const response = await send({ type: 'LIST_LMX_CLIENTS' });
  const clients = response.ok ? response.data : [];
  const clientsByName = new Map();
  for (const client of clients) {
    const key = normalize(client.label);
    if (clientsByName.has(key)) clientsByName.set(key, null);
    else clientsByName.set(key, client);
  }
  for (const review of state.reviews) {
    const sourceName = sourceDisplay(review).name;
    const saved = state.config.clientMappings?.[review.clientName] || state.config.clientMappings?.[sourceName] || state.config.clientMappings?.[normalize(review.clientName)];
    const match = saved || clientsByName.get(normalize(sourceName));
    if (match) {
      review.lmxClient = { id: match.id, label: match.label };
      if (!saved) await send({ type: 'SAVE_CLIENT_MAPPING', soClientName: sourceName, lmxClient: review.lmxClient });
    }
  }
  renderReviews();
}

async function loadEvaluators() {
  const response = await send({ type: 'RECENT_EVALUATORS' });
  setReadiness('lmxReadiness', !!response.ok, response.ok ? 'API connected' : 'API unavailable');
  const select = $('evaluatorSelect');
  select.innerHTML = '';
  if (response.ok && response.data.length) {
    for (const user of response.data) { const option = document.createElement('option'); option.value = user.user_id; option.textContent = `${user.first_name} ${user.last_name} (${user.email})`; select.appendChild(option); }
    if (state.config.evaluateUserId) select.value = state.config.evaluateUserId;
  } else select.innerHTML = '<option value="">No active LMX users found</option>';
  renderSelectionStatus();
}

async function extractCurrentPage() {
  const tab = await activeTab();
  const type = pageType(tab?.url);
  state.currentPageType = type;
  if (!tab?.id || !type) {
    setReadiness('myitpReadiness', false, 'Page unavailable');
    $('pageStatus').textContent = 'Open the My IT Process Alignment list or a review page, then reopen this popup.';
    return;
  }
  const messageType = type === 'list' ? 'MYITP_EXTRACT_REVIEWS' : 'MYITP_EXTRACT_ALIGNMENT';
  const response = await new Promise((resolve) => chrome.tabs.sendMessage(tab.id, { type: messageType }, (result) => { if (chrome.runtime.lastError) return resolve(null); resolve(result); }));
  if (!response?.ok) {
    setReadiness('myitpReadiness', false, 'Session inactive');
    $('pageStatus').textContent = 'The Alignment page is still loading or the My IT Process session is inactive. Reopen the popup and try again.';
    return;
  }
  setReadiness('myitpReadiness', true, 'Ready');
  if (type === 'list') {
    state.reviews = (response.reviews || []).map((review) => {
      const migration = state.config.alignmentMigrations?.[review.reviewId];
      const migrated = !!migration && (migration.status || 'completed') === 'completed';
      return { ...review, migration, migrated, selected: !migrated && !!state.savedSelections[review.reviewId] };
    });
    renderReviews();
    await matchReviews();
  } else {
    $('pageStatus').textContent = 'This is an individual review. Open the Alignment list to select clients.';
    $('reviewList').innerHTML = '<p class="hint">Navigate to /alignment to load the client review list.</p>';
  }
}

$('settingsToggleBtn').addEventListener('click', () => {
  const panel = $('settingsPanel');
  panel.open = !panel.open;
});

$('previousPageBtn').addEventListener('click', () => { if (state.currentPage > 1) { state.currentPage--; renderReviews(); } });
  $('nextPageBtn').addEventListener('click', () => { const totalPages = Math.ceil(visibleReviews().length / PAGE_SIZE); if (state.currentPage < totalPages) { state.currentPage++; renderReviews(); } });
$('reviewFilter').addEventListener('change', (event) => { state.filter = event.target.value; state.currentPage = 1; renderReviews(); });
$('completionFilter').addEventListener('input', (event) => {
  state.minimumCompletion = Number(event.target.value) || 0;
  $('completionFilterValue').textContent = `${state.minimumCompletion}%`;
  state.currentPage = 1;
  renderReviews();
});
$('saveKeyBtn').addEventListener('click', async () => { const apiKey = $('apiKeyInput').value.trim(); if (!apiKey) return; await send({ type: 'SET_API_KEY', apiKey }); state.config.apiKey = apiKey; renderSettings(); await loadEvaluators(); await matchReviews(); });
$('evaluatorSelect').addEventListener('change', async (event) => { state.config.evaluateUserId = event.target.value; await send({ type: 'SET_EVALUATE_USER', evaluateUserId: event.target.value }); renderSelectionStatus(); });
$('migrateBtn').addEventListener('click', async () => {
  const selected = state.reviews.filter((review) => review.selected && review.lmxClient);
  if (!selected.length) return;
  const sourceTab = await activeTab();
  await chrome.storage.local.set({ pendingAlignmentMigration: { reviews: selected, evaluateUserId: state.config.evaluateUserId, sourceTabId: sourceTab?.id } });
  await chrome.tabs.create({ url: chrome.runtime.getURL('migration.html'), active: true });
  window.close();
});

(async function init() {
  const configResponse = await send({ type: 'GET_CONFIG' });
  state.config = configResponse.data;
  $('extensionVersion').textContent = `Version ${state.config.extensionVersion || 'unknown'}`;
  const stored = await chrome.storage.local.get([SELECTION_STORAGE_KEY, 'alignmentMigrations']);
  state.savedSelections = stored[SELECTION_STORAGE_KEY] || {};
  state.config.alignmentMigrations = stored.alignmentMigrations || {};
  const verifiedMigrations = await send({ type: 'VERIFY_ALIGNMENT_MIGRATIONS' });
  if (verifiedMigrations.ok) state.config.alignmentMigrations = verifiedMigrations.data;
  setReadiness('myitpReadiness', false, 'Checking…');
  setReadiness('lmxReadiness', false, state.config.apiKey ? 'Checking…' : 'API key required');
  renderSettings();
  if (state.config.apiKey) await loadEvaluators();
  const templateResponse = await send({ type: 'GET_ALIGNMENT_TEMPLATE' });
  if (templateResponse.ok && templateResponse.data) $('templateStatus').textContent = `Using ${templateResponse.data.title} (${templateResponse.data.templateId}).`;
  await extractCurrentPage();
})();
