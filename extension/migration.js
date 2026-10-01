const logElement = document.getElementById('migrationLog');
const stateElement = document.getElementById('migrationState');
const summaryElement = document.getElementById('migrationSummary');
const previewElement = document.getElementById('migrationPreview');
const startButton = document.getElementById('startMigrationBtn');
const retryButton = document.getElementById('retryMigrationBtn');
const summarySection = document.getElementById('migrationSummarySection');
const summaryList = document.getElementById('migrationSummaryList');

function send(message) { return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve)); }
function write(message) {
  logElement.textContent += `[${new Date().toLocaleTimeString()}] ${message}\n`;
  logElement.scrollTop = logElement.scrollHeight;
}

function renderSummary(payload, results) {
  summaryList.innerHTML = '';
  for (const review of payload.reviews) {
    const result = results.find((item) => item.reviewId === review.reviewId);
    const failed = !!result?.error;
    const warning = !!result && !failed && !!result.partial;
    const success = !!result && !failed;
    const details = document.createElement('details');
    details.className = 'summary-accordion';
    const answered = result?.answeredCount || 0;
    const expected = result?.expectedQuestionCount || 0;
    const unmatched = result?.unmatched || [];
    const unanswered = result?.unanswered || [];
    const failures = [];
    if (result?.error) failures.push(result.error);
    failures.push(...unmatched.map((item) => `Unmatched template item: ${item}`));
    failures.push(...unanswered.map((item) => `No Engineer response: ${item}`));
    if (result?.evaluationFailures) failures.push(`${result.evaluationFailures} answer batch(es) failed to write.`);
    if (result?.commentFailures) failures.push(`${result.commentFailures} technical-analysis comment(s) failed to write.`);
    const statusLabel = failed ? 'Failed to create' : warning ? 'Completed with warnings' : 'Completed';
    details.innerHTML = `<summary><span class="summary-client">${escapeHtml(review.clientName || 'Unknown client')}</span><span class="summary-success"><input type="checkbox" ${success ? 'checked' : ''} disabled /> ${statusLabel}</span></summary><div class="summary-detail"><div class="summary-metrics"><span><strong>Assessment:</strong> ${escapeHtml(result?.assessmentId || 'Not created')}</span><span><strong>Questions extracted:</strong> ${expected || '—'}</span><span><strong>Answers written:</strong> ${answered}</span><span><strong>Warnings:</strong> ${failures.length}</span></div>${failures.length ? `<div class="summary-failures"><strong>Details</strong><ul>${failures.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : '<p class="summary-clear">All selected questions and comments migrated successfully.</p>'}</div>`;
    summaryList.appendChild(details);
  }
  summarySection.classList.remove('hidden');
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function renderPreview(payload) {
  previewElement.innerHTML = `<div class="preview-grid preview-head"><span>My IT Process client</span><span>Assessment</span><span>LMX client</span><span>Source status</span></div>${payload.reviews.map((review) => `<div class="preview-grid preview-row"><strong>${escapeHtml(review.clientName)}</strong><span>${escapeHtml(review.reviewTitle || 'Alignment review')}</span><span>${escapeHtml(review.lmxClient?.label || 'No LMX match')}</span><span>${escapeHtml(review.bothComplete ? 'Complete' : 'In progress')}</span></div>`).join('')}`;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'MIGRATION_PROGRESS') write(message.message);
});

async function start(payload) {
  startButton.disabled = true;
  startButton.textContent = 'Migration running…';
  stateElement.textContent = 'Running';
  await chrome.storage.local.remove('pendingAlignmentMigration');
  write(`Starting ${payload.reviews.length} review migration(s)…`);
  const response = await send({ type: 'RUN_SELECTED_ALIGNMENT_MIGRATIONS', payload });
  if (response.ok) {
    const failedResults = (response.data.results || []).filter((result) => result.error);
    const warningResults = (response.data.results || []).filter((result) => !result.error && result.partial);
    const retryResults = (response.data.results || []).filter((result) => result.error || result.retryable);
    const failed = failedResults.length;
    stateElement.textContent = failed ? 'Needs attention' : warningResults.length ? 'Completed with warnings' : 'Finished';
    write(response.data.log.join('\n'));
    write(failed ? `Migration finished with ${failed} failed review(s). Failed items remain retryable.` : warningResults.length ? `Migration completed with warnings for ${warningResults.length} review(s).` : 'Migration process finished.');
    renderSummary(payload, response.data.results || []);
    if (retryResults.length) {
      const attentionIds = new Set(retryResults.map((result) => result.reviewId));
      const retryPayload = { ...payload, reviews: payload.reviews.filter((review) => attentionIds.has(review.reviewId)) };
      retryButton.textContent = `Retry ${retryPayload.reviews.length} item(s) needing attention`;
      retryButton.classList.remove('hidden');
      retryButton.disabled = false;
      retryButton.onclick = () => {
        retryButton.classList.add('hidden');
        write(`Retrying ${retryPayload.reviews.length} item(s) needing attention…`);
        start(retryPayload);
      };
    }
  } else {
    stateElement.textContent = 'Failed';
    write(`Error: ${response.error}`);
    renderSummary(payload, payload.reviews.map((review) => ({ reviewId: review.reviewId, error: response.error })));
    retryButton.classList.remove('hidden');
    retryButton.disabled = false;
    retryButton.onclick = () => {
      retryButton.classList.add('hidden');
      write(`Retrying ${payload.reviews.length} item(s)…`);
      start(payload);
    };
  }
  startButton.textContent = 'Migration finished';
}

(async () => {
  const stored = await chrome.storage.local.get('pendingAlignmentMigration');
  const payload = stored.pendingAlignmentMigration;
  if (!payload) {
    stateElement.textContent = 'No migration queued';
    write('No migration was queued. Return to the Alignment list and select a review.');
    return;
  }
  summaryElement.textContent = `${payload.reviews.length} review(s) selected · ${payload.reviews.filter((review) => review.lmxClient).length} LMX client match(es). Nothing is written until you press Start migration.`;
  renderPreview(payload);
  stateElement.textContent = 'Ready';
  write('Migration queued. The source My IT Process tab will remain unchanged.');
  startButton.addEventListener('click', () => start(payload), { once: true });
})();
