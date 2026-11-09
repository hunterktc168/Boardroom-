/**
 * Boardroom Application Bootstrap & Router
 * Pure Vanilla ES Module — Zero build step, zero frameworks
 */

import { DEFAULT_AGENTS, PHASES, PHASE_AGENTS, THE_CHAIR } from './agents.js';
import { seedAgentsIfEmpty, getAll, get, getSetting } from './db.js';
import * as DashboardView from './views/dashboard.js';
import * as VentureView from './views/venture.js';
import * as AgentsView from './views/agents.js';
import * as SettingsView from './views/settings.js';

// Application State
const state = {
  currentVenture: {
    id: 'default',
    name: 'Apex Robotics',
    thesis: 'Autonomous micro-fulfillment robotic carts for decentralized grocery hubs',
  },
  currentRoute: '',
  currentParams: {},
};

// Route Definitions
const routes = [
  {
    pattern: /^#\/dashboard\/?$/,
    name: 'dashboard',
    render: DashboardView.render,
  },
  {
    pattern: /^#\/venture\/([^/]+)\/(boardroom|deliverables|notes)\/?$/,
    name: 'venture',
    paramKeys: ['ventureId', 'tab'],
    render: VentureView.render,
  },
  {
    pattern: /^#\/venture\/([^/]+)\/phase\/([^/]+)\/?$/,
    name: 'phase',
    paramKeys: ['ventureId', 'phase'],
    render: (root, params) => VentureView.render(root, { ...params, tab: 'boardroom' }),
  },
  {
    pattern: /^#\/venture\/([^/]+)\/?$/,
    name: 'venture',
    paramKeys: ['ventureId'],
    render: (root, params) => VentureView.render(root, { ...params, tab: 'boardroom', phase: 'ideation' }),
  },
  {
    pattern: /^#\/agents\/?$/,
    name: 'agents',
    render: AgentsView.render,
  },
  {
    pattern: /^#\/settings\/?$/,
    name: 'settings',
    render: SettingsView.render,
  },
];

/**
 * Resolve the current hash and route match (supports query parameters like ?phase=ideation)
 */
function resolveRoute() {
  const fullHash = window.location.hash || '#/dashboard';
  const [hashPath, queryString] = fullHash.split('?');

  let matched = null;
  for (const route of routes) {
    const match = hashPath.match(route.pattern);
    if (match) {
      const params = {};
      if (route.paramKeys) {
        route.paramKeys.forEach((key, index) => {
          params[key] = match[index + 1];
        });
      }
      matched = { route, params, hash: fullHash };
      break;
    }
  }

  if (!matched) {
    matched = {
      route: routes[0],
      params: {},
      hash: '#/dashboard',
    };
  }

  // Parse query parameters
  if (queryString) {
    const searchParams = new URLSearchParams(queryString);
    for (const [key, val] of searchParams.entries()) {
      matched.params[key] = val;
    }
  }

  return matched;
}

/**
 * Router Dispatcher
 */
async function navigate() {
  const { route, params, hash } = resolveRoute();

  if (window.location.hash !== hash) {
    window.location.hash = hash;
    return;
  }

  state.currentRoute = route.name;
  state.currentParams = params;

  // Sync active venture details if ventureId is present
  if (params.ventureId) {
    const v = await get('ventures', params.ventureId);
    if (v) {
      state.currentVenture = { id: v.id, name: v.name, thesis: v.oneliner || v.thesis };
    }
  } else {
    const storedName = await getSetting('active_venture_name');
    const storedId = await getSetting('active_venture_id');
    if (storedName) state.currentVenture.name = storedName;
    if (storedId) state.currentVenture.id = storedId;
  }

  // Mount view
  const root = document.getElementById('view-root');
  if (root && route.render) {
    try {
      await route.render(root, params);
      root.focus();
    } catch (err) {
      console.error('View render error:', err);
      root.innerHTML = `
        <div class="panel p-6 border-danger/40 bg-danger/10 text-danger text-sm">
          <strong>Error rendering view:</strong> ${err.message}
        </div>
      `;
    }
  }

  // Synchronize Chrome Elements
  updateTopBar(route.name, params);
  await updateSidebar(route.name, params);
  await updateRightRail(params.phase || 'ideation');
  closeMobileDrawer();
}

/**
 * Synchronize Top Bar titles & phase badge
 */
