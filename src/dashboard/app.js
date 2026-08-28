/**
 * @fileoverview Dashboard client. Zero dependencies, no build step.
 *
 * Conventions used throughout:
 *  - All interaction is delegated from container elements via `data-action`
 *    attributes. Nothing is wired through inline `onclick`, which is what
 *    previously broke on provider names and JSON containing quotes.
 *  - Every render function is idempotent and skipped when its input signature
 *    has not changed, so a 2s poll cannot steal focus or close an open
 *    <select>.
 */

'use strict';

// ============================================================== small utils

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

/** Escapes text for interpolation into innerHTML. */
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, char => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

/** Escapes a value for use inside an HTML attribute. */
const attr = value => esc(value);

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours < 24) return `${hours}h ${minutes}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatMs(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString();
}

/** Stable signature used to decide whether a re-render is needed. */
const signature = value => JSON.stringify(value);

// ==================================================================== state

const state = {
  status: null,
  meta: null,
  providers: [],
  logs: [],
  settings: null,
  integrations: null,
  /** provider name -> { running, result } */
  tests: new Map(),
  /** provider name -> revealed key */
  revealed: new Map(),
  view: 'overview',
  online: false,
  logFilter: { provider: '', status: '' },
  autoRefreshLogs: true,
  rendered: {}
};

const POLL_MS = 2000;

// ============================================================== api helper

/**
 * Calls the local REST API.
 * @param {string} endpoint
 * @param {{method?:string, body?:Object, quiet?:boolean}} [options]
 * @returns {Promise<Object|null>} parsed body, or null on transport failure
 */
async function api(endpoint, options = {}) {
  try {
    const response = await fetch(endpoint, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await response.json().catch(() => null);
    if (!response.ok && data && !data.error) data.error = `HTTP ${response.status}`;
    return data;
  } catch (error) {
    if (!options.quiet) console.warn(`API ${endpoint} failed: ${error.message}`);
    return null;
  }
}

/** Runs a mutation, shows the outcome, and refreshes affected data. */
async function mutate(endpoint, options, successMessage) {
  const data = await api(endpoint, options);
  if (data && data.ok) {
    toast(successMessage || data.message || 'Done', 'ok');
    return data;
  }
  toast(data?.error || 'The request failed', 'error');
  return null;
}

// =================================================================== toasts

function toast(message, kind = 'info') {
  const node = document.createElement('div');
  node.className = `toast is-${kind}`;
  node.innerHTML = `<span aria-hidden="true">${kind === 'error' ? '✖' : kind === 'ok' ? '✔' : 'ℹ'}</span><span>${esc(message)}</span>`;
  $('#toasts').append(node);

  setTimeout(() => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 200);
  }, kind === 'error' ? 6000 : 3200);
}

// ==================================================================== theme

const THEME_KEY = 'ai-proxy-theme';

function systemTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme) {
  const resolved = theme === 'system' ? systemTheme() : theme;
  document.documentElement.dataset.theme = resolved;
  $('#theme-icon').textContent = resolved === 'light' ? '☀' : '☾';
  $('#theme-toggle').title = `Theme: ${theme}${theme === 'system' ? ` (${resolved})` : ''}`;
}

function initTheme() {
  const stored = localStorage.getItem(THEME_KEY) || 'system';
  applyTheme(stored);
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if ((localStorage.getItem(THEME_KEY) || 'system') === 'system') applyTheme('system');
  });

  $('#theme-toggle').addEventListener('click', () => {
    const order = ['system', 'light', 'dark'];
    const current = localStorage.getItem(THEME_KEY) || 'system';
    const next = order[(order.indexOf(current) + 1) % order.length];
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
    // Mirror the choice into config.json so the CLI/other browsers agree.
    api('/api/settings', { method: 'PUT', body: { theme: next }, quiet: true });
  });
}

// =================================================================== router

function setView(view) {
  state.view = view;
  for (const section of $$('.view')) section.hidden = section.id !== `view-${view}`;
  for (const item of $$('.nav-item')) {
    const isCurrent = item.dataset.view === view;
    if (isCurrent) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  renderAll();
}

function initRouter() {
  for (const item of $$('.nav-item')) {
    item.addEventListener('click', () => setView(item.dataset.view));
  }
  for (const button of $$('[data-goto]')) {
    button.addEventListener('click', () => setView(button.dataset.goto));
  }
  const initial = location.hash.replace('#', '');
  setView(['overview', 'providers', 'requests', 'setup', 'settings'].includes(initial) ? initial : 'overview');
}

// ========================================================== overlay manager

let openOverlay = null;
let lastFocused = null;

function anyOverlayOpen() {
  return Boolean(openOverlay);
}

function showOverlay(id, focusSelector) {
  lastFocused = document.activeElement;
  const overlay = $(id);
  overlay.classList.add('is-open');
  openOverlay = overlay;
  const target = focusSelector ? overlay.querySelector(focusSelector) : null;
  (target || overlay.querySelector('button, input, textarea, select'))?.focus();
}

function hideOverlay(overlay) {
  const node = overlay || openOverlay;
  if (!node) return;
  node.classList.remove('is-open');
  if (node === openOverlay) openOverlay = null;
  if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
  node.dispatchEvent(new CustomEvent('overlay:close'));
}

function initOverlays() {
  for (const overlay of $$('.overlay')) {
    // Click on the backdrop (not the dialog) closes.
    overlay.addEventListener('mousedown', event => {
      if (event.target === overlay) hideOverlay(overlay);
    });
  }
  for (const button of $$('[data-close-overlay]')) {
    button.addEventListener('click', () => hideOverlay(button.closest('.overlay')));
  }

  document.addEventListener('keydown', event => {
    if (!openOverlay) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      hideOverlay();
      return;
    }
    if (event.key !== 'Tab') return;

    // Focus trap.
    const focusable = Array.from(
      openOverlay.querySelectorAll('button, input, textarea, select, [href], [tabindex]:not([tabindex="-1"])')
    ).filter(node => !node.disabled && node.offsetParent !== null);
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

/**
 * Promise-based replacement for window.confirm (which blocks polling and
 * cannot be styled).
 * @param {{title:string, message:string, confirmLabel?:string}} options
 * @returns {Promise<boolean>}
 */
function confirmDialog({ title, message, confirmLabel = 'Confirm' }) {
  $('#confirm-title').textContent = title;
  $('#confirm-message').textContent = message;
  $('#confirm-accept').textContent = confirmLabel;
  showOverlay('#confirm-overlay', '#confirm-accept');

  return new Promise(resolve => {
    const overlay = $('#confirm-overlay');
    let settled = false;

    const done = answer => {
      if (settled) return;
      settled = true;
      $('#confirm-accept').removeEventListener('click', accept);
      $('#confirm-cancel').removeEventListener('click', cancel);
      overlay.removeEventListener('overlay:close', dismissed);
      if (overlay.classList.contains('is-open')) hideOverlay(overlay);
      resolve(answer);
    };
    const accept = () => done(true);
    const cancel = () => done(false);
    // Escape or a backdrop click counts as "no".
    const dismissed = () => done(false);

    $('#confirm-accept').addEventListener('click', accept);
    $('#confirm-cancel').addEventListener('click', cancel);
    overlay.addEventListener('overlay:close', dismissed);
  });
}

/** Copies text and reports it. */
async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, 'ok');
  } catch {
    toast('Clipboard access was blocked by the browser', 'error');
  }
}

// ============================================================ data plumbing

async function refreshStatus() {
  const data = await api('/api/status', { quiet: true });
  state.online = Boolean(data && data.ok !== false);
  if (data) state.status = data;
  renderConnection();
  renderOverview();
}

async function refreshProviders() {
  const data = await api('/api/providers', { quiet: true });
  if (!data || !data.providers) return;
  state.providers = data.providers;
  renderProviders();
  renderOverview();
  renderLogFilterOptions();
}

async function refreshLogs() {
  const data = await api('/api/logs?limit=200', { quiet: true });
  if (!data || !data.logs) return;
  state.logs = data.logs;
  renderLogs();
  renderOverview();
}

let themeSyncedFromServer = false;

async function refreshSettings() {
  const data = await api('/api/settings', { quiet: true });
  if (!data || !data.ok) return;
  state.settings = { ...data.settings, proxy_port: data.proxyPort };

  if (!themeSyncedFromServer && !localStorage.getItem(THEME_KEY) && data.settings.theme) {
    themeSyncedFromServer = true;
    applyTheme(data.settings.theme);
  }
  renderSettings();
}

async function refreshIntegrations() {
  const data = await api('/api/integrations', { quiet: true });
  if (data && data.ok) {
    state.integrations = data.integrations;
    renderSetup();
  }
}

async function refreshMeta() {
  const data = await api('/api/meta', { quiet: true });
  if (data && data.ok) {
    state.meta = data;
    $('#app-version').textContent = `v${data.version}`;
    $('#config-path').textContent = data.configPath;
    renderSetup();
  }
}

function renderAll() {
  renderConnection();
  renderOverview();
  renderProviders();
  renderLogs();
  renderSetup();
  renderSettings();
}

function startPolling() {
  setInterval(() => {
    // Nothing to update while the tab is in the background.
    if (document.hidden) return;
    refreshStatus();
    refreshProviders();
    if (state.autoRefreshLogs) refreshLogs();
  }, POLL_MS);

  // Slower cadence: these only change when the user acts.
  setInterval(() => {
    if (document.hidden) return;
    refreshIntegrations();
  }, 15000);
}

// ============================================================== connection

function renderConnection() {
  const pill = $('#conn-pill');
  const text = $('#conn-text');
  const port = state.status?.port ?? state.meta?.port;

  if (!state.online) {
    pill.className = 'pill pill-danger';
    text.textContent = 'Daemon unreachable';
    return;
  }
  if (state.status?.configError) {
    pill.className = 'pill pill-warn';
    text.textContent = 'Config error';
    return;
  }
  pill.className = 'pill pill-ok';
  pill.querySelector('.dot').classList.add('dot-pulse');
  text.textContent = `Online · :${port ?? '—'}`;
}

// ================================================================= overview

function renderOverview() {
  const status = state.status;
  if (!status) return;

  const active = state.providers.find(provider => provider.isActive);
  const withKeys = state.providers.filter(provider => provider.hasKey).length;

  const view = {
    active: status.activeProvider,
    activeModel: active?.defaultModel ?? null,
    requests: status.totalRequests,
    buffer: status.logBufferSize,
    p50: status.p50Ms,
    p95: status.p95Ms,
    errors: status.errorCount,
    errorRate: status.errorRate,
    providers: status.providerCount,
    withKeys,
    uptime: status.uptimeSeconds,
    port: status.port,
    recent: state.logs.slice(-6).map(log => log.id + ':' + (log.statusCode ?? 'p')),
    activeCard: active ? signature(active) : null,
    test: active ? signature(state.tests.get(active.name) ?? null) : null
  };
  if (state.rendered.overview === signature(view)) return;
  state.rendered.overview = signature(view);

  $('#tile-active').textContent = status.activeProvider || 'none';
  $('#tile-active-sub').textContent = active
    ? (active.defaultModel || 'pass-through (client decides)')
    : 'run: ai-proxy use <name>';
  $('#tile-requests').textContent = status.totalRequests;
  $('#tile-requests-sub').textContent = `${status.logBufferSize} in history`;
  $('#tile-p50').textContent = formatMs(status.p50Ms);
  $('#tile-p95').textContent = `p95 ${formatMs(status.p95Ms)}`;
  $('#tile-errors').textContent = status.errorCount;
  $('#tile-errors').className = `tile-value ${status.errorCount ? 'is-danger' : 'is-ok'}`;
  $('#tile-error-rate').textContent = `${Math.round((status.errorRate || 0) * 100)}% of settled requests`;
  $('#tile-providers').textContent = status.providerCount;
  $('#tile-providers-sub').textContent = `${withKeys} with an API key`;
  $('#tile-uptime').textContent = formatDuration(status.uptimeSeconds);
  $('#tile-port').textContent = `port ${status.port ?? '—'}`;

  $('#nav-provider-count').textContent = status.providerCount || '';
  $('#nav-request-count').textContent = status.totalRequests || '';

  $('#active-route').innerHTML = active
    ? `<div class="provider-grid">${providerCardHtml(active)}</div>`
    : `<div class="empty">
         <span class="empty-icon" aria-hidden="true">◌</span>
         <strong>No active provider</strong>
         <span>Add one, then press “Use this” to route traffic through it.</span>
         <button class="btn btn-primary btn-sm" data-goto="providers">Go to providers</button>
       </div>`;

  const recent = state.logs.slice(-6).reverse();
  $('#recent-requests').innerHTML = recent.length
    ? logTableHtml(recent, { compact: true })
    : `<div class="empty">
         <span class="empty-icon" aria-hidden="true">≡</span>
         <strong>No requests yet</strong>
         <span>Start Claude Code with the proxy configured and traffic will show up here.</span>
       </div>`;

  for (const button of $$('#active-route [data-goto], #recent-requests [data-goto]')) {
    button.addEventListener('click', () => setView(button.dataset.goto));
  }
}

// ================================================================ providers

/**
 * Renders one provider card.
 * @param {Object} provider
 * @returns {string}
 */
function providerCardHtml(provider) {
  const name = provider.name;
  const models = provider.models || [];
  const test = state.tests.get(name);
  const revealed = state.revealed.get(name);

  const modelControl = models.length
    ? `<select class="model-select" data-action="switch-model" data-name="${attr(name)}"
               data-focus-key="model:${attr(name)}" aria-label="Active model for ${attr(name)}">
         ${models.map(model => `
           <option value="${attr(model)}" ${model === provider.defaultModel ? 'selected' : ''}>${esc(model)}</option>
         `).join('')}
         <option value="" ${provider.defaultModel ? '' : 'selected'}>— pass-through —</option>
       </select>`
    : `<span class="provider-value dim">pass-through (client decides)</span>`;

  const chips = models.length
    ? `<div class="model-chips">
         ${models.map(model => `
           <span class="chip ${model === provider.defaultModel ? 'is-active' : ''}">
             <span class="chip-label">${esc(model)}</span>
             <button class="chip-remove" data-action="remove-model" data-name="${attr(name)}"
                     data-model="${attr(model)}" data-focus-key="remove-model:${attr(name)}:${attr(model)}"
                     aria-label="Remove ${attr(model)} from ${attr(name)}" title="Remove model">✕</button>
           </span>`).join('')}
       </div>`
    : '';

  let testBlock = '';
  if (test?.running) {
    testBlock = `<div class="provider-test is-running"><span aria-hidden="true">◌</span><span>Testing…</span></div>`;
  } else if (test?.result) {
    const level = test.result.ok ? 'ok' : test.result.level === 'warn' ? 'warn' : 'error';
    const icon = level === 'ok' ? '✔' : level === 'warn' ? '▲' : '✖';
    testBlock = `<div class="provider-test is-${level}">
        <span aria-hidden="true">${icon}</span>
        <span>${esc(test.result.summary)}${test.result.latencyMs !== null ? ` · ${formatMs(test.result.latencyMs)}` : ''}
          ${test.result.detail ? `<span class="provider-test-detail">${esc(test.result.detail)}</span>` : ''}
        </span>
      </div>`;
  }

  const keyDisplay = revealed
    ? `<span class="provider-value">${esc(revealed)}</span>
       <button class="key-reveal" data-action="hide-key" data-name="${attr(name)}"
               data-focus-key="key:${attr(name)}">hide</button>`
    : provider.hasKey
      ? `<span class="provider-value">${esc(provider.keyPreview)}</span>
         <button class="key-reveal" data-action="reveal-key" data-name="${attr(name)}"
                 data-focus-key="key:${attr(name)}">reveal</button>`
      : `<span class="provider-value" style="color:var(--danger)">not set</span>`;

  return `
    <article class="provider-card ${provider.isActive ? 'is-active' : ''} ${provider.urlValid ? '' : 'is-invalid'}">
      <header class="provider-top">
        <h3 class="provider-name">${esc(name)}</h3>
        ${provider.isActive ? '<span class="pill pill-ok"><span class="dot"></span>Active</span>' : ''}
        ${provider.urlValid ? '' : '<span class="pill pill-danger">Bad URL</span>'}
      </header>

      <div class="provider-rows">
        <div class="provider-row">
          <span>URL</span>
          <span class="provider-value" title="${attr(provider.url)}">${esc(provider.url)}</span>
        </div>
        <div class="provider-row">
          <span>Model</span>
          ${modelControl}
        </div>
        <div class="provider-row">
          <span>Key</span>
          <span class="key-line">${keyDisplay}</span>
        </div>
      </div>

      ${chips}
      ${testBlock}

      <footer class="provider-actions">
        ${provider.isActive
          ? ''
          : `<button class="btn btn-sm btn-ok" data-action="activate" data-name="${attr(name)}"
                     data-focus-key="activate:${attr(name)}">Use this</button>`}
        <button class="btn btn-sm" data-action="test" data-name="${attr(name)}"
                data-focus-key="test:${attr(name)}">Test</button>
        <button class="btn btn-sm" data-action="edit" data-name="${attr(name)}"
                data-focus-key="edit:${attr(name)}">Edit</button>
        <button class="btn btn-sm" data-action="add-model" data-name="${attr(name)}"
                data-focus-key="add-model:${attr(name)}">+ Model</button>
        <button class="btn btn-sm btn-danger btn-icon" data-action="delete" data-name="${attr(name)}"
                data-focus-key="delete:${attr(name)}" aria-label="Delete ${attr(name)}" title="Delete provider">✕</button>
      </footer>
    </article>`;
}

function renderProviders() {
  const grid = $('#provider-grid');
  const view = {
    providers: state.providers,
    tests: Array.from(state.tests.entries()),
    revealed: Array.from(state.revealed.keys())
  };
  if (state.rendered.providers === signature(view)) return;

  // Never redraw underneath an open dropdown or an open dialog.
  const active = document.activeElement;
  if (anyOverlayOpen() || (active && active.tagName === 'SELECT' && grid.contains(active))) return;

  state.rendered.providers = signature(view);
  const focusKey = active?.dataset?.focusKey;

  $('#providers-count-label').textContent = state.providers.length
    ? `All providers (${state.providers.length})`
    : 'All providers';

  grid.innerHTML = state.providers.length
    ? state.providers.map(providerCardHtml).join('')
    : `<div class="empty" style="grid-column:1/-1">
         <span class="empty-icon" aria-hidden="true">▤</span>
         <strong>No providers yet</strong>
         <span>Add the base URL and key of an AI provider to start routing.</span>
         <button class="btn btn-primary btn-sm" data-action="add-first">+ Add your first provider</button>
       </div>`;

  if (focusKey) grid.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
}

// ================================================================= requests

function statusClass(log) {
  if (log.error && !log.statusCode) return 'status-error';
  if (!log.statusCode) return 'status-pending';
  if (log.statusCode < 300) return 'status-ok';
  if (log.statusCode < 400) return 'status-warn';
  return 'status-error';
}

function modelCell(log) {
  if (!log.originalModel && !log.swappedModel) return '<span class="dim">—</span>';
  if (log.originalModel && log.swappedModel && log.originalModel !== log.swappedModel) {
    return `${esc(log.originalModel)} <span class="model-swap">→ ${esc(log.swappedModel)}</span>`;
  }
  return esc(log.swappedModel || log.originalModel);
}

/**
 * @param {Array<Object>} logs - newest first
 * @param {{compact?:boolean}} [options]
 * @returns {string}
 */
function logTableHtml(logs, options = {}) {
  const rows = logs.map(log => `
    <tr tabindex="0" role="button" data-log-id="${log.id}" class="${log.historical ? 'row-historical' : ''}"
        aria-label="Request ${log.id} to ${attr(log.provider || 'unknown')}">
      <td class="dim">${log.id}</td>
      <td>${formatTime(log.timestamp)}</td>
      <td>${esc(log.method)}</td>
      <td>${log.provider ? esc(log.provider) : '<span class="dim">—</span>'}</td>
      <td class="wrap">${modelCell(log)}</td>
      ${options.compact ? '' : `<td>${formatMs(log.durationMs)}</td>`}
      ${options.compact ? '' : `<td class="dim">${formatBytes(log.bytesOut)}</td>`}
      <td class="col-status ${statusClass(log)}">
        ${log.statusCode || (log.error ? 'ERR' : '···')}${log.streaming ? ' <span class="dim" title="streamed">≋</span>' : ''}
      </td>
    </tr>`).join('');

  return `
    <div class="table-wrap">
      <div class="table-scroll">
        <table class="log-table">
          <thead>
            <tr>
              <th>#</th><th>Time</th><th>Method</th><th>Provider</th><th>Model</th>
              ${options.compact ? '' : '<th>Duration</th><th>Out</th>'}
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function filteredLogs() {
  return state.logs.filter(log => {
    if (state.logFilter.provider && log.provider !== state.logFilter.provider) return false;
    const failed = Boolean(log.error) || (log.statusCode && log.statusCode >= 400);
    if (state.logFilter.status === 'ok' && (failed || !log.statusCode)) return false;
    if (state.logFilter.status === 'error' && !failed) return false;
    if (state.logFilter.status === 'pending' && (log.statusCode || log.error)) return false;
    return true;
  });
}

