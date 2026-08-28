/**
 * @fileoverview Client-side logic for the AI Proxy Manager dashboard.
 * Polls the REST API and renders the UI dynamically.
 */

// ===== CONFIG =====
const API_BASE = '';  // Same origin
const POLL_INTERVAL_MS = 2000;

// ===== STATE =====
let lastLogCount = 0;

// ===== INITIALIZATION =====
document.addEventListener('DOMContentLoaded', () => {
  fetchStatus();
  fetchProviders();
  fetchLogs();

  // Start polling
  setInterval(() => {
    fetchStatus();
    fetchProviders();
    fetchLogs();
  }, POLL_INTERVAL_MS);
});

// ===== API HELPERS =====
async function apiFetch(endpoint, options = {}) {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    return await res.json();
  } catch (e) {
    console.error(`API Error: ${e.message}`);
    return null;
  }
}

// ===== STATUS =====
async function fetchStatus() {
  const data = await apiFetch('/api/status');
  if (!data) {
    document.getElementById('status-badge').className = 'badge badge-offline';
    document.getElementById('status-badge').textContent = '● Offline';
    return;
  }

  document.getElementById('status-badge').className = 'badge badge-online';
  document.getElementById('status-badge').textContent = '● Online';
  document.getElementById('stat-active').textContent = data.activeProvider || '—';
  document.getElementById('stat-providers').textContent = data.providerCount;
  document.getElementById('stat-requests').textContent = data.totalRequests;
  document.getElementById('stat-uptime').textContent = formatUptime(data.uptimeSeconds);
}

