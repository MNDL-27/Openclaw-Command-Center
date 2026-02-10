// ===== Configuration =====
// Uses local proxy to avoid CORS issues
const CONFIG = {
    openclawUrl: '/proxy/openclaw',  // Proxied through server.py
    n8nUrl: '/proxy/n8n',            // Proxied through server.py
    refreshInterval: 30000, // 30 seconds
    scheduleHour: 23, // 11 PM IST
};

// ===== Agents Registry =====
const AGENTS = [
    { id: 'main', name: 'Main Agent', emoji: '🥳', model: 'claude-opus-4-5-thinking', workspace: '/home/protik/.openclaw/workspace' },
    { id: 'blog-publisher', name: 'Blog Publisher', emoji: '📝', model: 'claude-sonnet-4-5', workspace: '/workspace/agents/blog-publisher' },
    { id: 'research-scraper', name: 'Research Scraper', emoji: '🔍', model: 'llama-3.3-70b', workspace: '/workspace/agents/research-scraper' },
    { id: 'inbox-checker', name: 'Inbox Checker', emoji: '📬', model: 'gpt-5-mini', workspace: '/workspace/agents/inbox-checker' },
];

// ===== State =====
let state = {
    sessions: [],
    cronJobs: [],
    n8nWorkflows: [],
    activity: [],
    gatewayOnline: false,
    n8nOnline: false,
};

// ===== API Helpers =====
async function fetchOpenClaw(endpoint, options = {}) {
    try {
        const response = await fetch(`${CONFIG.openclawUrl}${endpoint}`, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers,
            },
        });
        return await response.json();
    } catch (error) {
        console.error('OpenClaw API error:', error);
        return null;
    }
}

async function fetchN8n(endpoint, options = {}) {
    try {
        const response = await fetch(`${CONFIG.n8nUrl}${endpoint}`, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers,
            },
        });
        return await response.json();
    } catch (error) {
        console.error('n8n API error:', error);
        return null;
    }
}

// ===== Data Loaders =====
async function checkGatewayStatus() {
    try {
        const response = await fetch(`${CONFIG.openclawUrl}/health`);
        const data = await response.json();
        // CLI returns JSON with ok: true/false
        state.gatewayOnline = data && (data.ok === true || !data.error);
    } catch {
        state.gatewayOnline = false;
    }
    updateGatewayStatus();
}

async function checkN8nStatus() {
    try {
        const data = await fetchN8n('/workflows?limit=1');
        state.n8nOnline = data && !data.error;
    } catch {
        state.n8nOnline = false;
    }
    updateN8nStatus();
}

async function loadSessions() {
    console.log('Loading sessions...');
    const data = await fetchOpenClaw('/sessions');
    console.log('Sessions data:', data);
    if (data && data.sessions) {
        state.sessions = data.sessions;
        renderSessions();
        renderAgents();  // Re-render agents with active status
        updateStats();
    } else {
        console.error('No sessions in data:', data);
        document.getElementById('sessions-list').innerHTML = '<div class="empty-state"><div class="empty-state-text">No data</div></div>';
    }
}

async function loadCronJobs() {
    console.log('Loading cron jobs...');
    const data = await fetchOpenClaw('/cron');
    console.log('Cron data:', data);
    if (data && data.jobs) {
        state.cronJobs = data.jobs;
        renderCronJobs();
        updateStats();
    } else {
        console.error('No jobs in data:', data);
        document.getElementById('cron-jobs-list').innerHTML = '<div class="empty-state"><div class="empty-state-text">No data</div></div>';
    }
}

async function loadN8nWorkflows() {
    const data = await fetchN8n('/workflows');
    if (data && data.data) {
        state.n8nWorkflows = data.data;
        renderN8nWorkflows();
    }
}

async function loadActivity() {
    // Get recent sessions with messages as activity
    // CLI doesn't support lastMessages, so we'll show session info instead
    const data = await fetchOpenClaw('/sessions');
    if (data && data.sessions) {
        const activities = data.sessions.map(session => ({
            type: 'session',
            agent: session.agentId || 'main',
            content: `Session ${session.key} - ${session.totalTokens || 0} tokens`,
            timestamp: new Date(session.updatedAt || Date.now()),
        }));
        state.activity = activities.sort((a, b) => b.timestamp - a.timestamp).slice(0, 20);
        renderActivity();
    }
}

// New loaders for blog posts, learning notes, and schedule history
async function loadBlogPosts() {
    const container = document.getElementById('blog-posts');
    container.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const resp = await fetch('/proxy/blog/posts');
        const data = await resp.json();
        if (data && data.posts && data.posts.length) {
            container.innerHTML = data.posts.slice(0,5).map(p => `
                <div class="post-item">
                    <a href="${p.link}" target="_blank">${escapeHtml(p.title)}</a>
                    <div class="post-meta">${p.pubDate ? new Date(p.pubDate).toLocaleString() : ''}</div>
                </div>
            `).join('');
        } else {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📝</div><div class="empty-state-text">No posts found</div></div>';
        }
    } catch (err) {
        console.error('Failed to load blog posts:', err);
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚠️</div><div class="empty-state-text">Failed to load posts</div></div>';
    }
}

async function loadLearningNotes() {
    const container = document.getElementById('learning-notes');
    container.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const resp = await fetch('/proxy/openclaw/notes');
        const data = await resp.json();
        if (data && data.notes && data.notes.length) {
            container.innerHTML = data.notes.slice(0,6).map(n => `
                <div class="note-item">
                    <div class="note-title">${escapeHtml(n.title || n.title)}</div>
                    <div class="note-excerpt">${escapeHtml(n.excerpt || n.excerpt || n.content || '')}</div>
                </div>
            `).join('');
        } else {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📚</div><div class="empty-state-text">No learning notes found</div></div>';
        }
    } catch (err) {
        console.error('Failed to load learning notes:', err);
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚠️</div><div class="empty-state-text">Failed to load notes</div></div>';
    }
}