function renderLogs() {
  const logs = filteredLogs().slice().reverse();
  const view = { logs: logs.map(log => [log.id, log.statusCode, log.durationMs, log.bytesOut, log.error]), filter: state.logFilter };
  if (state.rendered.logs === signature(view)) return;
  state.rendered.logs = signature(view);

  const failures = logs.filter(log => log.error || (log.statusCode && log.statusCode >= 400)).length;
  $('#log-summary').textContent = `${logs.length} shown · ${failures} failed`;

  $('#log-area').innerHTML = logs.length
    ? logTableHtml(logs)
    : `<div class="empty">
         <span class="empty-icon" aria-hidden="true">≡</span>
         <strong>${state.logs.length ? 'Nothing matches these filters' : 'No requests recorded yet'}</strong>
         <span>${state.logs.length
           ? 'Clear the provider or outcome filter to see everything.'
           : 'The proxy logs every forwarded call here, including failures.'}</span>
       </div>`;
}

function renderLogFilterOptions() {
  const select = $('#log-filter-provider');
  const names = state.providers.map(provider => provider.name);
  if (state.rendered.logFilterOptions === signature(names)) return;
  state.rendered.logFilterOptions = signature(names);

  const current = select.value;
  select.innerHTML = `<option value="">All providers</option>${
    names.map(name => `<option value="${attr(name)}">${esc(name)}</option>`).join('')}`;
  if (names.includes(current)) select.value = current;
}

