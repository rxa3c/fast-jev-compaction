const state = {
  events: [],
  selectedId: null,
  lastId: null,
  timer: null,
};

const labels = {
  session_start_received: 'SessionStart received',
  session_start_no_pending: 'No pending note',
  precompact_started: 'PreCompact started',
  rollout_parsed: 'Rollout parsed',
  jev_request_started: 'TypeSafe request started',
  jev_response_received: 'Jev response received',
  jev_request_failed: 'Jev request failed',
  plan_ready: 'Jev plan ready',
  fallback: 'Native fallback',
  recovery_note_ready: 'Recovery note ready',
  recovery_note_missing: 'Recovery note missing',
  recovery_note_loaded: 'Recovery note loaded',
};

const elements = {
  count: document.querySelector('#event-count'),
  latest: document.querySelector('#latest-phase'),
  traceFile: document.querySelector('#trace-file'),
  connection: document.querySelector('#connection-state'),
  updated: document.querySelector('#last-updated'),
  list: document.querySelector('#event-list'),
  detail: document.querySelector('#event-detail'),
  refresh: document.querySelector('#refresh-button'),
  clear: document.querySelector('#clear-button'),
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function eventLabel(event) {
  return labels[event?.event] || event?.event || 'Unknown event';
}

function eventTone(event) {
  const name = event?.event || '';
  if (name.includes('failed') || name === 'fallback' || name.includes('missing')) return 'failed';
  if (name === 'plan_ready') return 'plan';
  if (name.includes('request')) return 'request';
  if (name.includes('recovery') || name.includes('pending')) return 'note';
  return 'lifecycle';
}

function formatTime(timestamp, withDate = false) {
  if (!timestamp) return '--:--:--';
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: withDate ? 'medium' : undefined,
    timeStyle: 'medium',
  }).format(date);
}

function formatNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—';
}

function formatRatio(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
}

