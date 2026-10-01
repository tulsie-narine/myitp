/**
 * My IT Process Alignment extractor.
 *
 * The Alignment list contains one review per row. A review opens at
 * /alignment/{reviewId}/view-details and renders category/question wrappers in the DOM.
 * This reads rendered values only; no My IT Process credentials or private
 * application storage are accessed.
 */

function alignmentPageType() {
  const path = window.location.pathname;
  if (/^\/alignment\/?$/.test(path)) return 'list';
  if (/^\/alignment\/\d+\/view-details(?:\/.*)?\/?$/.test(path)) return 'list';
  if (/^\/alignment\/\d+(?:\/view-details)?\/?$/.test(path)) return 'detail';
  return null;
}

function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function simplifyRepeatedName(value) {
  const text = cleanText(value);
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

function reportExtractionProgress(message) {
  chrome.runtime.sendMessage({ type: 'MIGRATION_PROGRESS', message }).catch(() => {});
}

function alignmentCategoryControls() {
  // The Alignment sidebar has used anchors, buttons, and role buttons across
  // My IT Process deployments. Match the visible category label instead of
  // depending on one specific element type.
  const candidates = Array.from(document.querySelectorAll('a, button, [role="button"], [role="tab"]'))
    .filter((element) => {
      const text = cleanText(element.textContent);
      return text.length <= 140 && /\(\d+\/\d+\)$/.test(text);
    });
  const controls = [];
  const seenLabels = new Set();
  for (const element of candidates) {
    const matchingParent = element.parentElement?.closest('a, button, [role="button"], [role="tab"]');
    if (matchingParent && /\(\d+\/\d+\)$/.test(cleanText(matchingParent.textContent))) continue;
    const label = cleanText(element.textContent);
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    controls.push(element);
  }
  return controls;
}

function reviewIdFromHref(href) {
  const match = (href || '').match(/\/alignment\/(\d+)/);
  return match ? match[1] : null;
}

function completionState(text) {
  return /submitted|complete|completed/i.test(cleanText(text)) ? 'complete' : 'in_progress';
}

function reviewerName(statusText) {
  return cleanText(statusText)
    .replace(/\s*\((?:due|submitted)[^)]+\)\s*\d+%?\s*$/i, '')
    .trim();
}

function readVisibleAlignmentReviews() {
  const rows = Array.from(document.querySelectorAll('[role="row"]')).filter((row) => {
    return row.querySelector('a[href*="/alignment/"]');
  });

  return rows.map((row) => {
    const links = Array.from(row.querySelectorAll('a[href*="/alignment/"]'));
    const detailsLink = links.find((link) => /details/i.test(link.textContent)) || links[0];
    const reviewId = reviewIdFromHref(detailsLink?.getAttribute('href'));
    if (!reviewId) return null;

    const cells = Array.from(row.querySelectorAll('[role="gridcell"]'));
    const nameParts = Array.from(cells[1]?.querySelectorAll('div, span') || [])
      .map((el) => cleanText(el.textContent)).filter(Boolean);
    const clientName = simplifyRepeatedName(nameParts[0] || cleanText(cells[1]?.textContent).replace(/\s+(Onboarding|Review).*$/i, ''));
    const reviewTitle = nameParts[1] || cleanText(cells[1]?.textContent);
    const statusCells = cells.slice(3, 5).map((cell) => cleanText(cell.textContent));
    const engineerState = completionState(statusCells[0]);
    const vcioState = completionState(statusCells[1]);

    const detailsHref = detailsLink?.getAttribute('href');
    const reviewUrl = detailsHref
      ? new URL(detailsHref, window.location.href).href
      : new URL(`/alignment/${reviewId}/view-details`, window.location.origin).href;

    return {
      reviewId,
      clientName,
      reviewTitle,
      reviewUrl,
      engineerStatus: statusCells[0] || '',
      vcioStatus: statusCells[1] || '',
      engineerReviewName: reviewerName(statusCells[0]),
      vcioReviewName: reviewerName(statusCells[1]),
      engineerState,
      vcioState,
      bothComplete: engineerState === 'complete' && vcioState === 'complete',
    };
  }).filter(Boolean);
}