/** Opens the request inspector for one log entry. */
async function openLogDetail(id) {
  showOverlay('#detail-overlay');
  $('#detail-title').textContent = `Request #${id}`;
  $('#detail-body').innerHTML = '<p class="muted">Loading…</p>';

  const data = await api(`/api/logs/${id}`);
  if (!data || !data.ok) {
    $('#detail-body').innerHTML = `<p class="field-error">${esc(data?.error || 'Could not load this request.')}</p>`;
    return;
  }

  const log = data.log;
  const cell = (label, value) => `
    <div class="drawer-cell">
      <dt>${esc(label)}</dt>
      <dd>${value}</dd>
    </div>`;

  const bodies = log.bodies || {};
  const bodySection = (label, text) => {
    if (!text) return '';
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch { /* keep the raw text */ }
    return `
      <div class="field">
        <label>${esc(label)}</label>
        <div class="code-block-wrap">
          <pre class="code" id="detail-${esc(label.toLowerCase().replace(/\W+/g, '-'))}">${esc(pretty)}</pre>
        </div>
      </div>`;
  };

  $('#detail-body').innerHTML = `
    <dl class="drawer-grid">
      ${cell('Status', `<span class="${statusClass(log)}">${log.statusCode || (log.error ? 'error' : 'in flight')}</span>`)}
      ${cell('Provider', esc(log.provider || '—'))}
      ${cell('Method', esc(log.method))}
      ${cell('Duration', formatMs(log.durationMs))}
      ${cell('First byte', formatMs(log.ttfbMs))}
      ${cell('Sent', formatBytes(log.bytesIn))}
      ${cell('Received', formatBytes(log.bytesOut))}
      ${cell('Streamed', log.streaming ? 'yes' : 'no')}
      ${cell('Time', esc(new Date(log.timestamp).toLocaleString()))}
      ${cell('Model', modelCell(log))}
      ${cell('Client', esc(log.client || '—'))}
      ${cell('Path', esc(log.path))}
      ${log.targetUrl ? cell('Upstream URL', esc(log.targetUrl)) : ''}
    </dl>
    ${log.error ? `<p class="field-error">${esc(log.error)}</p>` : ''}
    ${bodySection('Request body', bodies.request)}
    ${bodySection('Response body', bodies.response)}
    ${bodies.truncated ? '<p class="field-hint">Bodies are truncated to 4 KB.</p>' : ''}
    ${log.historical && !bodies.request
      ? '<p class="field-hint">Restored from the on-disk history — bodies are never written to disk.</p>'
      : ''}
    ${!state.settings?.captureBodies && !log.historical
      ? '<p class="field-hint">Body capture is off (Settings → Proxy behaviour).</p>'
      : ''}`;
}