function preview(value, limit = 260) {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function tag(label, value) {
  if (value === undefined || value === null || value === '') return '';
  return `<span class="tag"><strong>${escapeHtml(label)}</strong> ${escapeHtml(value)}</span>`;
}

function metric(label, value) {
  return `<div class="metric-line"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderEventList() {
  if (state.events.length === 0) {
    elements.list.innerHTML = '<div class="empty-list">No Codex lifecycle events recorded.</div>';
    return;
  }

  elements.list.innerHTML = state.events
    .map((event) => {
      const selected = event.id === state.selectedId ? ' selected' : '';
      const tone = eventTone(event);
      const secondary = event.summary || event.reason || event.source || event.trigger || event.event;
      return `
        <button class="event-row ${tone}${selected}" type="button" role="option" aria-selected="${event.id === state.selectedId}" data-event-id="${escapeHtml(event.id)}">
          <span class="event-marker" aria-hidden="true"></span>
          <span class="event-row-body">
            <span class="event-title"><span>${escapeHtml(eventLabel(event))}</span><time>${escapeHtml(formatTime(event.timestamp))}</time></span>
            <span class="event-meta"><code>${escapeHtml(preview(secondary, 70))}</code></span>
          </span>
        </button>`;
    })
    .join('');
}

function score(value) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return `<span class="score-line"><span class="score-bar" aria-hidden="true" style="--score: ${Math.round(number * 100)}%"><span></span></span><span class="score-value">${Math.round(number * 100)}%</span></span>`;
}

function actionRows(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return '';
  return `
    <section class="detail-section">
      <div class="section-title"><h3>TOOL DECISIONS</h3><span>${actions.length} candidate${actions.length === 1 ? '' : 's'}</span></div>
      <div class="actions-table-wrap">
        <table class="actions-table">
          <thead><tr><th>Tool</th><th>Action</th><th>Keep call</th><th>Keep result</th><th>Reason / previews</th></tr></thead>
          <tbody>
            ${actions.map((action) => `
              <tr>
                <td class="action-tool">${escapeHtml(action.tool || action.callId || 'unknown')}</td>
                <td>${escapeHtml(action.action || '—')}</td>
                <td>${score(action.keepCall)}</td>
                <td>${score(action.keepResult)}</td>
                <td>
                  ${escapeHtml(action.reason || '—')}
                  ${action.inputPreview ? `<div class="preview">input: ${escapeHtml(preview(action.inputPreview))}</div>` : ''}
                  ${action.resultPreview ? `<div class="preview">result: ${escapeHtml(preview(action.resultPreview))}</div>` : ''}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>`;
}

function eventMetrics(event) {
  const rows = [];
  if (event.source) rows.push(metric('source', event.source));
  if (event.trigger) rows.push(metric('trigger', event.trigger));
  if (event.lineCount !== undefined) rows.push(metric('rollout lines', formatNumber(event.lineCount)));
  if (event.activeItemCount !== undefined) rows.push(metric('active items', formatNumber(event.activeItemCount)));
  if (event.calls !== undefined) rows.push(metric('tool calls', formatNumber(event.calls)));
  if (event.requests !== undefined) rows.push(metric('requests', formatNumber(event.requests)));
  if (event.callCount !== undefined) rows.push(metric('request batches', formatNumber(event.callCount)));
  if (event.questionCount !== undefined) rows.push(metric('questions', formatNumber(event.questionCount)));
  if (event.answerCount !== undefined) rows.push(metric('answers', formatNumber(event.answerCount)));
  if (event.stateChars !== undefined) rows.push(metric('state chars', formatNumber(event.stateChars)));
  if (event.durationMs !== undefined) rows.push(metric('duration', `${formatNumber(event.durationMs)} ms`));
  if (event.reductionRatio !== undefined) rows.push(metric('reduction', formatRatio(event.reductionRatio)));
  if (event.noteChars !== undefined) rows.push(metric('note chars', formatNumber(event.noteChars)));
  if (rows.length === 0) return '';
  return `<section class="detail-section"><div class="section-title"><h3>EVENT METRICS</h3></div><div class="metric-grid">${rows.join('')}</div></section>`;
}

function eventDetail(event) {
  if (!event) {
    return `<div class="detail-empty"><div><strong>Waiting for a real Codex event</strong><p>The viewer will show PreCompact, Jev, and recovery events as they arrive.</p></div></div>`;
  }

  const error = event.error || (event.event === 'fallback' ? event.reason : '');
  const summary = event.summary || event.reason || '';
  return `
    <div class="detail-header">
      <div>
        <h2>${escapeHtml(eventLabel(event))}</h2>
        <div class="detail-meta">
          ${tag('event', event.event)}
          ${tag('session', event.sessionId)}
          ${tag('source', event.source)}
          ${tag('trigger', event.trigger)}
        </div>
      </div>
      <time>${escapeHtml(formatTime(event.timestamp, true))}</time>
    </div>
    ${summary ? `<section class="detail-section"><div class="section-title"><h3>SUMMARY</h3></div><p class="summary">${escapeHtml(summary)}</p></section>` : ''}
    ${error ? `<section class="detail-section"><div class="error-box">${escapeHtml(error)}</div></section>` : ''}
    ${eventMetrics(event)}
    ${actionRows(event.actions)}
    <details class="raw-details"><summary>View raw event</summary><pre>${escapeHtml(JSON.stringify(event, null, 2))}</pre></details>`;
}

function render() {
  const latest = state.events.at(-1);
  elements.count.textContent = state.events.length.toLocaleString();
  elements.latest.textContent = latest ? eventLabel(latest) : 'Waiting';
  renderEventList();
  elements.detail.innerHTML = eventDetail(state.events.find((event) => event.id === state.selectedId));
}

function setConnection(status, message) {
  elements.connection.className = `connection-state ${status}`;
  elements.connection.innerHTML = `<span class="connection-light" aria-hidden="true"></span><span>${escapeHtml(message)}</span>`;
}

async function loadEvents() {
  try {
    const response = await fetch('/api/events', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const previousLastId = state.events.at(-1)?.id;
    state.events = Array.isArray(payload.events) ? payload.events : [];
    const nextLastId = state.events.at(-1)?.id;
    if (!state.selectedId || state.selectedId === previousLastId || !state.events.some((event) => event.id === state.selectedId)) {
      state.selectedId = nextLastId || null;
    }
    state.lastId = nextLastId || null;
    elements.traceFile.textContent = payload.traceFile || 'Default trace path';
    elements.updated.textContent = payload.updatedAt ? `updated ${formatTime(payload.updatedAt)}` : 'Waiting for trace data';
    setConnection('online', 'Connected');
    render();
  } catch (error) {
    setConnection('error', 'Viewer server unavailable');
    elements.updated.textContent = error instanceof Error ? error.message : 'Unable to read events';
  }
}

async function clearEvents() {
  if (!window.confirm('Clear the local Codex trace?')) return;
  try {
    const response = await fetch('/api/clear', { method: 'POST' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.selectedId = null;
    await loadEvents();
  } catch (error) {
    setConnection('error', error instanceof Error ? error.message : 'Unable to clear events');
  }
}

elements.list.addEventListener('click', (event) => {
  const row = event.target.closest('[data-event-id]');
  if (!row) return;
  state.selectedId = row.dataset.eventId;
  render();
});
elements.refresh.addEventListener('click', loadEvents);
elements.clear.addEventListener('click', clearEvents);

loadEvents();
state.timer = window.setInterval(loadEvents, 700);