function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// ===== PROVIDERS =====
async function fetchProviders() {
  const data = await apiFetch('/api/providers');
  if (!data || !data.providers) return;

  const grid = document.getElementById('provider-grid');
  grid.innerHTML = data.providers.map(p => {
    const models = p.models || [];
    const hasMultipleModels = models.length > 1;

    // Build model display: dropdown if multiple models, plain text otherwise
    let modelDisplay;
    if (models.length > 0) {
      modelDisplay = `
        <div class="model-selector">
          <select class="model-dropdown" onchange="switchModel('${escapeAttr(p.name)}', this.value)" ${!hasMultipleModels ? '' : ''}>
            ${models.map(m => `<option value="${escapeAttr(m)}" ${m === p.defaultModel ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
          </select>
          ${p.defaultModel ? `<span class="model-active-indicator">●</span>` : ''}
        </div>`;
    } else if (p.defaultModel) {
      modelDisplay = `<span>${escapeHtml(p.defaultModel)}</span>`;
    } else {
      modelDisplay = `<em style="color:var(--text-muted)">pass-through</em>`;
    }

    return `
      <div class="provider-card ${p.isActive ? 'active' : ''}">
        <div class="provider-card-header">
          <span class="provider-name">${escapeHtml(p.name)}</span>
          ${p.isActive ? '<span class="badge badge-active">● ACTIVE</span>' : ''}
        </div>
        <div class="provider-details">
          <div class="provider-detail">
            <span>URL</span>
            <span>${escapeHtml(p.url)}</span>
          </div>
          <div class="provider-detail provider-detail-model">
            <span>Model</span>
            ${modelDisplay}
          </div>
          <div class="provider-detail">
            <span>API Key</span>
            <span class="${p.hasKey ? 'key-set' : 'key-missing'}">${p.hasKey ? '✅ Set' : '❌ Missing'}</span>
          </div>
          <div class="provider-detail">
            <span>Models</span>
            <span class="meta-text">${models.length} saved</span>
          </div>
        </div>
        <div class="provider-actions">
          ${!p.isActive ? `<button class="btn btn-sm btn-success" onclick="activateProvider('${escapeAttr(p.name)}')">⚡ Use This</button>` : ''}
          <button class="btn btn-sm" onclick="editProvider('${escapeAttr(p.name)}', '${escapeAttr(p.url)}', '${escapeAttr(p.defaultModel)}', ${JSON.stringify(models).replace(/'/g, "\\'")})">✏️ Edit</button>
          <button class="btn btn-sm" onclick="openAddModelModal('${escapeAttr(p.name)}')">+ Model</button>
          <button class="btn btn-sm btn-danger" onclick="deleteProvider('${escapeAttr(p.name)}')">🗑️</button>
        </div>
      </div>
    `;
  }).join('');
}

async function activateProvider(name) {
  const data = await apiFetch(`/api/providers/${name}/activate`, { method: 'POST' });
  if (data && data.ok) {
    showToast(`Switched to ${name.toUpperCase()}`);
    fetchProviders();
    fetchStatus();
  }
}

async function deleteProvider(name) {
  if (!confirm(`Are you sure you want to delete provider "${name}"?`)) return;
  const data = await apiFetch(`/api/providers/${name}`, { method: 'DELETE' });
  if (data && data.ok) {
    showToast(`Deleted ${name}`);
    fetchProviders();
    fetchStatus();
  }
}

// ===== MODEL SWITCHING =====
async function switchModel(providerName, model) {
  const data = await apiFetch(`/api/providers/${providerName}/model`, {
    method: 'POST',
    body: JSON.stringify({ model })
  });
  if (data && data.ok) {
    showToast(`${providerName.toUpperCase()} → ${model}`);
    fetchProviders();
  } else {
    showToast(data?.error || 'Failed to switch model', true);
  }
}

// ===== ADD MODEL MODAL =====
function openAddModelModal(providerName) {
  document.getElementById('add-model-overlay').classList.add('open');
  document.getElementById('add-model-provider').value = providerName;
  document.getElementById('add-model-name').value = '';
  document.getElementById('add-model-title').textContent = `Add Model to ${providerName.toUpperCase()}`;
}

function closeAddModelModal() {
  document.getElementById('add-model-overlay').classList.remove('open');
}

async function submitAddModel(event) {
  event.preventDefault();
  const providerName = document.getElementById('add-model-provider').value;
  const model = document.getElementById('add-model-name').value.trim();

  if (!model) return;

  const data = await apiFetch(`/api/providers/${providerName}/models/add`, {
    method: 'POST',
    body: JSON.stringify({ model })
  });
  if (data && data.ok) {
    showToast(`Added ${model}`);
    closeAddModelModal();
    fetchProviders();
  } else {
    showToast(data?.error || 'Failed to add model', true);
  }
}

// ===== PROVIDER MODAL =====
function openModal(editing = null) {
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('form-editing').value = editing || '';
  document.getElementById('modal-title').textContent = editing ? 'Edit Provider' : 'Add Provider';
  document.getElementById('form-submit-btn').textContent = editing ? 'Save Changes' : 'Add Provider';

  if (!editing) {
    document.getElementById('form-name').value = '';
    document.getElementById('form-url').value = '';
    document.getElementById('form-key').value = '';
    document.getElementById('form-model').value = '';
    document.getElementById('form-name').disabled = false;
    document.getElementById('model-tags-container').innerHTML = '';
    document.getElementById('model-tags-container').dataset.models = '[]';
  }
}

function editProvider(name, url, model, models) {
  openModal(name);
  document.getElementById('form-name').value = name;
  document.getElementById('form-name').disabled = true;
  document.getElementById('form-url').value = url;
  document.getElementById('form-key').value = '';
  document.getElementById('form-key').placeholder = '(unchanged — leave empty to keep current key)';
  document.getElementById('form-model').value = model;

  // Render model tags
  const container = document.getElementById('model-tags-container');
  container.dataset.models = JSON.stringify(models || []);
  renderModelTags(container, models || []);
}

function renderModelTags(container, models) {
  container.innerHTML = models.map(m => `
    <span class="model-tag">
      ${escapeHtml(m)}
      <button type="button" class="model-tag-remove" onclick="removeModelTag(this, '${escapeAttr(m)}')">&times;</button>
    </span>
  `).join('');
}

function removeModelTag(btn, model) {
  const container = document.getElementById('model-tags-container');
  let models = JSON.parse(container.dataset.models || '[]');
  models = models.filter(m => m !== model);
  container.dataset.models = JSON.stringify(models);
  renderModelTags(container, models);
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.getElementById('form-key').placeholder = 'sk-...';
}

async function submitProvider(event) {
  event.preventDefault();

  const editing = document.getElementById('form-editing').value;
  const name = document.getElementById('form-name').value.trim().toLowerCase();
  const url = document.getElementById('form-url').value.trim();
  const key = document.getElementById('form-key').value.trim();
  const model = document.getElementById('form-model').value.trim();
  const container = document.getElementById('model-tags-container');
  let models = JSON.parse(container.dataset.models || '[]');

  // Ensure current default model is in the list
  if (model && !models.includes(model)) {
    models.unshift(model);
  }

  if (editing) {
    // UPDATE existing provider
    const body = { url, defaultModel: model, models };
    if (key) body.apiKey = key;
    const data = await apiFetch(`/api/providers/${editing}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    if (data && data.ok) {
      showToast(`Updated ${editing.toUpperCase()}`);
      closeModal();
      fetchProviders();
    } else {
      showToast(data?.error || 'Failed to update', true);
    }
  } else {
    // CREATE new provider
    const body = { name, url, defaultModel: model, models };
    if (key) body.apiKey = key;
    const data = await apiFetch('/api/providers', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    if (data && data.ok) {
      showToast(`Added ${name.toUpperCase()}`);
      closeModal();
      fetchProviders();
      fetchStatus();
    } else {
      showToast(data?.error || 'Failed to add', true);
    }
  }
}

// ===== LIVE LOGS =====
async function fetchLogs() {
  const data = await apiFetch('/api/logs');
  if (!data || !data.logs) return;

  const logs = data.logs;
  document.getElementById('log-count').textContent = `${logs.length} entries`;

  if (logs.length === 0) {
    document.getElementById('log-empty').style.display = 'block';
    document.getElementById('log-table').style.display = 'none';
    return;
  }

  document.getElementById('log-empty').style.display = 'none';
  document.getElementById('log-table').style.display = 'table';

  const tbody = document.getElementById('log-body');
  tbody.innerHTML = logs.slice().reverse().map(log => {
    const time = new Date(log.timestamp).toLocaleTimeString();
    const modelInfo = log.originalModel
      ? (log.originalModel !== log.swappedModel
          ? `${log.originalModel} → ${log.swappedModel}`
          : log.originalModel)
      : '—';
    const statusClass = getStatusClass(log.statusCode);
    const statusText = log.statusCode || '⏳';

    return `
      <tr>
        <td>${log.id}</td>
        <td>${time}</td>
        <td>${log.method}</td>
        <td>${log.provider ? log.provider.toUpperCase() : '—'}</td>
        <td>${escapeHtml(modelInfo)}</td>
        <td class="${statusClass}">${statusText}</td>
      </tr>
    `;
  }).join('');

  // Auto-scroll to top (latest entry)
  if (logs.length > lastLogCount) {
    const container = document.getElementById('log-container');
    container.scrollTop = 0;
  }
  lastLogCount = logs.length;
}

function getStatusClass(code) {
  if (!code) return 'status-pending';
  if (code >= 200 && code < 300) return 'status-200';
  if (code === 401) return 'status-401';
  if (code >= 400) return 'status-error';
  return '';
}

// ===== TOAST =====
function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast show ${isError ? 'error' : ''}`;
  setTimeout(() => { toast.className = 'toast'; }, 3000);
}

// ===== UTILS =====
function escapeHtml(text) {
  if (!text) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}

function escapeAttr(text) {
  if (!text) return '';
  return text.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