async function loadScheduleHistory() {
    const container = document.getElementById('schedule-history');
    container.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const resp = await fetch('/proxy/openclaw/history');
        const data = await resp.json();
        if (data && data.history && data.history.length) {
            container.innerHTML = data.history.slice(0,10).map(h => `
                <div class="history-item">${escapeHtml(h.note || h.title || JSON.stringify(h))}</div>
            `).join('');
        } else {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🌙</div><div class="empty-state-text">No schedule history</div></div>';
        }
    } catch (err) {
        console.error('Failed to load schedule history:', err);
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚠️</div><div class="empty-state-text">Failed to load history</div></div>';
    }
}

// ===== Renderers =====
function updateGatewayStatus() {
    const dot = document.getElementById('gateway-status');
    const text = document.getElementById('gateway-status-text');
    if (state.gatewayOnline) {
        dot.className = 'status-dot online';
        text.textContent = 'Gateway Online';
    } else {
        dot.className = 'status-dot offline';
        text.textContent = 'Gateway Offline';
    }
}

function updateN8nStatus() {
    const badge = document.getElementById('n8n-status');
    if (state.n8nOnline) {
        badge.className = 'status-badge online';
        badge.textContent = '● Connected';
    } else {
        badge.className = 'status-badge offline';
        badge.textContent = '○ Disconnected';
    }
}

function updateStats() {
    document.getElementById('stat-agents').textContent = AGENTS.length;
    document.getElementById('stat-sessions').textContent = state.sessions.filter(s => s.active).length || state.sessions.length;
    document.getElementById('stat-cron').textContent = state.cronJobs.filter(j => j.enabled).length;
    updateScheduleCountdown();
}