// ==================================================================== setup

function renderSetup() {
  const integrations = state.integrations;
  const port = state.status?.port ?? state.meta?.port ?? 8319;
  const view = { integrations, port };
  if (state.rendered.setup === signature(view)) return;
  state.rendered.setup = signature(view);

  const baseUrl = `http://127.0.0.1:${port}`;
  $('#manual-config').textContent =
    `Base URL   ${baseUrl}\n` +
    `API key    dummy-key-managed-by-proxy        (uses the active provider)\n` +
    `           <provider>:dummy                  (that provider, stored key)\n` +
    `           <provider>:sk-your-own-key        (that provider, your key)`;

  if (!integrations) return;
  const shell = integrations.shell;
  const shellApplied = shell.files.filter(file => file.applied);
  const mismatch = shellApplied.filter(file => file.port !== port);

  const shellPill = !shellApplied.length
    ? '<span class="pill pill-muted">Not configured</span>'
    : mismatch.length
      ? `<span class="pill pill-warn">Points at port ${mismatch[0].port}</span>`
      : '<span class="pill pill-ok"><span class="dot"></span>Configured</span>';

  $('#shell-setup').innerHTML = `
    <div class="setup-step">
      <span class="step-num">1</span>
      <div class="step-body">
        <h3>Environment variables</h3>
        <div class="status-line">
          <span>${shellApplied.length
            ? `Managed block present in ${shellApplied.map(file => esc(file.label)).join(', ')}`
            : 'No managed block in your shell startup files yet'}</span>
          ${shellPill}
        </div>
        <div class="file-list">
          ${shell.files.map(file => `
            <div class="file-row">
              <span>${file.applied ? '✔' : '·'}</span>
              <span class="truncate" title="${attr(file.path)}">${esc(file.path)}</span>
              ${file.applied ? `<span class="dim">port ${file.port ?? '?'}</span>` : ''}
            </div>`).join('')}
        </div>
        <div class="section-head-actions">
          <button class="btn btn-sm btn-primary" data-action="apply-shell">
            ${shellApplied.length ? 'Refresh block' : 'Configure shell'}
          </button>
          ${shellApplied.length ? '<button class="btn btn-sm btn-danger" data-action="remove-shell">Remove block</button>' : ''}
        </div>
      </div>
    </div>
    <div class="setup-step">
      <span class="step-num">2</span>
      <div class="step-body">
        <h3>Reload the shell, then run Claude Code</h3>
        <div class="code-block-wrap">
          <pre class="code is-command" id="shell-commands">source ~/.bashrc   # or open a new terminal
claude</pre>
          <button class="btn btn-sm btn-copy" data-copy-target="shell-commands">Copy</button>
        </div>
        <p class="field-hint">Equivalent CLI: <code>ai-proxy setup-terminal</code></p>
      </div>
    </div>`;

  const vscode = integrations.vscode;
  $('#vscode-setup').innerHTML = `
    <div class="setup-step">
      <span class="step-num">↯</span>
      <div class="step-body">
        <h3>Custom model list</h3>
        <div class="status-line">
          <span>${vscode.applied
            ? `${vscode.entries} provider entry(ies) injected`
            : 'No ai-proxy entries in VS Code yet'}</span>
          ${vscode.applied
            ? '<span class="pill pill-ok"><span class="dot"></span>Synced</span>'
            : '<span class="pill pill-muted">Not synced</span>'}
        </div>
        <div class="file-row"><span>${vscode.exists ? '✔' : '·'}</span><span class="truncate">${esc(vscode.path)}</span></div>
        ${vscode.readable ? '' : '<p class="field-error">That file is not valid JSON — fix or delete it before syncing.</p>'}
        <div class="section-head-actions">
          <button class="btn btn-sm btn-primary" data-action="sync-vscode">Sync now</button>
        </div>
        <p class="field-hint">Every provider with a key and at least one model is added. Reload VS Code afterwards.</p>
      </div>
    </div>`;
}