function updateTopBar(routeName, params) {
  const ventureEl = document.getElementById('topbar-venture');
  const phaseBadgeEl = document.getElementById('topbar-phase-badge');

  if (ventureEl) {
    ventureEl.textContent = state.currentVenture.name;
  }

  if (phaseBadgeEl) {
    const phaseKey = params.phase || (params.tab === 'boardroom' ? 'ideation' : null);
    if (phaseKey) {
      const p = PHASES.find(item => item.id === phaseKey);
      if (p) {
        phaseBadgeEl.textContent = `Phase 0${p.number}: ${p.label}`;
        phaseBadgeEl.className = 'chip border-brass/40 text-brass-light bg-brass/10 text-xs py-0.5';
      }
    } else if (routeName === 'venture') {
      const tabName = params.tab ? params.tab.toUpperCase() : 'WORKSPACE';
      phaseBadgeEl.textContent = tabName;
      phaseBadgeEl.className = 'chip border-brass/40 text-brass-light bg-brass/10 text-xs py-0.5';
    } else if (routeName === 'dashboard') {
      phaseBadgeEl.textContent = 'Dashboard';
      phaseBadgeEl.className = 'chip text-slate-300 bg-panel text-xs py-0.5 border-subtle';
    } else if (routeName === 'agents') {
      phaseBadgeEl.textContent = 'Board Roster';
      phaseBadgeEl.className = 'chip text-slate-300 bg-panel text-xs py-0.5 border-subtle';
    } else if (routeName === 'settings') {
      phaseBadgeEl.textContent = 'Settings';
      phaseBadgeEl.className = 'chip text-slate-300 bg-panel text-xs py-0.5 border-subtle';
    }
  }
}

/**
 * Synchronize Sidebar Active Link & Phase Stepper highlights
 * Reflects real state: filled dot if messages exist, checkmark if deliverable exists
 */
async function updateSidebar(routeName, params) {
  // Update sidebar active venture label
  const sidebarVentureLabel = document.getElementById('sidebar-venture-name');
  if (sidebarVentureLabel) {
    sidebarVentureLabel.textContent = state.currentVenture.name;
  }

  // Update general nav links
  const navLinks = document.querySelectorAll('.sidebar-nav-link');
  navLinks.forEach((link) => {
    const linkRoute = link.getAttribute('data-route');
    if (linkRoute === routeName && !params.ventureId) {
      link.classList.add('bg-white/10', 'text-slate-100', 'font-semibold');
      link.classList.remove('text-slate-300');
    } else {
      link.classList.remove('bg-white/10', 'text-slate-100', 'font-semibold');
      link.classList.add('text-slate-300');
    }
  });

  // Query real session and deliverable records for active venture
  const activeVentureId = params.ventureId || state.currentVenture.id || 'default';
  let allSessions = [];
  let allDeliverables = [];
  try {
    allSessions = await getAll('sessions');
    allDeliverables = await getAll('deliverables');
  } catch (e) {
    // Graceful fallback
  }

  const phaseLinks = document.querySelectorAll('.phase-step-link');
  phaseLinks.forEach((link, idx) => {
    const phaseKey = link.getAttribute('data-phase');
    const stepNum = link.querySelector('.step-num');

    // Dynamically update link target to active venture with query
    link.href = `#/venture/${activeVentureId}/boardroom?phase=${phaseKey}`;

    const hasDeliverable = allDeliverables.some(d => d.ventureId === activeVentureId && d.phase === phaseKey);
    const hasMessages = allSessions.some(s => s.ventureId === activeVentureId && s.phase === phaseKey && (s.messages || s.transcript || []).length > 0);

    const isCurrentPhase = (routeName === 'phase' || routeName === 'venture') && (params.phase === phaseKey || (!params.phase && params.tab === 'boardroom' && idx === 0));

    if (isCurrentPhase) {
      link.classList.add('bg-brass/10', 'text-brass-light', 'font-semibold', 'border', 'border-brass/30');
      link.classList.remove('text-slate-300');
    } else {
      link.classList.remove('bg-brass/10', 'text-brass-light', 'font-semibold', 'border', 'border-brass/30');
      link.classList.add('text-slate-300');
    }

    if (stepNum) {
      if (hasDeliverable) {
        stepNum.className = 'step-num w-5 h-5 rounded-full bg-brass/20 text-brass-light border border-brass/50 text-[11px] font-bold flex items-center justify-center shrink-0';
        stepNum.textContent = '✓';
      } else if (hasMessages) {
        stepNum.className = 'step-num w-5 h-5 rounded-full bg-slate-300 text-base text-[9px] font-bold flex items-center justify-center shrink-0';
        stepNum.textContent = '●';
      } else {
        stepNum.className = `step-num w-5 h-5 rounded-full border ${isCurrentPhase ? 'border-brass text-brass-light bg-brass/20' : 'border-subtle text-muted'} text-xs font-mono flex items-center justify-center shrink-0`;
        stepNum.textContent = `${idx + 1}`;
      }
    }
  });
}