function updateScheduleCountdown() {
    const now = new Date();
    const scheduleTime = new Date();
    scheduleTime.setHours(CONFIG.scheduleHour, 0, 0, 0);

    if (now > scheduleTime) {
        scheduleTime.setDate(scheduleTime.getDate() + 1);
    }

    const diff = scheduleTime - now;
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    const countdown = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    document.getElementById('stat-schedule').textContent = countdown;
    document.getElementById('schedule-countdown').textContent = countdown;
    document.getElementById('schedule-next-date').textContent = scheduleTime.toLocaleString('en-IN', { 
        weekday: 'long', 
        month: 'short', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function renderSessions() {
    const container = document.getElementById('sessions-list');
    if (state.sessions.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">💤</div>
                <div class="empty-state-text">No active sessions</div>
            </div>
        `;
        return;
    }

    container.innerHTML = state.sessions.map(session => `
        <div class="session-item">
            <div class="session-header">
                <div class="session-title">
                    <span class="agent-emoji">${getAgentEmoji(session.agentId)}</span>
                    <span class="agent-name">${getAgentName(session.agentId)}</span>
                    <span class="session-key">${session.key}</span>
                </div>
                <span class="agent-status active">Active</span>
            </div>
            <div class="session-body">
                <div class="session-messages">
                    ${session.lastMessages ? session.lastMessages.slice(0, 2).map(m => `
                        <div class="activity-item">
                            <div class="activity-icon">${m.role === 'user' ? '👤' : '🤖'}</div>
                            <div class="activity-content">
                                <div class="activity-title">${escapeHtml(m.content?.substring(0, 80) || '...')}</div>
                            </div>
                        </div>
                    `).join('') : '<div class="empty-state-text">No messages</div>'}
                </div>
            </div>
        </div>
    `).join('');
}

function renderCronJobs() {
    const container = document.getElementById('cron-jobs-list');
    const upcoming = document.getElementById('upcoming-cron');

    if (state.cronJobs.length === 0) {
        const empty = `
            <div class="empty-state">
                <div class="empty-state-icon">⏰</div>
                <div class="empty-state-text">No cron jobs configured</div>
            </div>
        `;
        container.innerHTML = empty;
        upcoming.innerHTML = empty;
        return;
    }

    const sortedJobs = [...state.cronJobs].sort((a, b) => 
        (a.state?.nextRunAtMs || 0) - (b.state?.nextRunAtMs || 0)
    );

    const renderJob = (job, compact = false) => {
        const nextRun = job.state?.nextRunAtMs ? new Date(job.state.nextRunAtMs) : null;
        const schedule = job.schedule?.expr || job.schedule?.everyMs ? `Every ${job.schedule.everyMs / 60000}min` : 'One-time';

        return `
            <div class="cron-item">
                <div class="cron-time">${schedule}</div>
                <div class="cron-info">
                    <div class="cron-name">${job.name || job.id}</div>
                    <div class="cron-schedule">${job.enabled ? '✓ Enabled' : '○ Disabled'}</div>
                </div>
                <div class="cron-next">
                    ${nextRun ? `Next: ${nextRun.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : 'Not scheduled'}
                </div>
                ${!compact ? `
                    <div class="cron-actions">
                        <button class="btn btn-secondary btn-sm" onclick="triggerCron('${job.id}')">▶ Run</button>
                    </div>
                ` : ''}
            </div>
        `;
    };

    container.innerHTML = sortedJobs.map(job => renderJob(job)).join('');
    upcoming.innerHTML = sortedJobs.slice(0, 3).map(job => renderJob(job, true)).join('');
}

function renderN8nWorkflows() {
    const container = document.getElementById('n8n-workflows');

    if (!state.n8nWorkflows || state.n8nWorkflows.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">⚡</div>
                <div class="empty-state-text">No workflows found</div>
            </div>
        `;
        return;
    }

    container.innerHTML = state.n8nWorkflows.map(wf => `
        <div class="workflow-item">
            <div class="workflow-status ${wf.active ? 'active' : 'inactive'}"></div>
            <div class="workflow-info">
                <div class="workflow-name">${wf.name}</div>
                <div class="workflow-id">ID: ${wf.id}</div>
            </div>
            <div class="workflow-actions">
                <button class="btn btn-secondary btn-sm" onclick="toggleWorkflow('${wf.id}', ${!wf.active})">
                    ${wf.active ? '⏸ Pause' : '▶ Activate'}
                </button>
                <a href="${CONFIG.n8nUrl}/workflow/${wf.id}" target="_blank" class="btn btn-secondary btn-sm">
                    ↗ Open
                </a>
            </div>
        </div>
    `).join('');
}

function renderActivity() {
    const container = document.getElementById('activity-feed');
    const recent = document.getElementById('recent-activity');

    if (state.activity.length === 0) {
        const empty = `
            <div class="empty-state">
                <div class="empty-state-icon">📜</div>
                <div class="empty-state-text">No recent activity</div>
            </div>
        `;
        container.innerHTML = empty;
        recent.innerHTML = empty;
        return;
    }

    const renderItem = (item) => `
        <div class="activity-item">
            <div class="activity-icon">${getAgentEmoji(item.agent)}</div>
            <div class="activity-content">
                <div class="activity-title">${escapeHtml(item.content)}</div>
                <div class="activity-meta">${getAgentName(item.agent)} • ${formatTime(item.timestamp)}</div>
            </div>
        </div>
    `;

    container.innerHTML = state.activity.map(renderItem).join('');
    recent.innerHTML = state.activity.slice(0, 5).map(renderItem).join('');
}

function renderAgents() {
    const container = document.getElementById('agents-grid');
    const statusContainer = document.getElementById('agent-status');

    // Determine which agents are active based on recent session activity
    const activeAgentIds = new Set();
    const agentLastActivity = {};

    state.sessions.forEach(session => {
        // Check if session was active in last 5 minutes
        const ageMinutes = (session.ageMs || 0) / 60000;
        const agentId = session.key?.split(':')[1] || 'main';

        if (ageMinutes < 5) {
            activeAgentIds.add(agentId);
        }

        // Track last activity time
        if (!agentLastActivity[agentId] || session.updatedAt > agentLastActivity[agentId]) {
            agentLastActivity[agentId] = session.updatedAt;
        }
    });

    container.innerHTML = AGENTS.map(agent => {
        const isActive = activeAgentIds.has(agent.id);
        const lastActivity = agentLastActivity[agent.id];
        const lastActivityStr = lastActivity ? formatTime(new Date(lastActivity)) : 'Never';

        return `
        <div class="agent-card ${isActive ? 'active' : ''}">
            <div class="agent-card-header">
                <div class="agent-card-emoji">${agent.emoji}</div>
                <div>
                    <div class="agent-card-title">${agent.name}</div>
                    <div class="agent-card-id">${agent.id}</div>
                </div>
            </div>
            <div class="agent-card-details">
                <div class="agent-detail">
                    <span class="agent-detail-label">Model</span>
                    <span class="agent-detail-value">${agent.model}</span>
                </div>
                <div class="agent-detail">
                    <span class="agent-detail-label">Status</span>
                    <span class="agent-detail-value" style="color: ${isActive ? 'var(--success)' : 'var(--text-muted)'}">${isActive ? '● Active' : '○ Idle'}</span>
                </div>
                <div class="agent-detail">
                    <span class="agent-detail-label">Last Active</span>
                    <span class="agent-detail-value">${lastActivityStr}</span>
                </div>
            </div>
            <div class="agent-card-actions">
                ${agent.id !== 'main' ? `
                    <button class="btn btn-primary btn-sm" onclick="quickSpawn('${agent.id}')">🚀 Spawn</button>
                ` : ''}
                <button class="btn btn-secondary btn-sm" onclick="viewAgentDetails('${agent.id}')">Details</button>
            </div>
        </div>
    `}).join('');

    statusContainer.innerHTML = AGENTS.map(agent => {
        const isActive = activeAgentIds.has(agent.id);
        return `
        <div class="agent-item">
            <div class="agent-emoji">${agent.emoji}</div>
            <div class="agent-info">
                <div class="agent-name">${agent.name}</div>
                <div class="agent-model">${agent.model}</div>
            </div>
            <span class="agent-status ${isActive ? 'active' : 'idle'}">${isActive ? 'Active' : 'Idle'}</span>
        </div>
    `}).join('');
}

// ===== Actions =====
async function spawnAgent() {
    const agentId = document.getElementById('spawn-agent').value;
    const task = document.getElementById('spawn-task').value;

    if (!task.trim()) {
        showToast('Please enter a task', 'error');
        return;
    }

    showToast(`Spawning ${getAgentName(agentId)}...`, 'info');

    const result = await fetchOpenClaw('/sessions/spawn', {
        method: 'POST',
        body: JSON.stringify({ agentId, task }),
    });

    if (result && result.ok) {
        showToast(`Spawned ${getAgentName(agentId)} ✓`, 'success');
        hideSpawnModal();
        setTimeout(loadSessions, 2000);  // Refresh after spawn starts
    } else if (result && result.error) {
        showToast(`Failed to spawn: ${result?.error || 'Unknown error'}`, 'error');
    }
}

async function quickSpawn(agentId) {
    const tasks = {
        'blog-publisher': 'Check /workspace/agent/drafts/ for ready posts. Publish one if available.',
        'research-scraper': 'Pick a topic from INTERESTS.md and do a quick research dive. Save notes.',
        'inbox-checker': 'Check for new emails and notifications. Report anything important.',
    };

    const result = await fetchOpenClaw('/api/sessions/spawn', {
        method: 'POST',
        body: JSON.stringify({ agentId, task: tasks[agentId] || 'Execute your default task.' }),
    });

    if (result && !result.error) {
        showToast(`Spawned ${getAgentName(agentId)}`, 'success');
        loadSessions();
    } else {
        showToast(`Failed to spawn: ${result?.error || 'Unknown error'}`, 'error');
    }
}

async function triggerCron(jobId) {
    const result = await fetchOpenClaw('/api/cron/run', {
        method: 'POST',
        body: JSON.stringify({ jobId }),
    });

    if (result && !result.error) {
        showToast('Job triggered', 'success');
    } else {
        showToast(`Failed: ${result?.error || 'Unknown error'}`, 'error');
    }
}

async function toggleWorkflow(workflowId, activate) {
    const endpoint = activate ? `/workflows/${workflowId}/activate` : `/workflows/${workflowId}/deactivate`;
    const result = await fetchN8n(endpoint, { method: 'POST' });

    if (result && !result.error) {
        showToast(`Workflow ${activate ? 'activated' : 'deactivated'}`, 'success');
        loadN8nWorkflows();
    } else {
        showToast(`Failed: ${result?.message || 'Unknown error'}`, 'error');
    }
}

// ===== UI Helpers =====
function showPanel(panelId) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    document.getElementById(`panel-${panelId}`).classList.add('active');
    document.querySelector(`[data-panel="${panelId}"]`).classList.add('active');

    const titles = {
        'overview': ['Overview', 'Multi-agent monitoring dashboard'],
        'agents': ['Agents', 'Manage your AI workforce'],
        'sessions': ['Sessions', 'Active conversations and tasks'],
        'cron': ['Cron Jobs', 'Scheduled automation tasks'],
        'n8n': ['n8n Workflows', 'External workflow orchestration'],
        'activity': ['Activity Feed', 'Real-time agent activity'],
        'schedule': ['Schedule', 'Scheduled events and reminders'],
        'settings': ['Settings', 'Dashboard configuration'],
    };

    document.getElementById('panel-title').textContent = titles[panelId][0];
    document.getElementById('panel-subtitle').textContent = titles[panelId][1];
}

function showSpawnModal() {
    document.getElementById('spawn-modal').classList.add('active');
    document.getElementById('spawn-task').value = '';
}

function hideSpawnModal() {
    document.getElementById('spawn-modal').classList.remove('active');
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span>${type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ'}</span>
        <span>${message}</span>
    `;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function getAgentEmoji(agentId) {
    const agent = AGENTS.find(a => a.id === agentId);
    return agent?.emoji || '🤖';
}

function getAgentName(agentId) {
    const agent = AGENTS.find(a => a.id === agentId);
    return agent?.name || agentId;
}

function formatTime(date) {
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleDateString();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

let agentModalCurrentId = null;

function switchAgentTab(tab) {
    document.querySelectorAll('.agent-tab-content').forEach(c => c.style.display = 'none');
    document.querySelectorAll('.agent-tab-nav .tab-btn').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector(`.agent-tab-nav .tab-btn[data-tab="${tab}"]`);
    if (btn) btn.classList.add('active');
    const el = document.getElementById(`agent-tab-${tab}`);
    if (el) el.style.display = 'block';

    // Lazy-load tab data
    if (tab === 'notes') loadAgentNotes(agentModalCurrentId);
    if (tab === 'memory') loadAgentMemory(agentModalCurrentId);
    if (tab === 'logs') loadAgentLogs();
    if (tab === 'sessions') {
        // refresh sessions view
        viewAgentDetails(agentModalCurrentId);
    }
}

async function viewAgentDetails(agentId) {
    agentModalCurrentId = agentId;
    const el = id => document.getElementById(id);
    const agent = AGENTS.find(a => a.id === agentId) || {name: agentId, emoji: '🤖', model: '', workspace: ''};

    if (el('agent-details-title')) el('agent-details-title').textContent = `${agent.emoji} ${agent.name}`;
    if (el('agent-details-emoji')) el('agent-details-emoji').textContent = agent.emoji;
    if (el('agent-details-id')) el('agent-details-id').textContent = `ID: ${agent.id}`;
    if (el('agent-details-model')) el('agent-details-model').textContent = `Model: ${agent.model || ''}`;
    if (el('agent-details-workspace')) el('agent-details-workspace').textContent = `Workspace: ${agent.workspace || ''}`;

    // Hide any open note view and show notes list by default
    if (el('agent-note-view')) {
        el('agent-note-view').style.display = 'none';
        if (el('agent-details-notes-list')) el('agent-details-notes-list').style.display = 'block';
        if (el('agent-note-title')) el('agent-note-title').textContent = '';
        if (el('agent-note-content')) el('agent-note-content').textContent = '';
    }

    const modal = document.getElementById('agent-details-modal');
    if (modal) modal.classList.add('active');

    // default to overview tab
    switchAgentTab('overview');

    // Load and render sessions
    try {
        await loadSessions();
        const sessions = state.sessions.filter(s => {
            const sAgent = s.agentId || (s.key && s.key.split(':')[1]) || 'main';
            return sAgent === agentId;
        });

        if (el('agent-details-sessions-count')) el('agent-details-sessions-count').textContent = sessions.length;
        if (!el('agent-details-sessions-list')) return;

        if (sessions.length === 0) {
            el('agent-details-sessions-list').innerHTML = '<div class="empty-state"><div class="empty-state-text">No sessions</div></div>';
        } else {
            el('agent-details-sessions-list').innerHTML = sessions.map(ses => {
                const updated = ses.updatedAt ? new Date(ses.updatedAt) : null;
                const updatedStr = updated ? formatTime(updated) : 'Unknown';
                const preview = (ses.lastMessages && ses.lastMessages.length) ? escapeHtml((ses.lastMessages[ses.lastMessages.length-1].content || '').slice(0,120)) : '';
                return `
                    <div class="session-row">
                        <div class="session-key">${escapeHtml(ses.key || '')}</div>
                        <div class="session-meta">${updatedStr}</div>
                        <div class="session-preview">${preview}</div>
                        <div class="session-actions">
                            <button class="btn btn-secondary btn-sm" onclick="viewSessionDetail('${ses.key}')">View</button>
                            <button class="btn btn-danger btn-sm" onclick="terminateSession('${ses.key}')">Terminate</button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        const lastAct = sessions.reduce((max, s) => {
            const t = s.updatedAt ? new Date(s.updatedAt).getTime() : 0;
            return Math.max(max, t);
        }, 0);
        if (el('agent-details-last')) el('agent-details-last').textContent = lastAct ? formatTime(new Date(lastAct)) : 'Never';
        if (el('agent-details-status')) el('agent-details-status').textContent = sessions.length > 0 ? '● Active' : '○ Idle';
    } catch (err) {
        console.error('Agent details load failed', err);
        if (document.getElementById('agent-details-sessions-list')) document.getElementById('agent-details-sessions-list').innerHTML = '<div class="empty-state"><div class="empty-state-text">Failed to load sessions</div></div>';
    }
}

function hideAgentDetailsModal() {
    const modal = document.getElementById('agent-details-modal');
    if (modal) modal.classList.remove('active');
}

function openSpawnForAgent() {
    if (!agentModalCurrentId) return;
    const sel = document.getElementById('spawn-agent');
    if (sel) sel.value = agentModalCurrentId;
    showSpawnModal();
}

async function quickSpawnAgentFromModal() {
    if (!agentModalCurrentId) return;
    showToast('Spawning quick task...', 'info');
    await quickSpawn(agentModalCurrentId);
    await loadSessions();
    viewAgentDetails(agentModalCurrentId);
}

// Notes modal helpers
async function loadAgentNotes(agentId) {
    const container = document.getElementById('agent-details-notes-list');
    if (!container) return;
    container.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const resp = await fetch('/proxy/openclaw/notes');
        const data = await resp.json();
        const notes = data.notes || [];
        const agent = AGENTS.find(a => a.id === agentId);
        const name = (agent?.name || agentId).toLowerCase();
        const matches = notes.filter(n => (n.title || '').toLowerCase().includes(name) || (n.excerpt || '').toLowerCase().includes(name));
        const list = matches.length ? matches : notes.slice(0, 10);
        if (list.length === 0) {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-text">No notes found</div></div>';
            return;
        }
        container.innerHTML = list.map(n => `
            <div class="note-row">
                <div class="note-title">${escapeHtml(n.title)}</div>
                <div class="note-excerpt">${escapeHtml(n.excerpt)}</div>
                <div class="note-actions">
                    <button class="btn btn-secondary btn-sm" onclick="openNoteInModal('${encodeURIComponent(n.path)}', ${JSON.stringify(n.title || '')})">Open</button>
                </div>
            </div>
        `).join('');
    } catch (err) {
        console.error('Failed to load notes', err);
        container.innerHTML = '<div class="empty-state"><div class="empty-state-text">Failed to load notes</div></div>';
    }
}

async function openNoteInModal(pathEncoded, title) {
    const path = decodeURIComponent(pathEncoded);
    const container = document.getElementById('agent-note-view');
    const list = document.getElementById('agent-details-notes-list');
    if (!container) return;
    try {
        const resp = await fetch('/proxy/openclaw/notes/raw?path=' + encodeURIComponent(path));
        const data = await resp.json();
        if (data && data.content) {
            document.getElementById('agent-note-title').textContent = title || data.path;
            document.getElementById('agent-note-content').textContent = data.content;
            container.style.display = 'block';
            if (list) list.style.display = 'none';
        } else {
            showToast('Failed to open note', 'error');
        }
    } catch (err) {
        console.error('Open note failed', err);
        showToast('Failed to open note', 'error');
    }
}

function closeAgentNoteView() {
    const container = document.getElementById('agent-note-view');
    const list = document.getElementById('agent-details-notes-list');
    if (container) container.style.display = 'none';
    if (list) list.style.display = 'block';
}

// Memory
async function loadAgentMemory(agentId) {
    const container = document.getElementById('agent-details-memory-list');
    if (!container) return;
    container.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const agent = AGENTS.find(a => a.id === agentId) || {name: agentId};
        const q = encodeURIComponent(agent.name || agentId);
        const resp = await fetch(`/proxy/memory/search?query=${q}`);
        const data = await resp.json();
        const results = data.results || [];
        if (!results.length) {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-text">No memory snippets found</div></div>';
            return;
        }
        container.innerHTML = results.map(r => `
            <div class="memory-item">
                <div class="memory-context">${escapeHtml(r.context)}</div>
            </div>
        `).join('');
    } catch (err) {
        console.error('Memory load failed', err);
        container.innerHTML = '<div class="empty-state"><div class="empty-state-text">Failed to load memory</div></div>';
    }
}

// Logs
async function loadAgentLogs(lines = 200) {
    const out = document.getElementById('agent-details-logs-content');
    if (!out) return;
    out.textContent = 'Loading...';
    try {
        const resp = await fetch(`/proxy/logs?lines=${lines}`);
        const data = await resp.json();
        const linesArr = data.lines || [];
        out.textContent = linesArr.join('\n');
    } catch (err) {
        console.error('Failed to load logs', err);
        out.textContent = 'Failed to load logs';
    }
}

// Sessions: view detail & terminate
function viewSessionDetail(sessionKey) {
    const session = state.sessions.find(s => s.key === sessionKey);
    if (!session) {
        showToast('Session not found', 'error');
        return;
    }
    const container = document.getElementById('agent-session-detail');
    if (!container) return;
    const msgs = session.lastMessages || [];
    container.innerHTML = `
        <div class="session-detail-header">${escapeHtml(session.key)}</div>
        <div class="session-messages">${msgs.map(m => `<div class="msg"><strong>${escapeHtml(m.role)}</strong>: ${escapeHtml(m.content)}</div>`).join('')}</div>
    `;
}

async function terminateSession(sessionKey) {
    if (!confirm(`Terminate session ${sessionKey}?`)) return;
    try {
        const resp = await fetch('/proxy/openclaw/sessions/terminate', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({sessionKey})
        });
        const data = await resp.json();
        if (data && !data.error) {
            showToast('Session terminated', 'success');
            await loadSessions();
            viewAgentDetails(agentModalCurrentId);
        } else {
            showToast(`Failed to terminate: ${data?.error || 'Unknown'}`, 'error');
        }
    } catch (err) {
        console.error('Terminate failed', err);
        showToast('Failed to terminate session', 'error');
    }
}

// ===== Settings Helpers =====
async function loadSettings(populateOnly = false) {
    try {
        const resp = await fetch('/proxy/dashboard/settings');
        const data = await resp.json();
        const s = data.settings || {};

        // Populate form if present
        const el = (id) => document.getElementById(id);
        if (el('settings-hashnode-key')) el('settings-hashnode-key').value = s.hashnode_api_key || '';
        if (el('settings-hashnode-url')) el('settings-hashnode-url').value = s.hashnode_url || '';
        if (el('settings-publication-id')) el('settings-publication-id').value = s.publication_id || '';
        if (el('settings-schedule-hour')) el('settings-schedule-hour').value = typeof s.scheduleHour !== 'undefined' ? s.scheduleHour : CONFIG.scheduleHour;
        if (el('settings-notes-path')) el('settings-notes-path').value = s.notes_path || '';
        if (el('settings-rss-feeds')) el('settings-rss-feeds').value = (s.rss_feeds || []).join('\n');

        // Populate providers JSON textarea
        try {
            if (el('settings-providers-json')) {
                el('settings-providers-json').value = JSON.stringify(s.providers || {}, null, 2);
            }
        } catch (e) {
            console.error('Failed to populate providers JSON:', e);
            if (el('settings-providers-json')) el('settings-providers-json').value = '{}';
        }

        // Update runtime config
        if (typeof s.scheduleHour !== 'undefined') {
            CONFIG.scheduleHour = parseInt(s.scheduleHour);
        }

        if (!populateOnly) {
            showToast('Settings loaded', 'success');
        }

        return s;
    } catch (err) {
        console.error('Failed to load settings:', err);
        showToast('Failed to load settings', 'error');
        return {};
    }
}

async function saveSettings() {
    try {
        const get = (id) => document.getElementById(id)?.value || '';
        const settings = {
            hashnode_api_key: get('settings-hashnode-key').trim(),
            hashnode_url: get('settings-hashnode-url').trim(),
            publication_id: get('settings-publication-id').trim(),
            scheduleHour: parseInt(get('settings-schedule-hour')) || CONFIG.scheduleHour,
            notes_path: get('settings-notes-path').trim(),
            rss_feeds: (get('settings-rss-feeds').split('\n').map(s => s.trim()).filter(Boolean)),
        };

        // Read providers JSON textarea and include in settings
        try {
            const provText = get('settings-providers-json').trim();
            settings.providers = provText ? JSON.parse(provText) : {};
        } catch (e) {
            showToast('Invalid providers JSON', 'error');
            return false;
        }

        const resp = await fetch('/proxy/dashboard/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings }),
        });
        const data = await resp.json();
        if (data && data.ok) {
            showToast('Settings saved', 'success');
            // Apply new settings to runtime
            CONFIG.scheduleHour = settings.scheduleHour;
            // reload data
            await refreshAll();
            return true;
        } else {
            showToast('Failed to save settings', 'error');
            console.error('Save settings failed:', data);
            return false;
        }
    } catch (err) {
        console.error('Failed to save settings:', err);
        showToast('Failed to save settings', 'error');
        return false;
    }
}

// ===== Initialization =====
async function refreshAll() {
    await Promise.all([
        checkGatewayStatus(),
        
        loadSessions(),
        loadCronJobs(),
        
        loadActivity(),
        loadBlogPosts(),
        loadLearningNotes(),
        loadScheduleHistory(),
        loadUsage(),
        loadOllama(),
        loadPollers(),
    ]);
}

async function init() {
    // Set up navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            showPanel(item.dataset.panel);
        });
    });

    // Render static content
    renderAgents();

    // Load settings first
    await loadSettings();

    // Initial load
    refreshAll();

    // Start countdown timer
    setInterval(updateScheduleCountdown, 1000);

    // Auto-refresh
    setInterval(() => {
        if (document.getElementById('auto-refresh')?.checked !== false) {
            refreshAll();
        }
    }, CONFIG.refreshInterval);
}

// Start the app
document.addEventListener('DOMContentLoaded', init);

// ===== Usage Tracking =====
let usageData = { summary: {}, events: [] };
let filteredEvents = [];

async function loadUsage() {
    try {
        const resp = await fetch('/proxy/usage');
        const data = await resp.json();
        usageData = data;
        filteredEvents = data.events || [];
        renderUsage();
    } catch (err) {
        console.error('Failed to load usage:', err);
        document.getElementById('usage-providers-grid').innerHTML = '<div class="empty-state">Failed to load usage data</div>';
    }
}

function renderUsage() {
    const summary = usageData.summary || {};
    const events = usageData.events || [];

    // Update stats
    const totalReqs = summary.total_requests || 0;
    let providers = Object.keys(summary).filter(k => k !== 'total_requests');

    // Optionally hide internal providers like 'Gateway'
    const hideInternal = document.getElementById('hide-internal')?.checked;
    if (hideInternal) {
        providers = providers.filter(p => p !== 'Gateway');
    }

    let totalModels = 0;
    providers.forEach(p => {
        if (summary[p]?.models) {
            totalModels += Object.keys(summary[p].models).length;
        }
    });

    document.getElementById('usage-total-requests').textContent = totalReqs.toLocaleString();
    document.getElementById('usage-providers-count').textContent = providers.length;
    document.getElementById('usage-models-count').textContent = totalModels;

    // Update provider filter dropdown
    const filterEl = document.getElementById('usage-provider-filter');
    const currentVal = filterEl.value;
    filterEl.innerHTML = '<option value="all">All Providers</option>';
    providers.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        filterEl.appendChild(opt);
    });
    filterEl.value = currentVal || 'all';

    // Render chart
    renderUsageChart(summary, providers);

    // Render providers grid
    renderProvidersGrid(summary, providers);

    // Render events
    renderUsageEvents();
}

function renderUsageChart(summary, providers) {
    const chartEl = document.getElementById('usage-chart');
    if (!providers.length) {
        chartEl.innerHTML = '<div class="empty-state-text">No data yet</div>';
        return;
    }

    // Calculate max for scaling
    let max = 1;
    const providerTotals = {};
    providers.forEach(p => {
        let total = 0;
        if (summary[p]?.models) {
            Object.values(summary[p].models).forEach(m => {
                total += m.requests || 0;
            });
        }
        providerTotals[p] = total;
        if (total > max) max = total;
    });

    // Generate bar chart
    const colors = ['#0ea5a1', '#6366f1', '#f59e0b', '#ef4444', '#10b981', '#8b5cf6', '#ec4899'];
    let html = '';
    providers.forEach((p, i) => {
        const total = providerTotals[p];
        const height = Math.max(20, (total / max) * 160);
        const color = colors[i % colors.length];
        html += `
            <div style="display:flex;flex-direction:column;align-items:center;flex:1;min-width:60px;">
                <div style="font-size:12px;color:#9fb0c8;margin-bottom:4px;">${total}</div>
                <div style="width:100%;max-width:50px;height:${height}px;background:${color};border-radius:4px 4px 0 0;"></div>
                <div style="font-size:11px;color:#e6eef8;margin-top:6px;text-align:center;word-break:break-all;">${p}</div>
            </div>
        `;
    });
    chartEl.innerHTML = html;
}

function renderProvidersGrid(summary, providers) {
    const gridEl = document.getElementById('usage-providers-grid');
    if (!providers.length) {
        gridEl.innerHTML = '<div class="empty-state"><div class="empty-state-text">No usage data collected yet</div></div>';
        return;
    }

    let html = '';
    providers.forEach(p => {
        const models = summary[p]?.models || {};
        const modelNames = Object.keys(models);
        let totalReqs = 0;
        modelNames.forEach(m => { totalReqs += models[m].requests || 0; });

        html += `
            <div class="card" style="padding:16px;">
                <h4 style="margin:0 0 12px;display:flex;align-items:center;gap:8px;">
                    <span style="font-size:20px;">🔌</span> ${p}
                    <span style="margin-left:auto;font-size:14px;color:#9fb0c8;">${totalReqs} requests</span>
                </h4>
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                    <thead>
                        <tr style="color:#9fb0c8;">
                            <th style="text-align:left;padding:6px 4px;border-bottom:1px solid #334155;">Model/Endpoint</th>
                            <th style="text-align:right;padding:6px 4px;border-bottom:1px solid #334155;">Requests</th>
                            <th style="text-align:right;padding:6px 4px;border-bottom:1px solid #334155;">Last</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${modelNames.map(m => {
                            const info = models[m];
                            const lastTs = info.last ? new Date(info.last * 1000).toLocaleTimeString() : '-';
                            return `
                                <tr>
                                    <td style="padding:6px 4px;border-bottom:1px solid #1e293b;word-break:break-all;">${m}</td>
                                    <td style="padding:6px 4px;border-bottom:1px solid #1e293b;text-align:right;">${info.requests || 0}</td>
                                    <td style="padding:6px 4px;border-bottom:1px solid #1e293b;text-align:right;color:#9fb0c8;">${lastTs}</td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        `;
    });
    gridEl.innerHTML = html;
}

function renderUsageEvents() {
    const eventsEl = document.getElementById('usage-events');
    const events = filteredEvents.slice().reverse().slice(0, 100); // Most recent 100

    if (!events.length) {
        eventsEl.innerHTML = '<div class="empty-state"><div class="empty-state-text">No events yet</div></div>';
        return;
    }

    let html = '';
    events.forEach(e => {
        const ts = e.timestamp ? new Date(e.timestamp * 1000).toLocaleString() : '-';
        const provider = e.provider || 'unknown';
        const model = e.model || '-';
        const duration = typeof e.duration_s === 'number' ? `${e.duration_s.toFixed(2)}s` : '-';
        const hasError = e.error ? 'style="border-left:3px solid #ef4444;"' : '';
        
        html += `
            <div class="activity-item" ${hasError}>
                <div class="activity-icon">${e.error ? '❌' : '✅'}</div>
                <div class="activity-content">
                    <div class="activity-title">${provider} → ${model}</div>
                    <div class="activity-meta">${ts} · ${duration}${e.error ? ' · Error: ' + e.error.substring(0, 50) : ''}</div>
                </div>
            </div>
        `;
    });
    eventsEl.innerHTML = html;
}

function filterUsage() {
    const provider = document.getElementById('usage-provider-filter').value;
    if (provider === 'all') {
        filteredEvents = usageData.events || [];
    } else {
        filteredEvents = (usageData.events || []).filter(e => e.provider === provider);
    }
    renderUsageEvents();
}

function filterUsageEvents() {
    const query = (document.getElementById('usage-search').value || '').toLowerCase();
    const provider = document.getElementById('usage-provider-filter').value;
    
    let events = usageData.events || [];
    if (provider !== 'all') {
        events = events.filter(e => e.provider === provider);
    }
    if (query) {
        events = events.filter(e => {
            const str = JSON.stringify(e).toLowerCase();
            return str.includes(query);
        });
    }
    filteredEvents = events;
    renderUsageEvents();
}

// ===== Ollama Integration =====
let ollamaData = { local: { online: false, models: [] }, cloud: {} };

async function loadOllama() {
    try {
        const resp = await fetch('/proxy/ollama');
        const data = await resp.json();
        ollamaData = data;
        renderOllama();
    } catch (err) {
        console.error('Failed to load Ollama data:', err);
        document.getElementById('ollama-local-status').textContent = 'Error';
        document.getElementById('ollama-local-status').className = 'status-badge status-error';
    }
}

function renderOllama() {
    // Local status
    const statusEl = document.getElementById('ollama-local-status');
    if (ollamaData.local?.online) {
        statusEl.textContent = 'Local Online';
        statusEl.className = 'status-badge status-active';
    } else {
        statusEl.textContent = 'Local Offline';
        statusEl.className = 'status-badge status-idle';
    }

    // Local models
    const modelsEl = document.getElementById('ollama-local-models');
    const models = ollamaData.local?.models || [];
    if (models.length) {
        let html = '';
        models.forEach(m => {
            const sizeGB = (m.size / (1024 * 1024 * 1024)).toFixed(2);
            const badge = m.remote ? '<span style="background:#6366f1;color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;margin-left:6px;">cloud</span>' : '';
            html += `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #1e293b;">
                    <span>${m.name}${badge}</span>
                    <span style="color:#64748b;">${sizeGB} GB</span>
                </div>
            `;
        });
        modelsEl.innerHTML = html;
    } else {
        modelsEl.innerHTML = '<div style="color:#64748b;">No models found</div>';
    }

    // Cloud usage
    const cloud = ollamaData.cloud || {};
    const sessionUsage = cloud.session_usage;
    const weeklyUsage = cloud.weekly_usage;

    if (sessionUsage !== null && sessionUsage !== undefined) {
        document.getElementById('ollama-session-usage').textContent = `${sessionUsage}% used`;
        document.getElementById('ollama-session-bar').style.width = `${Math.min(100, sessionUsage)}%`;
        if (sessionUsage >= 100) {
            document.getElementById('ollama-session-bar').style.background = '#ef4444';
        } else if (sessionUsage >= 80) {
            document.getElementById('ollama-session-bar').style.background = '#f59e0b';
        } else {
            document.getElementById('ollama-session-bar').style.background = '#0ea5a1';
        }
    } else {
        document.getElementById('ollama-session-usage').textContent = '-';
        document.getElementById('ollama-session-bar').style.width = '0%';
    }

    if (cloud.session_reset) {
        document.getElementById('ollama-session-reset').textContent = `Resets in ${cloud.session_reset}`;
    } else {
        document.getElementById('ollama-session-reset').textContent = '-';
    }

    if (weeklyUsage !== null && weeklyUsage !== undefined) {
        document.getElementById('ollama-weekly-usage').textContent = `${weeklyUsage}% used`;
        document.getElementById('ollama-weekly-bar').style.width = `${Math.min(100, weeklyUsage)}%`;
    } else {
        document.getElementById('ollama-weekly-usage').textContent = '-';
        document.getElementById('ollama-weekly-bar').style.width = '0%';
    }

    if (cloud.weekly_reset) {
        document.getElementById('ollama-weekly-reset').textContent = `Resets in ${cloud.weekly_reset}`;
    } else {
        document.getElementById('ollama-weekly-reset').textContent = '-';
    }
}

function showOllamaUpdateModal() {
    const cloud = ollamaData.cloud || {};
    document.getElementById('ollama-input-session').value = cloud.session_usage || '';
    document.getElementById('ollama-input-session-reset').value = cloud.session_reset || '';
    document.getElementById('ollama-input-weekly').value = cloud.weekly_usage || '';
    document.getElementById('ollama-input-weekly-reset').value = cloud.weekly_reset || '';
    document.getElementById('ollama-modal').classList.add('active');
}

function hideOllamaModal() {
    document.getElementById('ollama-modal').classList.remove('active');
}

async function saveOllamaUsage() {
    const session_usage = parseFloat(document.getElementById('ollama-input-session').value) || null;
    const session_reset = document.getElementById('ollama-input-session-reset').value.trim() || null;
    const weekly_usage = parseFloat(document.getElementById('ollama-input-weekly').value) || null;
    const weekly_reset = document.getElementById('ollama-input-weekly-reset').value.trim() || null;

    try {
        const resp = await fetch('/proxy/ollama/cloud', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_usage, session_reset, weekly_usage, weekly_reset }),
        });
        const data = await resp.json();
        if (data.ok) {
            showToast('Ollama usage saved', 'success');
            hideOllamaModal();
            await loadOllama();
        } else {
            showToast('Failed to save: ' + (data.error || 'Unknown error'), 'error');
        }
    } catch (err) {
        console.error('Failed to save Ollama usage:', err);
        showToast('Failed to save Ollama usage', 'error');
    }
}