// ================================================================= settings

const SWITCH_FIELDS = [
  ['spoofHeaders', 'Spoof SDK headers', 'Send first-party CLI headers upstream. Needed to get past some providers’ Cloudflare rules.'],
  ['persistLogs', 'Persist request history', 'Mirror request metadata to requests.jsonl so history survives a restart.'],
  ['captureBodies', 'Capture bodies for the inspector', 'Keep a 4 KB preview of request and response bodies in memory. Never written to disk.']
];

const NUMBER_FIELDS = [
  ['proxy_port', 'Proxy port', 'Requires a daemon restart, and re-running the shell setup.', 1, 65535],
  ['upstreamTimeoutMs', 'Hard request timeout (ms)', 'Absolute ceiling for one upstream request.', 1000, 3600000],
  ['upstreamStallTimeoutMs', 'Stall timeout (ms)', 'Abort when the upstream sends nothing for this long — catches providers that answer 200 then go silent.', 1000, 3600000],
  ['logBufferSize', 'History size', 'How many requests to keep in memory.', 10, 5000]
];

function renderSettings() {
  const settings = state.settings;
  if (!settings) return;
  if (state.rendered.settings === signature(settings)) return;
  state.rendered.settings = signature(settings);

  $('#settings-switches').innerHTML = SWITCH_FIELDS.map(([key, title, hint]) => `
    <div class="switch-row">
      <div class="switch-row-text">
        <strong>${esc(title)}</strong>
        <span>${esc(hint)}</span>
      </div>
      <button class="switch" role="switch" data-action="toggle-setting" data-key="${attr(key)}"
              aria-checked="${settings[key] ? 'true' : 'false'}" aria-label="${attr(title)}"></button>
    </div>`).join('');

  $('#settings-network').innerHTML = NUMBER_FIELDS.map(([key, title, hint, min, max]) => `
    <div class="field">
      <label for="set-${attr(key)}">${esc(title)}</label>
      <div style="display:flex; gap:8px">
        <input type="number" id="set-${attr(key)}" value="${attr(settings[key] ?? '')}"
               min="${min}" max="${max}" step="1">
        <button class="btn btn-sm" data-action="save-setting" data-key="${attr(key)}">Save</button>
      </div>
      <span class="field-hint">${esc(hint)}</span>
    </div>`).join('');
}