async function extractAlignmentReviews() {
  const allReviews = new Map();
  const collect = () => {
    for (const review of readVisibleAlignmentReviews()) allReviews.set(review.reviewId, review);
  };

  for (let page = 0; page < 20; page++) {
    collect();
    const next = document.querySelector('#nextPage, [role="button"][aria-label="fa-chevron-right"]');
    if (!next || next.getAttribute('aria-disabled') === 'true' || next.classList.contains('dx-state-disabled')) break;
    next.click();
    await new Promise((resolve) => setTimeout(resolve, 180));
  }

  const firstPage = document.querySelector('[role="button"][aria-label="1"], #pageIndexEl');
  if (firstPage && firstPage.getAttribute('aria-disabled') !== 'true' && !firstPage.classList.contains('page-index-button-selected')) {
    firstPage.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return Array.from(allReviews.values());
}

function selectedResponse(wrapper, selector) {
  return cleanText(wrapper.querySelector(`${selector} .selected`)?.textContent) || null;
}

function selectedAlignmentResponse(wrapper) {
  const engineerResponse = selectedResponse(wrapper, '.engineer-buttons') || selectedResponse(wrapper, '[class*="engineer"]');
  if (engineerResponse) return { response: engineerResponse, source: 'engineer' };
  const vcioResponse = selectedResponse(wrapper, '.vcio-buttons') || selectedResponse(wrapper, '[class*="vcio"]');
  if (vcioResponse) return { response: vcioResponse, source: 'vcio' };
  const genericResponse = cleanText(wrapper.querySelector('button.selected')?.textContent) || null;
  return { response: genericResponse, source: genericResponse ? 'alignment' : null };
}

function readSelectedAlignment(wrapper) {
  const labels = ['Aligned', 'Marginal', 'Vulnerable', 'N/A'];
  const button = Array.from(wrapper.querySelectorAll('button')).find((candidate) => {
    const label = cleanText(candidate.textContent);
    return labels.includes(label) && (candidate.classList.contains('selected') || candidate.getAttribute('aria-pressed') === 'true');
  });
  const prompt = Array.from(wrapper.querySelectorAll('*'))
    .map((element) => cleanText(element.textContent))
    .find((text) => /^How well aligned is this answer with your best practices\??$/i.test(text));
  return {
    prompt: prompt || 'How well aligned is this answer with your best practices?',
    response: button ? cleanText(button.textContent) : null,
  };
}

function readTechnicalAnalysis(wrapper) {
  const direct = wrapper.querySelector([
    'textarea[placeholder*="Technical Analysis"]',
    'textarea[name*="technical" i]',
    '[data-testid*="technical-analysis" i]',
    '[contenteditable="true"][aria-label*="technical" i]',
  ].join(','));
  const directText = direct?.value || direct?.textContent;
  if (cleanText(directText)) return cleanText(directText);

  // Submitted reviews render this field as read-only text rather than a textarea.
  const renderedCandidates = Array.from(wrapper.querySelectorAll('div, p, span'))
    .filter((element) => {
      const text = cleanText(element.innerText || element.textContent);
      return /^Technical\s+analysis\s*:/i.test(text) && text.length <= 1000 && !element.querySelector('button, textarea, [contenteditable="true"]');
    });
  for (const candidate of renderedCandidates) {
    const text = cleanText(candidate.innerText || candidate.textContent);
    const match = text.match(/^Technical\s+analysis\s*:\s*(.*)$/i);
    if (match && cleanText(match[1])) return cleanText(match[1]);
  }
  return '';
}

function readVisibleAlignmentQuestions() {
  const wrappers = Array.from(document.querySelectorAll('.question-wrapper'));
  return wrappers.map((wrapper, index) => {
    const label = cleanText(wrapper.querySelector('.mitp-question-label')?.textContent);
    const questionText = cleanText(wrapper.querySelector('#questionText')?.textContent);
    const selectedButton = wrapper.querySelector('.engineer-buttons .selected');
    const firstButton = wrapper.querySelector('.engineer-buttons button');
    const rawId = selectedButton?.id || firstButton?.id || '';
    const idMatch = rawId.match(/(\d+)$/);
    const selected = selectedAlignmentResponse(wrapper);
    const alignment = readSelectedAlignment(wrapper);
    return {
      index,
      category: label.includes(' - ') ? label.replace(/^\d+\.\s*/, '').split(' - ')[0].trim() : '',
      title: label.replace(/^\d+\.\s*/, ''),
      question: questionText,
      response: selected.response,
      engineerResponse: selected.source === 'engineer' ? selected.response : null,
      vcioResponse: selected.source === 'vcio' ? selected.response : null,
      responseSource: selected.source,
      alignmentPrompt: alignment.prompt,
      alignmentResponse: alignment.response,
      technicalAnalysis: readTechnicalAnalysis(wrapper),
      sourceQuestionId: idMatch ? idMatch[1] : null,
    };
  }).filter((item) => item.title || item.question);
}

async function extractAlignmentQuestions() {
  let categoryLinks = [];
  for (let attempt = 1; attempt <= 60; attempt++) {
    categoryLinks = alignmentCategoryControls();
    if (categoryLinks.length) break;
    reportExtractionProgress(`Waiting for My IT Process Alignment categories to render (${attempt}/60)…`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!categoryLinks.length) throw new Error('My IT Process Alignment categories did not render.');
  reportExtractionProgress(`Found ${categoryLinks.length} Alignment category controls; extracting rendered questions…`);
  const expectedQuestionCount = categoryLinks.reduce((total, link) => {
    const match = cleanText(link.textContent).match(/\((\d+)\/(\d+)\)$/);
    return total + (match ? Number(match[2]) : 0);
  }, 0);
  const allQuestions = new Map();
  reportExtractionProgress(`Questionnaire loaded; found ${categoryLinks.length} Alignment categories and ${document.querySelectorAll('.question-wrapper').length} question wrapper(s).`);

  const collect = () => {
    for (const item of readVisibleAlignmentQuestions()) {
      // Titles are not unique in every Alignment category. Use the source
      // question id when available so repeated labels are preserved.
      // Some unanswered questions do not expose an id in the DOM. Use the
      // rendered question text as a stable fallback; wrapper indexes change
      // as categories are clicked and must not be used as identity.
      const key = `${item.category}:${item.sourceQuestionId || `${item.title}:${item.question}`}`;
      if (!allQuestions.has(key)) allQuestions.set(key, item);
    }
  };

  collect();
  for (let index = 0; index < categoryLinks.length; index++) {
    const link = categoryLinks[index];
    link.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    collect();
    reportExtractionProgress(`Read category ${index + 1}/${categoryLinks.length}: ${cleanText(link.textContent)} · collected ${allQuestions.size} question(s).`);
  }

  return {
    questions: Array.from(allQuestions.values()),
    categoryCount: categoryLinks.length,
    expectedQuestionCount,
    pageType: alignmentPageType(),
    sourceUrl: window.location.href,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'MYITP_EXTRACT_REVIEWS') {
    extractAlignmentReviews()
      .then((reviews) => sendResponse({ ok: true, pageType: alignmentPageType(), reviews }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === 'MYITP_EXTRACT_ALIGNMENT') {
    extractAlignmentQuestions()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
});