/**
 * Synchronize Right Rail "Board at the table"
 */
async function updateRightRail(currentPhaseId) {
  const container = document.getElementById('right-rail-agents-list');
  const countBadge = document.getElementById('right-rail-count');
  if (!container) return;

  // Retrieve roster from IndexedDB
  const stored = await getAll('agents');
  const roster = (stored && stored.length > 0) ? stored : DEFAULT_AGENTS;

  const allowedAgentIds = PHASE_AGENTS[currentPhaseId] || ['maya', 'sam', 'david'];
  const assignedAgents = [
    THE_CHAIR,
    ...roster.filter(a => a.enabled && allowedAgentIds.includes(a.id))
  ];

  if (countBadge) {
    countBadge.textContent = `${assignedAgents.length} Active`;
  }

  container.innerHTML = assignedAgents.map((agent) => {
    const colorClass = `agent-${agent.color || 'cyan'}`;
    const colorBgClass = `agent-${agent.color || 'cyan'}-bg`;

    return `
      <div class="p-3 rounded-lg bg-base border border-subtle hover:border-border-strong transition-all flex items-start gap-3">
        <span class="avatar w-8 h-8 text-xs ${colorBgClass} ${colorClass} border-base shadow-sm font-mono font-bold shrink-0">
          ${agent.initials || agent.id.toUpperCase().slice(0, 2)}
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between">
            <div class="text-xs font-semibold text-slate-200 truncate">${agent.name}</div>
            <span class="chip text-[9px] py-0 px-1 uppercase font-mono text-muted">${agent.shortRole}</span>
          </div>
          <div class="text-[11px] text-muted truncate">${agent.role}</div>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Mobile Drawer Controls
 */
function openMobileDrawer() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('mobile-backdrop');
  if (sidebar && backdrop) {
    sidebar.classList.remove('-translate-x-full');
    backdrop.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
  }
}

function closeMobileDrawer() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('mobile-backdrop');
  if (sidebar && backdrop) {
    sidebar.classList.add('-translate-x-full');
    backdrop.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
  }
}

/**
 * Bootstrap Application
 */
async function init() {
  // Seed default agents if IndexedDB is empty on first boot
  try {
    await seedAgentsIfEmpty(DEFAULT_AGENTS);
  } catch (err) {
    console.warn('Initial IndexedDB seed warning:', err);
  }

  // Venture switcher button in sidebar routes to dashboard
  const ventureSwitcherBtn = document.getElementById('venture-switcher-btn');
  if (ventureSwitcherBtn) {
    ventureSwitcherBtn.addEventListener('click', () => {
      window.location.hash = '#/dashboard';
      closeMobileDrawer();
    });
  }

  // Mobile drawer events
  const menuBtn = document.getElementById('mobile-menu-btn');
  const closeBtn = document.getElementById('close-sidebar-btn');
  const backdrop = document.getElementById('mobile-backdrop');

  if (menuBtn) menuBtn.addEventListener('click', openMobileDrawer);
  if (closeBtn) closeBtn.addEventListener('click', closeMobileDrawer);
  if (backdrop) backdrop.addEventListener('click', closeMobileDrawer);

  // Close drawer on escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMobileDrawer();
  });

  // Hash change listener
  window.addEventListener('hashchange', navigate);

  // Cross-view state synchronization listener (sidebar stepper, right rail)
  window.addEventListener('boardroom:sync', async () => {
    const { route, params } = resolveRoute();
    await updateSidebar(route.name, params);
    await updateRightRail(params.phase || 'ideation');
  });

  // Initial navigation
  if (!window.location.hash) {
    window.location.hash = '#/dashboard';
  } else {
    await navigate();
  }
}

// Kick off when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