// ========================================================= provider dialog

/** Models currently listed in the open provider dialog. */
let formModels = [];

function renderFormModels() {
  const container = $('#pf-models');
  container.innerHTML = formModels.length
    ? formModels.map(model => `
        <span class="chip">
          <span class="chip-label">${esc(model)}</span>
          <button type="button" class="chip-remove" data-action="form-remove-model" data-model="${attr(model)}"
                  aria-label="Remove ${attr(model)}">✕</button>
        </span>`).join('')
    : '<span class="field-hint">None yet — the pinned model is added automatically.</span>';
}

/**
 * @param {string|null} name - provider to edit, or null to create
 * @param {{focusModels?:boolean}} [options]
 */
function openProviderDialog(name = null, options = {}) {
  const provider = name ? state.providers.find(item => item.name === name) : null;
  const editing = Boolean(provider);

  $('#provider-dialog-title').textContent = editing ? `Edit ${provider.name}` : 'Add provider';
  $('#pf-submit').textContent = editing ? 'Save changes' : 'Add provider';
  $('#provider-form').dataset.editing = editing ? provider.name : '';
  $('#pf-error').hidden = true;

  $('#pf-name').value = provider?.name ?? '';
  $('#pf-name').disabled = editing;
  $('#pf-url').value = provider?.url ?? '';
  $('#pf-key').value = '';
  $('#pf-key').placeholder = editing && provider.hasKey ? 'unchanged — type to replace' : 'sk-…';
  $('#pf-key-hint').textContent = editing && provider.hasKey
    ? 'Leave empty to keep the stored key.'
    : 'Stored locally in config.json (file mode 600).';
  $('#pf-model').value = provider?.defaultModel ?? '';
  $('#pf-model-add').value = '';

  formModels = [...(provider?.models ?? [])];
  renderFormModels();

  showOverlay('#provider-overlay', options.focusModels ? '#pf-model-add' : (editing ? '#pf-url' : '#pf-name'));
}

async function submitProviderForm(event) {
  event.preventDefault();
  const editing = $('#provider-form').dataset.editing;
  const name = $('#pf-name').value.trim().toLowerCase();
  const url = $('#pf-url').value.trim();
  const key = $('#pf-key').value.trim();
  const model = $('#pf-model').value.trim();

  const fail = message => {
    $('#pf-error').textContent = message;
    $('#pf-error').hidden = false;
  };

  if (!editing && !name) return fail('A provider name is required.');
  if (!url) return fail('A base URL is required.');

  const models = [...formModels];
  if (model && !models.includes(model)) models.unshift(model);

  const body = { url, defaultModel: model, models };
  if (key) body.apiKey = key;

  const result = editing
    ? await api(`/api/providers/${encodeURIComponent(editing)}`, { method: 'PUT', body })
    : await api('/api/providers', { method: 'POST', body: { ...body, name } });

  if (!result || !result.ok) return fail(result?.error || 'The request failed.');

  hideOverlay($('#provider-overlay'));
  toast(result.message || 'Saved', 'ok');
  state.rendered.providers = null;
  refreshProviders();
  refreshStatus();
}

// ====================================================== provider operations

async function activateProvider(name) {
  const done = await mutate(`/api/providers/${encodeURIComponent(name)}/activate`, { method: 'POST' }, `Routing through ${name}`);
  if (done) {
    refreshProviders();
    refreshStatus();
  }
}

async function switchModel(name, model) {
  const done = await mutate(
    `/api/providers/${encodeURIComponent(name)}/model`,
    { method: 'POST', body: { model } },
    model ? `${name} → ${model}` : `${name} → pass-through`
  );
  if (done) refreshProviders();
}

async function removeModelFrom(name, model) {
  const confirmed = await confirmDialog({
    title: 'Remove model',
    message: `Remove “${model}” from ${name}? This only edits the saved list.`,
    confirmLabel: 'Remove'
  });
  if (!confirmed) return;

  const done = await mutate(
    `/api/providers/${encodeURIComponent(name)}/models/${encodeURIComponent(model)}`,
    { method: 'DELETE' }
  );
  if (done) refreshProviders();
}

async function deleteProvider(name) {
  const confirmed = await confirmDialog({
    title: `Delete ${name}?`,
    message: 'The provider, its models and its stored API key are removed from config.json. This cannot be undone.',
    confirmLabel: 'Delete provider'
  });
  if (!confirmed) return;

  const done = await mutate(`/api/providers/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (done) {
    state.tests.delete(name);
    state.revealed.delete(name);
    refreshProviders();
    refreshStatus();
  }
}

async function testProvider(name) {
  state.tests.set(name, { running: true });
  state.rendered.providers = null;
  state.rendered.overview = null;
  renderProviders();
  renderOverview();

  const data = await api(`/api/providers/${encodeURIComponent(name)}/test`, { method: 'POST' });
  const result = data?.result ?? {
    ok: false, level: 'error', summary: data?.error || 'The test could not run', latencyMs: null, detail: ''
  };

  state.tests.set(name, { running: false, result });
  state.rendered.providers = null;
  state.rendered.overview = null;
  renderProviders();
  renderOverview();
  return result;
}

async function testAllProviders() {
  if (!state.providers.length) return;
  toast(`Testing ${state.providers.length} provider(s)…`);
  const results = await Promise.all(state.providers.map(provider => testProvider(provider.name)));
  const passed = results.filter(result => result?.ok).length;
  toast(`${passed} of ${results.length} provider(s) answered successfully`, passed === results.length ? 'ok' : 'error');
}

async function revealKey(name) {
  const data = await api(`/api/providers/${encodeURIComponent(name)}/key`);
  if (!data || !data.ok) {
    toast(data?.error || 'Could not read that key', 'error');
    return;
  }
  state.revealed.set(name, data.apiKey || '(empty)');
  state.rendered.providers = null;
  renderProviders();
  renderOverview();
}

// ============================================================ config import

async function exportConfig(includeKeys) {
  if (includeKeys) {
    const confirmed = await confirmDialog({
      title: 'Export with API keys?',
      message: 'The downloaded file will contain your provider keys in plain text. Store it somewhere safe and never commit it.',
      confirmLabel: 'Export with keys'
    });
    if (!confirmed) return;
  }

  const data = await api(`/api/config/export?redact=${includeKeys ? '0' : '1'}`);
  if (!data || !data.ok) {
    toast(data?.error || 'Export failed', 'error');
    return;
  }

  const text = JSON.stringify(data.config, null, 2);
  await copyText(text, includeKeys
    ? 'Config copied to the clipboard (contains keys)'
    : 'Config copied to the clipboard (keys redacted)');
}

async function submitImport() {
  const raw = $('#import-json').value.trim();
  const replace = $('#import-replace').getAttribute('aria-checked') === 'true';
  const fail = message => {
    $('#import-error').textContent = message;
    $('#import-error').hidden = false;
  };
  $('#import-error').hidden = true;

  if (!raw) return fail('Paste an exported configuration first.');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return fail(`That is not valid JSON: ${error.message}`);
  }

  const data = await api('/api/config/import', {
    method: 'POST',
    body: { config: parsed.config ?? parsed, mode: replace ? 'replace' : 'merge' }
  });
  if (!data || !data.ok) return fail(data?.error || 'Import failed.');

  hideOverlay($('#import-overlay'));
  toast(data.message, 'ok');
  state.rendered.providers = null;
  refreshProviders();
  refreshStatus();
}

// =========================================================== command palette

let paletteItems = [];
let paletteIndex = 0;

function buildPaletteItems() {
  const items = [
    { label: 'Go to Overview', kind: 'view', run: () => setView('overview') },
    { label: 'Go to Providers', kind: 'view', run: () => setView('providers') },
    { label: 'Go to Requests', kind: 'view', run: () => setView('requests') },
    { label: 'Go to Setup', kind: 'view', run: () => setView('setup') },
    { label: 'Go to Settings', kind: 'view', run: () => setView('settings') },
    { label: 'Add a provider', kind: 'action', run: () => openProviderDialog(null) },
    { label: 'Test all providers', kind: 'action', run: () => testAllProviders() },
    { label: 'Clear request history', kind: 'action', run: () => clearLogs() },
    { label: 'Toggle theme', kind: 'action', run: () => $('#theme-toggle').click() },
    { label: 'Sync VS Code', kind: 'action', run: () => runIntegration('sync-vscode') },
    { label: 'Configure shell for Claude Code', kind: 'action', run: () => runIntegration('apply-shell') }
  ];

  for (const provider of state.providers) {
    if (!provider.isActive) {
      items.push({ label: `Use ${provider.name}`, kind: 'switch', run: () => activateProvider(provider.name) });
    }
    items.push({ label: `Test ${provider.name}`, kind: 'test', run: () => testProvider(provider.name) });
    items.push({ label: `Edit ${provider.name}`, kind: 'edit', run: () => openProviderDialog(provider.name) });
    for (const model of provider.models || []) {
      if (model === provider.defaultModel) continue;
      items.push({
        label: `${provider.name}: switch to ${model}`,
        kind: 'model',
        run: () => switchModel(provider.name, model)
      });
    }
  }
  return items;
}

function renderPalette(query) {
  const needle = query.trim().toLowerCase();
  const all = buildPaletteItems();
  paletteItems = needle
    ? all.filter(item => item.label.toLowerCase().includes(needle))
    : all;
  paletteIndex = 0;

  $('#palette-list').innerHTML = paletteItems.length
    ? paletteItems.map((item, index) => `
        <button class="palette-item" role="option" data-index="${index}" aria-selected="${index === 0}">
          <span>${esc(item.label)}</span>
          <span class="palette-kind">${esc(item.kind)}</span>
        </button>`).join('')
    : '<div class="palette-empty">Nothing matches that.</div>';
}

function movePaletteSelection(delta) {
  if (!paletteItems.length) return;
  paletteIndex = (paletteIndex + delta + paletteItems.length) % paletteItems.length;
  for (const node of $$('#palette-list .palette-item')) {
    node.setAttribute('aria-selected', String(Number(node.dataset.index) === paletteIndex));
  }
  $$('#palette-list .palette-item')[paletteIndex]?.scrollIntoView({ block: 'nearest' });
}

function runPaletteSelection() {
  const item = paletteItems[paletteIndex];
  if (!item) return;
  hideOverlay($('#palette-overlay'));
  item.run();
}

function openPalette() {
  $('#palette-input').value = '';
  renderPalette('');
  showOverlay('#palette-overlay', '#palette-input');
}

// ============================================================ misc actions

async function clearLogs() {
  const confirmed = await confirmDialog({
    title: 'Clear request history?',
    message: 'Removes the in-memory history and truncates requests.jsonl. Traffic counters keep running.',
    confirmLabel: 'Clear'
  });
  if (!confirmed) return;

  const done = await mutate('/api/logs', { method: 'DELETE' });
  if (done) {
    state.rendered.logs = null;
    refreshLogs();
    refreshStatus();
  }
}

/**
 * @param {'apply-shell'|'remove-shell'|'sync-vscode'} action
 */
async function runIntegration(action) {
  const config = {
    'apply-shell': ['/api/integrations/shell', 'POST'],
    'remove-shell': ['/api/integrations/shell', 'DELETE'],
    'sync-vscode': ['/api/integrations/vscode', 'POST']
  }[action];

  const data = await api(config[0], { method: config[1] });
  if (!data || !data.ok) {
    toast(data?.error || data?.message || 'That integration step failed', 'error');
    return;
  }
  toast(data.message, 'ok');
  if (data.integrations) {
    state.integrations = data.integrations;
    state.rendered.setup = null;
    renderSetup();
  }
}

async function toggleSetting(key) {
  const next = !state.settings?.[key];
  const data = await api('/api/settings', { method: 'PUT', body: { [key]: next } });
  if (!data || !data.ok) {
    toast(data?.error || 'Could not save that setting', 'error');
    return;
  }
  state.settings = { ...state.settings, ...data.settings };
  state.rendered.settings = null;
  renderSettings();
  toast(`${key} ${next ? 'enabled' : 'disabled'}`, 'ok');
}

async function saveNumberSetting(key) {
  const value = Number($(`#set-${key}`).value);
  if (!Number.isFinite(value)) {
    toast('Enter a number', 'error');
    return;
  }

  const data = await api('/api/settings', { method: 'PUT', body: { [key]: value } });
  if (!data || !data.ok) {
    toast(data?.error || 'Could not save that setting', 'error');
    return;
  }
  state.settings = { ...state.settings, ...data.settings, proxy_port: key === 'proxy_port' ? value : state.settings.proxy_port };
  state.rendered.settings = null;
  renderSettings();
  toast(data.message, data.restartRequired ? 'info' : 'ok');
}

// =============================================================== event wiring

/** Every delegated click action, keyed by data-action. */
const ACTIONS = {
  activate: target => activateProvider(target.dataset.name),
  test: target => testProvider(target.dataset.name),
  edit: target => openProviderDialog(target.dataset.name),
  'add-model': target => openProviderDialog(target.dataset.name, { focusModels: true }),
  delete: target => deleteProvider(target.dataset.name),
  'remove-model': target => removeModelFrom(target.dataset.name, target.dataset.model),
  'reveal-key': target => revealKey(target.dataset.name),
  'hide-key': target => {
    state.revealed.delete(target.dataset.name);
    state.rendered.providers = null;
    renderProviders();
    renderOverview();
  },
  'add-first': () => openProviderDialog(null),
  'form-remove-model': target => {
    formModels = formModels.filter(model => model !== target.dataset.model);
    renderFormModels();
  },
  'apply-shell': () => runIntegration('apply-shell'),
  'remove-shell': () => runIntegration('remove-shell'),
  'sync-vscode': () => runIntegration('sync-vscode'),
  'toggle-setting': target => toggleSetting(target.dataset.key),
  'save-setting': target => saveNumberSetting(target.dataset.key)
};

function wireEvents() {
  // Delegated clicks: works for markup that is re-rendered at any time.
  document.addEventListener('click', event => {
    const actionTarget = event.target.closest('[data-action]');
    if (actionTarget && ACTIONS[actionTarget.dataset.action]) {
      event.preventDefault();
      ACTIONS[actionTarget.dataset.action](actionTarget);
      return;
    }

    const copyTarget = event.target.closest('[data-copy-target]');
    if (copyTarget) {
      copyText($(`#${copyTarget.dataset.copyTarget}`).textContent, 'Copied to the clipboard');
      return;
    }

    const paletteItem = event.target.closest('.palette-item');
    if (paletteItem) {
      paletteIndex = Number(paletteItem.dataset.index);
      runPaletteSelection();
      return;
    }

    const logRow = event.target.closest('tr[data-log-id]');
    if (logRow) openLogDetail(logRow.dataset.logId);
  });

  // Keyboard activation for log rows (they are focusable buttons).
  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const logRow = event.target.closest?.('tr[data-log-id]');
    if (!logRow) return;
    event.preventDefault();
    openLogDetail(logRow.dataset.logId);
  });

  document.addEventListener('change', event => {
    const select = event.target.closest('select[data-action="switch-model"]');
    if (select) switchModel(select.dataset.name, select.value);
  });

  $('#add-provider-btn').addEventListener('click', () => openProviderDialog(null));
  $('#test-all-btn').addEventListener('click', testAllProviders);
  $('#clear-logs-btn').addEventListener('click', clearLogs);
  $('#provider-form').addEventListener('submit', submitProviderForm);

  $('#pf-model-add-btn').addEventListener('click', () => {
    const input = $('#pf-model-add');
    const model = input.value.trim();
    if (!model) return;
    if (!formModels.includes(model)) formModels.push(model);
    input.value = '';
    renderFormModels();
    input.focus();
  });
  $('#pf-model-add').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    $('#pf-model-add-btn').click();
  });

  $('#log-filter-provider').addEventListener('change', event => {
    state.logFilter.provider = event.target.value;
    state.rendered.logs = null;
    renderLogs();
  });
  $('#log-filter-status').addEventListener('change', event => {
    state.logFilter.status = event.target.value;
    state.rendered.logs = null;
    renderLogs();
  });
  $('#log-autorefresh').addEventListener('change', event => {
    state.autoRefreshLogs = event.target.checked;
    if (state.autoRefreshLogs) refreshLogs();
  });

  $('#export-redacted-btn').addEventListener('click', () => exportConfig(false));
  $('#export-keys-btn').addEventListener('click', () => exportConfig(true));
  $('#import-btn').addEventListener('click', () => {
    $('#import-json').value = '';
    $('#import-error').hidden = true;
    showOverlay('#import-overlay', '#import-json');
  });
  $('#import-submit').addEventListener('click', submitImport);
  $('#import-replace').addEventListener('click', event => {
    const on = event.currentTarget.getAttribute('aria-checked') === 'true';
    event.currentTarget.setAttribute('aria-checked', String(!on));
  });

  $('#palette-open').addEventListener('click', openPalette);
  $('#palette-input').addEventListener('input', event => renderPalette(event.target.value));
  $('#palette-input').addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      movePaletteSelection(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      movePaletteSelection(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runPaletteSelection();
    }
  });

  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (openOverlay === $('#palette-overlay')) hideOverlay();
      else openPalette();
    }
  });
}

// ===================================================================== boot

function boot() {
  initTheme();
  initOverlays();
  wireEvents();
  initRouter();

  refreshMeta();
  refreshStatus();
  refreshProviders();
  refreshLogs();
  refreshSettings();
  refreshIntegrations();
  startPolling();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
