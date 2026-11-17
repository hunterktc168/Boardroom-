/**
 * Venture Workspace & Boardroom Chamber View Module
 * Route: #/venture/:id/(boardroom|deliverables|notes)
 * Supports query params: ?phase=ideation&mode=single&agent=maya
 *
 * Implements:
 * 1. Single-Agent 1:1 Direct Chat:
 *    - Mode switcher: [Convene full board] and [Ask one member ▾].
 *    - Inline agent picker with avatars for PHASE_AGENTS[phase].
 *    - Isolated threads scoped by (ventureId, phase, agentId).
 *    - Real-time chunk streaming with AbortController Stop button.
 *    - Agent typing indicators in persona colors.
 *    - Inline error bubble with Retry and Settings link; never loses user messages.
 *    - Actions row: Copy, Regenerate, Ask another member, Promote to deliverable note.
 * 2. Multi-Agent Boardroom Chamber Deliberation:
 *    - Sequential full-board deliberation rounds with The Chair and active directors.
 * 3. Milestone Deliverable Synthesis with The Chair:
 *    - Live streaming synthesis modal, cumulative board memory updates, export tools (Copy, Download .md, Print).
 */

import { getVenture, saveVenture, getAll, put, setSetting, getThreadSession } from '../db.js';
import { PHASES, PHASE_AGENTS, DEFAULT_AGENTS, THE_CHAIR, getAgent } from '../agents.js';
import { renderMarkdown, escapeHtml } from '../markdown.js';
import {
  conveneDeliberationRound,
  singleAgentChat,
  regenerateLastAgentReply,
  synthesizePhaseDeliverable,
  challengeClaimWithDavid,
  retrySpeakerInRound,
  deriveSessionTitle
} from '../orchestrator.js';

// Phase Empty State Motivating Copy (Full-Board Chamber)
const EMPTY_STATES = {
  'ideation': 'Pitch the raw idea. Maya will expand it, Sam will ground it in a real customer, David will try to break it.',
  'validation': 'Turn assumptions into tests. David runs the interrogation.',
  'business-plan': 'Priya and Elena build the model, the moat, and the money.',
  'marketing': 'Marcus turns the plan into a launch.'
};

// 1:1 Persona Conversation Starters
const AGENT_STARTERS = {
  maya: {
    copy: 'Maya Chen is ready to explore non-obvious wedges, blue-ocean angles, and adjacent market analogies.',
    pitch: 'What is our most contrarian wedge on this market that incumbents would instinctively dismiss?'
  },
  david: {
    copy: 'David Okafor is ready to pressure-test your assumptions with unsparing falsification tests and kill criteria.',
    pitch: 'Here is our core assumption: what is the single cleanest 14-day smoke test to prove or kill it?'
  },
  priya: {
    copy: 'Priya Raman is ready to architect a 90-day operating cadence, sequencing priorities, and defensible moats.',
    pitch: 'What is the primary operational dependency in our delivery stack that will break if volume grows 5x?'
  },
  marcus: {
    copy: 'Marcus Webb is ready to sharpen your ICP narrative, wedge positioning, and customer acquisition loops.',
    pitch: 'How do we position our wedge to make the incumbent status quo look like active negligence?'
  },
  elena: {
    copy: 'Elena Vasquez is ready to audit your unit economics, gross margin hurdle, and runway burn sensitivity.',
    pitch: 'Here is our proposed pricing tier: what hidden cost will destroy our gross margins as we scale?'
  },
  sam: {
    copy: 'Sam Torres is ready to audit customer friction and ruthlessly cut MVP scope to true PMF signals.',
    pitch: 'Where in our proposed onboarding workflow will users experience cognitive friction and churn?'
  },
  chair: {
    copy: 'The Chair is ready to advise on executive governance, meeting sequencing, and milestone synthesis.',
    pitch: 'How should we sequence our board priorities for this milestone review?'
  }
};

// Relative Time Formatter
function formatRelativeTime(timestamp) {
  if (!timestamp) return 'Just now';
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 45) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export async function render(container, params = {}) {
  const ventureId = params.ventureId || params.id || 'default';
  const activeTab = params.tab || 'boardroom';
  const activePhaseId = params.phase || 'ideation';

  // Load venture from IndexedDB
  let venture = await getVenture(ventureId);

  // Fallback if not found
  if (!venture) {
    venture = {
      id: ventureId,
      name: 'Apex Robotics',
      oneliner: 'Autonomous micro-fulfillment robotic carts for decentralized grocery hubs.',
      thesis: 'Autonomous micro-fulfillment robotic carts for decentralized grocery hubs.',
      industry: 'Logistics',
      stage: 'Prototype',
      biggestUnknown: 'Unit labor payback under sub-scale facility utilization.',
      notes: '',
      boardMemory: 'Initial board alignment convened on core logistics wedge.',
      completedPhases: []
    };
    await saveVenture(venture);
  }

  // Synchronize active venture in settings
  await setSetting('active_venture_id', venture.id);
  await setSetting('active_venture_name', venture.name);

  // Load Deliverables
  const allDeliverables = await getAll('deliverables');
  const ventureDeliverables = allDeliverables.filter(d => d.ventureId === venture.id);
  const phaseDeliverable = ventureDeliverables.find(d => d.phase === activePhaseId);

  // Phase & Seated Agents calculations
  const phaseIndex = PHASES.findIndex(p => p.id === activePhaseId);
  const currentPhase = phaseIndex >= 0 ? PHASES[phaseIndex] : PHASES[0];
  const safePhaseIdx = phaseIndex >= 0 ? phaseIndex : 0;

  const prevPhase = safePhaseIdx > 0 ? PHASES[safePhaseIdx - 1] : null;
  const nextPhase = safePhaseIdx < PHASES.length - 1 ? PHASES[safePhaseIdx + 1] : null;

  // Retrieve enabled agents from IndexedDB
  const storedAgents = await getAll('agents');
  const roster = (storedAgents && storedAgents.length > 0) ? storedAgents : DEFAULT_AGENTS;

  const assignedAgentIds = PHASE_AGENTS[currentPhase.id] || ['maya', 'sam', 'david'];
  const phaseAgents = roster
    .filter(a => a.enabled && assignedAgentIds.includes(a.id))
    .sort((a, b) => assignedAgentIds.indexOf(a.id) - assignedAgentIds.indexOf(b.id));
  const seatedAgents = [THE_CHAIR, ...phaseAgents];

  // Mode and Target Agent determination from params or defaults
  const activeMode = params.mode === 'single' || params.agent ? 'single' : 'all';
  const defaultAgentId = assignedAgentIds[0] || 'maya';
  const activeTargetAgentId = params.agent || defaultAgentId;
  const currentTargetAgent = getAgent(activeTargetAgentId) || phaseAgents[0] || DEFAULT_AGENTS[0];

  // Load Scoped Session Thread
  const activeSession = await getThreadSession(
    venture.id,
    currentPhase.id,
    activeMode === 'single' ? activeTargetAgentId : 'all'
  );
  const messages = activeSession.messages || [];

  // Update Topbar
  const topbarVenture = document.getElementById('topbar-venture');
  const topbarPhase = document.getElementById('topbar-phase-badge');
  const actionSlot = document.getElementById('topbar-action-slot');

  if (topbarVenture) topbarVenture.textContent = venture.name;
  if (topbarPhase) {
    if (activeTab === 'boardroom') {
      topbarPhase.textContent = `Phase 0${currentPhase.number}: ${currentPhase.label}`;
      topbarPhase.className = 'chip border-brass/40 text-brass-light bg-brass/10 text-xs py-0.5';
    } else if (activeTab === 'deliverables') {
      topbarPhase.textContent = 'Deliverables Archive';
      topbarPhase.className = 'chip border-brass/40 text-brass-light bg-brass/10 text-xs py-0.5';
    } else {
      topbarPhase.textContent = 'Founder Notes';
      topbarPhase.className = 'chip text-slate-300 bg-panel text-xs py-0.5 border-subtle';
    }
  }

  if (actionSlot) {
    if (activeTab === 'boardroom') {
      actionSlot.innerHTML = `
        <button id="topbar-synthesize-btn" class="btn btn-primary text-xs py-1.5 px-3">
          <svg class="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <span>Synthesize Memo</span>
        </button>
        <a href="#/dashboard" class="btn btn-ghost text-xs py-1.5 px-3 border border-subtle">
          Portfolio
        </a>
      `;
    } else {
      actionSlot.innerHTML = `
        <a href="#/venture/${venture.id}/boardroom?phase=${activePhaseId}" class="btn btn-primary text-xs py-1.5 px-3">
          Boardroom Chamber →
        </a>
        <a href="#/dashboard" class="btn btn-ghost text-xs py-1.5 px-3 border border-subtle">
          Portfolio
        </a>
      `;
    }
  }

  container.innerHTML = `
    <div class="space-y-6 animate-fadeIn max-w-5xl mx-auto">
      <!-- Venture Workspace Header -->
      <section class="panel p-6 border-subtle relative">
        <div class="flex flex-col md:flex-row md:items-start justify-between gap-4 pb-4 border-b border-subtle">
          <div class="space-y-2 flex-1 min-w-0">
            <!-- Industry & Stage Chips -->
            <div class="flex items-center gap-2 flex-wrap">
              <span class="chip text-xs bg-base border-subtle font-medium text-slate-300">
                ${escapeHtml(venture.industry || 'Technology')}
              </span>
              <span class="chip text-xs bg-brass/10 border-brass/30 text-brass-light font-medium">
                ${escapeHtml(venture.stage || 'Idea')}
              </span>
              <span class="text-[11px] font-mono text-muted">ID: ${escapeHtml(venture.id)}</span>
            </div>

            <!-- Editable Name Lockup -->
            <div class="flex items-center gap-2 group/edit">
              <h1 id="venture-display-name" class="font-serif text-3xl sm:text-4xl text-slate-100 font-normal truncate">
                ${escapeHtml(venture.name)}
              </h1>
              <button id="edit-name-btn" class="p-1.5 text-muted hover:text-brass-light rounded hover:bg-white/5 transition-colors" title="Edit venture name">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </button>
            </div>

            <!-- Inline Name Edit Form (Hidden by default) -->
            <div id="inline-edit-name-container" class="hidden flex items-center gap-2 max-w-md pt-1">
              <input type="text" id="inline-name-input" class="input text-sm py-1" value="${escapeHtml(venture.name)}" />
              <button id="save-name-btn" class="btn btn-primary text-xs py-1 px-3">Save</button>
              <button id="cancel-name-btn" class="btn btn-ghost text-xs py-1 px-2 border border-subtle">Cancel</button>
            </div>

            <!-- One-Liner Description -->
            <p class="text-xs sm:text-sm text-muted leading-relaxed max-w-3xl">
              ${escapeHtml(venture.oneliner || venture.thesis || 'No core thesis provided.')}
            </p>
          </div>

          <!-- Phase Stage-Gate Dots Indicator -->
          <div class="p-3 rounded-lg bg-base border border-subtle shrink-0">
            <div class="text-[10px] font-mono uppercase text-muted mb-1.5 flex items-center justify-between">
              <span>Stage-Gates</span>
              <span class="text-brass-light font-bold" id="completed-phases-count">${(venture.completedPhases || []).length}/4</span>
            </div>
            <div class="flex gap-2" id="header-stage-dots">
              ${PHASES.map((p, idx) => {
                const isComplete = (venture.completedPhases || []).includes(p.id);
                return `
                  <a href="#/venture/${venture.id}/boardroom?phase=${p.id}" class="flex flex-col items-center gap-1 group/dot" title="Go to ${p.label}">
                    <span class="w-5 h-5 rounded-full flex items-center justify-center font-mono text-[10px] transition-all ${isComplete ? 'bg-brass text-base font-bold shadow-sm' : (p.id === activePhaseId ? 'border-2 border-brass text-brass-light' : 'border border-subtle text-muted group-hover/dot:border-slate-400')}">
                      ${isComplete ? '✓' : idx + 1}
                    </span>
                    <span class="text-[9px] font-mono uppercase ${p.id === activePhaseId ? 'text-brass-light font-bold' : 'text-faint'}">${p.id.slice(0, 3)}</span>
                  </a>
                `;
              }).join('')}
            </div>
          </div>
        </div>

        <!-- Expandable Board Memory Panel -->
        <div class="pt-3">
          <details class="group rounded-lg border border-subtle bg-base overflow-hidden" id="board-memory-details">
            <summary class="p-3 text-xs font-semibold uppercase tracking-wider text-slate-300 cursor-pointer flex items-center justify-between hover:bg-white/5 transition-colors">
              <span class="flex items-center gap-2">
                <svg class="w-4 h-4 text-brass" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                Board Memory & Deliberation Synthesis (Cumulative)
              </span>
              <span class="text-[10px] text-muted font-mono group-open:rotate-180 transition-transform">▼</span>
            </summary>
            <div class="p-4 border-t border-subtle bg-[#080B0F] text-xs text-slate-300 leading-relaxed space-y-2">
              <div class="text-[11px] text-slate-300 whitespace-pre-wrap font-sans" id="board-memory-content">
                ${venture.boardMemory ? escapeHtml(venture.boardMemory) : 'Board memory is currently in initial capture mode. Key findings, evidence bars, and unanimous directives will accumulate here across deliberation sessions.'}
              </div>
              <div class="text-[10px] text-faint pt-1 border-t border-subtle/50 font-mono flex items-center justify-between">
                <span>Memory store synced with IndexedDB</span>
                <span class="text-brass-light font-semibold">Stage-Gate Audit Trail</span>
              </div>
            </div>
          </details>
        </div>
      </section>

      <!-- Workspace Navigation Tabs -->
      <div class="flex items-center gap-1 border-b border-subtle">
        <a href="#/venture/${venture.id}/boardroom?phase=${activePhaseId}" class="tab-link px-4 py-2.5 text-xs font-medium border-b-2 transition-all flex items-center gap-2 ${activeTab === 'boardroom' ? 'border-brass text-brass-light font-semibold' : 'border-transparent text-muted hover:text-slate-200'}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          Boardroom Chamber
        </a>

        <a href="#/venture/${venture.id}/deliverables" class="tab-link px-4 py-2.5 text-xs font-medium border-b-2 transition-all flex items-center gap-2 ${activeTab === 'deliverables' ? 'border-brass text-brass-light font-semibold' : 'border-transparent text-muted hover:text-slate-200'}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Deliverables Archive
          <span class="chip text-[10px] py-0 px-1.5 bg-base" id="deliverables-tab-badge">${ventureDeliverables.length}</span>
        </a>

        <a href="#/venture/${venture.id}/notes" class="tab-link px-4 py-2.5 text-xs font-medium border-b-2 transition-all flex items-center gap-2 ${activeTab === 'notes' ? 'border-brass text-brass-light font-semibold' : 'border-transparent text-muted hover:text-slate-200'}">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          Founder Notes
        </a>
      </div>

      <!-- Tab Content Area -->
      <div id="tab-content-root">
        ${activeTab === 'boardroom' ? renderBoardroomTab({
            venture,
            currentPhase,
            safePhaseIdx,
            prevPhase,
            nextPhase,
            seatedAgents,
            phaseAgents,
            activeMode,
            activeTargetAgentId,
            currentTargetAgent,
            messages,
            rounds: activeSession.rounds || [],
            phaseDeliverable
          }) : (activeTab === 'deliverables' ? renderDeliverablesTab({ venture, ventureDeliverables }) : renderNotesTab({ venture }))
        }
      </div>
    </div>

    <!-- Synthesis Modal Container -->
    <div id="synthesis-modal" class="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 hidden flex items-center justify-center p-4">
      <div class="panel max-w-3xl w-full max-h-[92vh] overflow-hidden border-brass/50 shadow-2xl flex flex-col animate-fadeIn" onclick="event.stopPropagation()">
        <!-- Header -->
        <div class="p-5 border-b border-subtle bg-panel flex items-center justify-between shrink-0">
          <div class="flex items-center gap-3">
            <span class="avatar w-10 h-10 text-xs agent-brass-bg agent-brass font-mono font-bold border border-brass/40 shadow-sm">
              CH
            </span>
            <div>
              <div class="flex items-center gap-2">
                <h3 class="font-serif text-xl text-slate-100">The Chair — Milestone Deliverable Synthesis</h3>
                <span id="synthesis-status-chip" class="chip text-[10px] py-0 px-2 agent-brass-bg agent-brass uppercase font-mono">
                  Synthesizing
                </span>
              </div>
              <p class="text-xs text-muted">
                Synthesizing Phase 0${currentPhase.number}: ${currentPhase.label} deliberations into the official executive memo.
              </p>
            </div>
          </div>
          <button id="close-synthesis-btn" class="p-1.5 text-muted hover:text-slate-100 rounded-lg hover:bg-white/5" aria-label="Close synthesis modal">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <!-- Live Streaming Preview Body -->
        <div class="flex-1 overflow-y-auto p-6 bg-base" id="synthesis-stream-body">
          <div class="flex items-center gap-2 text-xs text-brass-light font-mono mb-3" id="synthesis-streaming-indicator">
            <span class="w-2 h-2 rounded-full bg-brass-light animate-ping"></span>
            <span>The Chair is actively drafting the milestone document...</span>
          </div>
          <div id="synthesis-stream-content" class="markdown-body text-xs text-slate-200"></div>
        </div>

        <!-- Footer Actions -->
        <div class="p-4 border-t border-subtle bg-panel flex items-center justify-between shrink-0" id="synthesis-modal-footer">
          <button id="stop-synthesis-btn" class="btn btn-ghost text-xs text-danger hover:bg-danger/10 border border-danger/30">
            Cancel Synthesis
          </button>
          <div class="flex items-center gap-2">
            <button id="synthesis-copy-btn" class="btn btn-ghost text-xs py-1.5 px-3 border border-subtle hidden">
              Copy Markdown
            </button>
            <button id="synthesis-done-btn" class="btn btn-primary text-xs py-1.5 px-4 hidden">
              Done & View Memo →
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Wire inline rename logic
  wireHeaderRename(venture, topbarVenture);

  // Wire Notes tab save
  if (activeTab === 'notes') {
    wireNotesTab(venture);
  }

  // Wire Deliverables tab tools (Copy, Download, Print)
  if (activeTab === 'deliverables') {
    wireDeliverablesTab(venture, ventureDeliverables);
  }

  // Wire Boardroom Chamber & 1:1 Single-Agent Chat
  if (activeTab === 'boardroom') {
    wireBoardroomChamber({
      venture,
      currentPhase,
      phaseAgents,
      seatedAgents,
      activeMode,
      activeTargetAgentId,
      currentTargetAgent,
      activeSession
    });
  }

  // Wire Synthesis Modal Triggers
  wireSynthesisTriggers(venture, currentPhase, activeSession);
}

/**
 * Render Boardroom Chamber Tab (with Single-Agent Picker & Mode Switcher)
 */
function renderBoardroomTab({
  venture,
  currentPhase,
  safePhaseIdx,
  prevPhase,
  nextPhase,
  seatedAgents,
  phaseAgents,
  activeMode,
  activeTargetAgentId,
  currentTargetAgent,
  messages,
  rounds = [],
  phaseDeliverable
}) {
  const progressPercent = Math.round(((safePhaseIdx + 1) / 4) * 100);
  const starterInfo = AGENT_STARTERS[currentTargetAgent.id] || AGENT_STARTERS.maya;

  return `
    <div class="space-y-6">
      <!-- 1. Phase Banner -->
      <div class="panel p-5 border-subtle relative overflow-hidden space-y-4">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div class="flex items-center gap-2 mb-1">
              <span class="chip text-xs bg-brass/10 text-brass-light border-brass/30 font-mono font-semibold">
                PHASE 0${currentPhase.number}
              </span>
              <h2 class="font-serif text-2xl text-slate-100">${currentPhase.label}</h2>
            </div>
            <p class="text-xs text-muted max-w-xl leading-relaxed">
              ${currentPhase.objective}
            </p>
          </div>

          <!-- Prev / Next Navigation with Guard Text & Banner Synthesize -->
          <div class="flex flex-col items-end gap-2 shrink-0">
            <div class="flex items-center gap-2">
              <a 
                href="${prevPhase ? `#/venture/${venture.id}/boardroom?phase=${prevPhase.id}` : 'javascript:void(0)'}" 
                class="btn btn-ghost text-xs py-1.5 px-3 border border-subtle ${!prevPhase ? 'opacity-40 cursor-not-allowed' : 'hover:border-slate-400'}"
                ${!prevPhase ? 'aria-disabled="true"' : ''}
              >
                ← Prev Phase
              </a>
              <button id="banner-synthesize-btn" class="btn btn-primary text-xs py-1.5 px-3 shadow-md">
                Synthesize Memo
              </button>
              <a 
                href="${nextPhase ? `#/venture/${venture.id}/boardroom?phase=${nextPhase.id}` : 'javascript:void(0)'}" 
                class="btn btn-ghost text-xs py-1.5 px-3 border border-subtle ${!nextPhase ? 'opacity-40 cursor-not-allowed' : 'hover:border-slate-400'}"
                ${!nextPhase ? 'aria-disabled="true"' : ''}
              >
                Next Phase →
              </a>
            </div>
            <span class="text-[10px] text-faint font-mono">
              You can return to any phase at any time — nothing is locked.
            </span>
          </div>
        </div>

        <!-- Progress Bar: Phase X of 4 -->
        <div class="space-y-1.5 pt-1 border-t border-subtle">
          <div class="flex items-center justify-between text-[11px] font-mono">
            <span class="text-muted">Phase ${safePhaseIdx + 1} of 4: ${currentPhase.label}</span>
            <span class="text-brass-light font-semibold">${progressPercent}% Completed</span>
          </div>
          <div class="w-full h-1.5 bg-base rounded-full overflow-hidden border border-subtle">
            <div class="h-full bg-gradient-to-r from-brass to-brass-light transition-all duration-300" style="width: ${progressPercent}%"></div>
          </div>
        </div>
      </div>

      <!-- 2. Two-Column Layout (Left: Transcript + Composer, Right: Table + Deliverable) -->
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <!-- Left Column: Transcript Stream + Composer (8 Cols) -->
        <div class="lg:col-span-8 space-y-4">
          <!-- Transcript Container -->
          <div class="panel p-5 border-subtle flex flex-col min-h-[460px]">
            <div class="flex items-center justify-between pb-3 mb-4 border-b border-subtle flex-wrap gap-2">
              <div class="flex items-center gap-2">
                <span class="font-serif text-lg text-slate-100" id="transcript-header-title">
                  ${activeMode === 'single' ? `1:1 Consultation with ${currentTargetAgent.name}` : 'Full Board Deliberation Record'}
                </span>
                <span class="chip text-[10px] py-0 px-1.5 bg-base font-mono text-muted" id="message-count-badge">
                  ${messages.length} remarks
                </span>
              </div>
              <div class="flex items-center gap-2 text-[10px] font-mono">
                <span class="w-1.5 h-1.5 rounded-full ${activeMode === 'single' ? 'bg-brass' : 'bg-success'}"></span>
                <span class="text-slate-300" id="transcript-mode-badge">
                  ${activeMode === 'single' ? `Direct Thread: ${currentTargetAgent.shortRole}` : 'Chamber Quorum'}
                </span>
              </div>
            </div>

            <!-- Messages Stream Area -->
            <div id="transcript-feed" class="flex-1 space-y-4 overflow-y-auto max-h-[520px] pr-1">
              ${messages.length === 0 ? `
                <div class="h-full min-h-[320px] flex flex-col items-center justify-center p-8 text-center border border-dashed border-subtle rounded-xl bg-base/50" id="empty-state-box">
                  <span class="avatar w-12 h-12 text-sm agent-${activeMode === 'single' ? currentTargetAgent.color : 'brass'}-bg agent-${activeMode === 'single' ? currentTargetAgent.color : 'brass'} font-mono font-bold border-2 border-current shadow-md mb-3">
                    ${activeMode === 'single' ? currentTargetAgent.initials : 'CH'}
                  </span>
                  <h3 class="font-serif text-xl text-slate-200 mb-1.5">
                    ${activeMode === 'single' ? `Direct Inquiry with ${currentTargetAgent.name}` : 'The Floor is Open'}
                  </h3>
                  <p class="text-xs text-muted max-w-md leading-relaxed mb-4">
                    ${activeMode === 'single' ? starterInfo.copy : (EMPTY_STATES[currentPhase.id] || EMPTY_STATES['ideation'])}
                  </p>
                  <button type="button" class="btn btn-ghost border border-subtle text-xs text-brass-light hover:bg-brass/10 starter-pitch-btn">
                    "${activeMode === 'single' ? starterInfo.pitch : `Here is the raw thesis for ${escapeHtml(venture.name)}: what is our asymmetric wedge?`}"
                  </button>
                </div>
              ` : renderGroupedMessages(messages, currentPhase, activeMode, rounds)}
            </div>
          </div>

          <!-- Bottom Composer Panel -->
          <div class="panel p-4 border-subtle bg-panel space-y-3">
            <!-- Composer Header: Mode Selector & Shortcut Hint -->
            <div class="flex items-center justify-between text-xs flex-wrap gap-2">
              <div class="flex items-center gap-2">
                <span class="text-muted font-medium">Addressing:</span>
                <div class="inline-flex rounded-lg border border-subtle p-0.5 bg-base" role="tablist">
                  <button 
                    type="button" 
                    id="mode-tab-all" 
                    class="mode-toggle-btn px-2.5 py-1 rounded text-xs transition-colors ${activeMode === 'all' ? 'bg-brass text-base font-bold shadow-sm' : 'text-muted hover:text-slate-200'}"
                    data-mode="all"
                  >
                    Convene full board
                  </button>
                  <button 
                    type="button" 
                    id="mode-tab-single" 
                    class="mode-toggle-btn px-2.5 py-1 rounded text-xs transition-colors ${activeMode === 'single' ? 'bg-brass text-base font-bold shadow-sm' : 'text-muted hover:text-slate-200'}"
                    data-mode="single"
                  >
                    Ask one member ▾
                  </button>
                </div>
              </div>

              <span class="text-[11px] font-mono text-faint hidden sm:inline">
                Press ⌘+Enter or Ctrl+Enter to send
              </span>
            </div>

            <!-- Inline Agent Picker (Visible in Single-Agent mode) -->
            <div id="inline-agent-picker" class="${activeMode === 'single' ? 'flex' : 'hidden'} items-center gap-2 pt-2 border-t border-subtle/80 overflow-x-auto pb-1">
              <span class="text-[10px] font-mono text-muted uppercase tracking-wider shrink-0">Direct Target:</span>
              <div class="flex items-center gap-1.5 flex-wrap">
                ${phaseAgents.map(agent => {
                  const isSelected = activeTargetAgentId === agent.id;
                  const colorClass = `agent-${agent.color || 'cyan'}`;
                  const colorBgClass = `agent-${agent.color || 'cyan'}-bg`;

                  return `
                    <button 
                      type="button" 
                      class="agent-picker-chip btn btn-ghost text-xs py-1 px-2.5 rounded-lg border transition-all flex items-center gap-2 ${isSelected ? 'border-brass bg-brass/15 text-slate-100 font-semibold shadow-sm' : 'border-subtle bg-base text-muted hover:text-slate-200 hover:border-slate-500'}" 
                      data-picker-agent="${agent.id}"
                    >
                      <span class="avatar w-5 h-5 text-[9px] ${colorBgClass} ${colorClass} font-mono font-bold shrink-0">
                        ${agent.initials}
                      </span>
                      <span>${agent.name}</span>
                      <span class="chip text-[9px] py-0 px-1 font-mono uppercase bg-base/80 ${isSelected ? 'text-brass-light border-brass/40' : 'text-muted'}">
                        ${agent.shortRole}
                      </span>
                    </button>
                  `;
                }).join('')}
              </div>
            </div>

            <!-- "Who's in the room?" Pre-Session Sheet (Visible in Full Board mode) -->
            <div id="room-participants-sheet" class="${activeMode === 'all' ? 'block' : 'hidden'} p-3 rounded-lg bg-base/90 border border-subtle space-y-2">
              <div class="flex items-center justify-between text-xs font-mono">
                <div class="flex items-center gap-1.5 text-slate-300 font-semibold">
                  <svg class="w-3.5 h-3.5 text-brass" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                  </svg>
                  <span>Who's in the room?</span>
                  <span class="chip text-[10px] py-0 px-1.5 bg-panel border-subtle text-brass-light" id="active-participants-count">
                    ${phaseAgents.length} seated
                  </span>
                </div>
                <span class="text-[10px] text-faint hidden sm:inline">Toggle participation or reorder sequence</span>
              </div>
              <div id="room-participants-chips" class="flex items-center gap-1.5 flex-wrap">
                <!-- Dynamically rendered and interactive in wireBoardroomChamber -->
              </div>
            </div>

            <!-- In-Session Controls Bar (Visible while multi-agent session is active) -->
            <div id="session-controls-bar" class="hidden p-2.5 rounded-lg bg-base border border-brass/40 text-xs shadow-md animate-fadeIn space-y-2">
              <div class="flex items-center justify-between flex-wrap gap-2">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="w-2 h-2 rounded-full bg-brass animate-ping shrink-0"></span>
                  <span id="session-progress-text" class="text-brass-light font-mono text-[11px] font-semibold truncate">
                    Deliberation in session...
                  </span>
                </div>
                <div class="flex items-center gap-1.5 flex-wrap shrink-0">
                  <button id="session-pause-btn" type="button" class="btn btn-ghost text-xs py-1 px-2.5 border border-subtle text-slate-300 hover:text-white hover:border-slate-400">
                    Pause after current speaker
                  </button>
                  <button id="session-skip-chair-btn" type="button" class="btn btn-ghost text-xs py-1 px-2.5 border border-brass/40 text-brass-light hover:bg-brass/10">
                    Skip to Chair summary
                  </button>
                  <button id="session-stop-btn" type="button" class="btn bg-danger/20 hover:bg-danger/30 text-danger border border-danger/40 text-xs py-1 px-2.5 font-semibold">
                    Stop
                  </button>
                </div>
              </div>
              <div class="w-full h-1 bg-panel rounded-full overflow-hidden border border-subtle">
                <div id="session-progress-bar" class="h-full bg-gradient-to-r from-brass to-brass-light transition-all duration-300" style="width: 10%"></div>
              </div>
            </div>

            <!-- Awaiting Founder Reply Banner (Socratic dialogue hand-back) -->
            <div id="awaiting-founder-banner" class="hidden items-center gap-2 px-3 py-2 rounded-lg bg-brass/10 border border-brass/40 text-[11px] text-brass-light font-mono animate-fadeIn">
              <span class="w-2 h-2 rounded-full bg-brass animate-pulse shrink-0"></span>
              <span id="awaiting-founder-text">The board has questions for you — reply to continue the dialogue.</span>
            </div>

            <!-- Auto-growing Textarea -->
            <div class="relative">
              <textarea 
                id="composer-textarea" 
                rows="2" 
                class="input text-xs leading-relaxed py-2.5 px-3 resize-none max-h-48 overflow-y-auto" 
                placeholder="${activeMode === 'single' ? `Ask ${currentTargetAgent.name} (${currentTargetAgent.shortRole}) a direct question or challenge...` : 'Pitch an assumption, challenge a director, or clarify market data...'}"
              ></textarea>
            </div>

            <!-- Composer Actions Bar -->
            <div class="flex items-center justify-between pt-1" id="composer-actions-bar">
              <span class="text-[10px] text-faint font-mono" id="composer-footer-hint">
                ${activeMode === 'single' ? `1:1 Consultation with ${currentTargetAgent.name} · Real-time streaming` : 'Multi-agent sequential deliberation · Quorum active'}
              </span>
              <div class="flex items-center gap-2">
                <button id="composer-send-btn" class="btn btn-primary text-xs py-1.5 px-4">
                  <span>${activeMode === 'single' ? `Send to ${currentTargetAgent.name}` : 'Send to Board'}</span>
                  <svg class="w-3.5 h-3.5 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Right Column: "At the table" + Phase Deliverable (4 Cols) -->
        <div class="lg:col-span-4 space-y-4">
          <!-- "At the table" Cards -->
          <div class="panel p-5 border-subtle space-y-3">
            <div class="flex items-center justify-between pb-2 border-b border-subtle">
              <h3 class="text-xs font-semibold uppercase tracking-wider text-muted font-mono">
                At the Table (${seatedAgents.length})
              </h3>
              <span class="chip text-[10px] py-0 px-1.5 bg-base border-subtle font-mono text-brass-light">
                Quorum Active
              </span>
            </div>

            <div class="space-y-2" id="at-the-table-list">
              ${seatedAgents.map(agent => {
                const colorClass = `agent-${agent.color || 'cyan'}`;
                const colorBgClass = `agent-${agent.color || 'cyan'}-bg`;
                const isTargeted = activeMode === 'single' && activeTargetAgentId === agent.id;

                return `
                  <div 
                    class="director-table-card p-2.5 rounded-lg bg-base border ${isTargeted ? 'border-brass bg-brass/10 ring-1 ring-brass' : 'border-subtle'} flex items-center justify-between gap-2.5 transition-all cursor-pointer hover:border-slate-400" 
                    data-agent-id="${agent.id}"
                    title="Click to direct inquiry to ${agent.name}"
                  >
                    <div class="flex items-center gap-2.5 min-w-0">
                      <span class="avatar w-8 h-8 text-xs ${colorBgClass} ${colorClass} border-base font-mono font-bold shrink-0">
                        ${agent.initials || agent.id.toUpperCase().slice(0, 2)}
                      </span>
                      <div class="min-w-0">
                        <div class="font-semibold text-xs text-slate-200 truncate flex items-center gap-1.5">
                          <span>${agent.name}</span>
                          ${isTargeted ? '<span class="chip text-[8px] py-0 px-1 bg-brass text-base font-bold">1:1 Target</span>' : ''}
                        </div>
                        <div class="text-[11px] text-muted truncate">${agent.shortRole}</div>
                      </div>
                    </div>

                    <!-- Speaking Pulse State Indicator -->
                    <div class="director-pulse-container flex items-center gap-1.5 shrink-0" data-pulse-agent="${agent.id}" title="Status: Idle">
                      <span class="pulse-indicator-dot w-2 h-2 rounded-full bg-slate-600 transition-colors"></span>
                      <span class="pulse-indicator-text text-[9px] font-mono text-faint uppercase">Idle</span>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>

          <!-- Phase Deliverable Card -->
          <div class="panel p-5 border-subtle space-y-3" id="phase-deliverable-card-container">
            <div class="flex items-center justify-between pb-2 border-b border-subtle">
              <h3 class="text-xs font-semibold uppercase tracking-wider text-muted font-mono">
                Phase Deliverable
              </h3>
              <span class="chip text-[10px] py-0 px-1.5 bg-base border-subtle font-mono">
                Phase 0${currentPhase.number}
              </span>
            </div>

            <div class="p-3.5 rounded-lg bg-base border border-subtle space-y-2.5">
              <div class="text-xs font-medium text-slate-200 flex items-center gap-1.5">
                <svg class="w-4 h-4 text-brass" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span>${currentPhase.deliverableType}</span>
              </div>

              ${phaseDeliverable ? `
                <div class="pt-1 text-[11px] space-y-2">
                  <span class="chip text-[10px] bg-success/10 text-success border-success/30 font-mono block w-fit">
                    ✓ Synthesized & Ratified
                  </span>
                  <p class="text-muted text-[11px] line-clamp-2">
                    ${escapeHtml(phaseDeliverable.title || 'Official Board Memo')}
                  </p>
                  <div class="pt-1 flex flex-col gap-1.5">
                    <a href="#/venture/${venture.id}/deliverables" class="text-brass-light hover:underline font-medium text-xs flex items-center gap-1">
                      View Deliverable Memo →
                    </a>
                    <button class="btn btn-ghost text-[11px] py-1 px-2 border border-subtle text-muted hover:text-slate-200 card-synthesize-btn">
                      Re-synthesize Memo
                    </button>
                  </div>
                </div>
              ` : `
                <div class="pt-1 text-[11px] space-y-2 text-muted">
                  <span class="chip text-[10px] bg-panel text-faint border-subtle font-mono block w-fit">
                    Not yet synthesized
                  </span>
                  <p class="leading-relaxed">
                    Deliberate on your core assumptions. When the session concludes, request The Chair to synthesize your official deliverable memo.
                  </p>
                  <button class="btn btn-primary text-xs py-1.5 px-3 w-full mt-1 card-synthesize-btn">
                    Synthesize Memo Now
                  </button>
                </div>
              `}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render grouped messages with visually distinct Session Header Bars in full-board mode
 */
function renderGroupedMessages(messages, currentPhase, activeMode, rounds = []) {
  let html = '';
  let currentRenderedRound = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (activeMode === 'all' && msg.roundId && msg.roundId !== currentRenderedRound) {
      currentRenderedRound = msg.roundId;
      const roundMeta = (rounds || []).find(r => r.id === msg.roundId);
      const roundMsgs = messages.filter(m => m.roundId === msg.roundId);
      const distinctSpeakers = roundMeta?.participantCount ||
        new Set(roundMsgs.filter(m => m.role !== 'user' && m.agentId !== 'chair').map(m => m.agentId || m.author)).size;
      const firstUserMsg = roundMsgs.find(m => m.role === 'user');
      const roundTitle = roundMeta?.title || deriveSessionTitle(firstUserMsg?.text || 'Board Session');
      const timeAgo = formatRelativeTime(roundMeta?.startedAt || msg.timestamp);

      html += `
        <div class="session-header-bar flex items-center justify-between py-2 px-3.5 rounded-lg bg-panel border border-subtle text-xs my-3 shadow-sm gap-2 flex-wrap">
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-2 h-2 rounded-full bg-brass shrink-0"></span>
            <span class="font-serif text-slate-100 font-medium truncate">Board session: ${escapeHtml(roundTitle)}</span>
            <span class="chip text-[9px] py-0 px-1.5 bg-base border-subtle font-mono text-muted shrink-0">
              ${distinctSpeakers || 1} members
            </span>
          </div>
          <span class="text-[10px] font-mono text-faint shrink-0">${timeAgo}</span>
        </div>
      `;
    }

    html += renderMessageBubble(msg, currentPhase);
  }

  return html;
}

/**
 * Render Message Bubble with Avatar in agent color, name + shortRole, relative timestamp, and actions row
 */
function renderMessageBubble(msg, currentPhase) {
  const isFounder = msg.role === 'user' || msg.author === 'Founder' || msg.isFounder;
  const isRoundSummary = msg.isRoundSummary || (msg.agentId === 'chair' && msg.text && msg.text.includes('Round Summary'));
  const isError = msg.isError;
  const agentDef = getAgent(msg.agentId || msg.role || '') || (msg.author === 'The Chair' ? THE_CHAIR : null);

  const colorClass = agentDef ? `agent-${agentDef.color}` : (isFounder ? 'text-brass-light' : 'text-slate-300');
  const bgClass = agentDef ? `agent-${agentDef.color}-bg` : (isFounder ? 'bg-brass/10' : 'bg-base');
  const renderedContent = renderMarkdown(msg.text || msg.content || '');

  // 1. Executive Round Summary Bubble
  if (isRoundSummary) {
    return `
      <div id="${msg.id}" class="message-bubble p-5 rounded-xl border border-brass/60 bg-gradient-to-b from-brass/10 via-[#0A0E14] to-base shadow-xl space-y-3 my-4 transition-all" data-msg-id="${msg.id}" data-agent-id="chair" data-round-id="${msg.roundId || ''}">
        <!-- Chair Header -->
        <div class="flex items-center justify-between text-xs pb-2 border-b border-brass/30">
          <div class="flex items-center gap-2.5">
            <span class="avatar w-7 h-7 text-[11px] agent-brass-bg agent-brass font-mono font-bold border border-brass/50 shadow-sm shrink-0">
              CH
            </span>
            <div>
              <div class="flex items-center gap-2">
                <span class="font-serif text-sm font-semibold text-slate-100">The Chair</span>
                <span class="chip text-[9px] py-0 px-2 uppercase font-mono bg-brass/20 text-brass-light border-brass/40 font-bold">
                  Executive Round Summary
                </span>
              </div>
              <div class="text-[10px] text-muted font-mono">Consensus, Disagreements & Strategic Next Action</div>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <span class="text-[10px] text-faint font-mono" title="${msg.timestamp ? new Date(msg.timestamp).toLocaleString() : ''}">
              ${formatRelativeTime(msg.timestamp)}
            </span>
          </div>
        </div>

        <!-- Markdown Content -->
        <div class="markdown-body message-body text-xs text-slate-200 pl-1 leading-relaxed">
          ${renderedContent}
        </div>

        <!-- Round Summary Actions -->
        <div class="pt-2 border-t border-brass/20 flex items-center justify-between text-xs flex-wrap gap-2">
          <button type="button" class="btn btn-primary text-xs py-1.5 px-3.5 round-two-btn font-semibold flex items-center gap-1.5 shadow-md" data-round-id="${escapeHtml(msg.roundId || '')}">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
            </svg>
            <span>Round 2 → Continue Roundtable</span>
          </button>

          <div class="flex items-center gap-2">
            <button type="button" class="msg-action-copy-btn btn btn-ghost text-[10px] py-1 px-2.5 border border-subtle/80 hover:text-slate-100" data-msg-id="${msg.id}" title="Copy summary">
              <svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
              </svg>
              <span>Copy Summary</span>
            </button>
            <span class="text-[9px] font-mono text-faint">Deliberation Protocol Complete</span>
          </div>
        </div>
      </div>
    `;
  }

  // 2. Errored Director Bubble
  if (isError) {
    return `
      <div id="${msg.id}" class="message-bubble p-4 rounded-xl border border-danger/40 bg-danger/10 space-y-2.5 my-2 animate-fadeIn" data-msg-id="${msg.id}" data-agent-id="${msg.agentId || ''}">
        <div class="flex items-center justify-between text-xs pb-1.5 border-b border-danger/20">
          <div class="flex items-center gap-2">
            <span class="avatar w-6 h-6 text-[10px] bg-danger/20 text-danger font-mono font-bold border-base shrink-0">
              ${agentDef ? agentDef.initials : 'DIR'}
            </span>
            <span class="font-semibold text-danger">${escapeHtml(msg.author || 'Director')}</span>
            <span class="chip text-[9px] py-0 px-1.5 uppercase font-mono text-danger border-danger/30">Consultation Error</span>
          </div>
          <span class="text-[10px] text-faint font-mono">${formatRelativeTime(msg.timestamp)}</span>
        </div>

        <div class="text-xs text-slate-300 font-mono pl-8 leading-relaxed">
          ${escapeHtml(msg.errorMessage || 'This director encountered a temporary execution error. Other directors continued without interruption.')}
        </div>

        <div class="pl-8 pt-1 flex items-center gap-3">
          <button type="button" class="btn btn-primary text-xs py-1 px-3 msg-retry-speaker-btn" data-msg-id="${msg.id}">
            <svg class="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span>↻ Retry Director</span>
          </button>
          <span class="text-[10px] text-muted font-mono">Retrying will seamlessly stream this director's contribution.</span>
        </div>
      </div>
    `;
  }

  // 3. Standard Message Bubble (Founder or Director)
  return `
    <div id="${msg.id}" class="message-bubble p-4 rounded-xl border ${isFounder ? 'border-brass/40 bg-brass/5 ml-4 sm:ml-8' : 'border-subtle bg-base mr-2 sm:mr-6'} space-y-2.5 transition-all" data-msg-id="${msg.id}" data-agent-id="${msg.agentId || ''}">
      <!-- Message Header -->
      <div class="flex items-center justify-between text-xs pb-1.5 border-b border-subtle/60">
        <div class="flex items-center gap-2">
          <span class="avatar w-6 h-6 text-[10px] ${bgClass} ${colorClass} font-mono font-bold border-base shrink-0">
            ${agentDef ? agentDef.initials : (isFounder ? 'FO' : 'DIR')}
          </span>
          <span class="font-semibold text-slate-100">${escapeHtml(msg.author || (isFounder ? 'Founder' : 'Director'))}</span>
          ${agentDef ? `<span class="chip text-[9px] py-0 px-1.5 uppercase font-mono text-muted">${agentDef.shortRole}</span>` : ''}
        </div>
        
        <div class="flex items-center gap-2">
          ${msg.meta?.model ? `
            <span class="chip text-[9px] py-0 px-1.5 font-mono text-faint bg-[#080B0F] border-subtle hidden sm:inline-block">
              ${escapeHtml(msg.meta.model)}
            </span>
          ` : ''}
          <span class="text-[10px] text-faint font-mono" title="${msg.timestamp ? new Date(msg.timestamp).toLocaleString() : ''}">
            ${formatRelativeTime(msg.timestamp)}
          </span>
        </div>
      </div>

      <!-- Message Markdown Body -->
      <div class="markdown-body message-body pl-8 text-xs text-slate-200">
        ${renderedContent}
      </div>

      <!-- Threaded David Challenge Box (if message was challenged) -->
      ${msg.challenge ? `
        <div class="challenge-thread-container mt-3 pl-8">
          <div class="p-3.5 rounded-lg bg-[#06090E] border border-amber-500/30 space-y-2.5 text-xs animate-fadeIn">
            <div class="flex items-center justify-between border-b border-subtle/50 pb-1.5">
              <div class="flex items-center gap-2">
                <span class="avatar w-5 h-5 text-[9px] agent-amber-bg agent-amber font-mono font-bold border border-amber-500/40">
                  DO
                </span>
                <span class="font-semibold text-amber-200">David Okafor</span>
                <span class="chip text-[9px] py-0 px-1.5 uppercase font-mono bg-amber-500/10 text-amber-400 border-amber-500/30 font-semibold">
                  ⚡ Validation Interrogation
                </span>
              </div>
              <span class="text-[10px] font-mono text-faint">${formatRelativeTime(msg.challenge.timestamp)}</span>
            </div>

            <div class="text-[11px] text-muted italic border-l-2 border-amber-500/40 pl-2 leading-relaxed">
              "${escapeHtml(msg.challenge.claimText || '')}"
            </div>

            <div class="markdown-body text-xs text-slate-200 challenge-content">
              ${renderMarkdown(msg.challenge.text || '')}
            </div>
          </div>
        </div>
      ` : ''}

      <!-- Actions Row for Agent Messages -->
      ${!isFounder ? `
        <div class="actions-row pt-2 pl-8 border-t border-subtle/50 flex items-center justify-between text-[11px] text-muted flex-wrap gap-2">
          <div class="flex items-center gap-1.5 flex-wrap">
            <!-- Challenge button (Validation Partner Interrogation) -->
            <button type="button" class="msg-action-challenge-btn btn btn-ghost text-[10px] py-1 px-2 border border-brass/40 text-brass-light hover:bg-brass/10 hover:border-brass font-medium" data-msg-id="${msg.id}" data-author="${escapeHtml(msg.author || '')}" title="David Okafor interrogates this assertion as a testable hypothesis with a kill criterion">
              <span class="mr-1">⚡</span>
              <span>Challenge</span>
            </button>

            <!-- Copy -->
            <button type="button" class="msg-action-copy-btn btn btn-ghost text-[10px] py-1 px-2 border border-subtle/60 hover:text-slate-100" data-msg-id="${msg.id}" title="Copy response to clipboard">
              <svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
              </svg>
              <span>Copy</span>
            </button>

            <!-- Regenerate -->
            <button type="button" class="msg-action-regen-btn btn btn-ghost text-[10px] py-1 px-2 border border-subtle/60 hover:text-brass-light" data-msg-id="${msg.id}" data-agent-id="${msg.agentId || ''}" title="Regenerate this response">
              <svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span>Regenerate</span>
            </button>

            <!-- Ask another member about this -->
            <button type="button" class="msg-action-cross-ask-btn btn btn-ghost text-[10px] py-1 px-2 border border-subtle/60 hover:text-slate-100" data-msg-id="${msg.id}" title="Quote this remark to another director">
              <svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <span>Ask another member</span>
            </button>

            <!-- Promote to deliverable note -->
            <button type="button" class="msg-action-promote-btn btn btn-ghost text-[10px] py-1 px-2 border border-subtle/60 hover:text-brass-light" data-msg-id="${msg.id}" title="Save as deliverable insight note">
              <svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span>Promote to note</span>
            </button>
          </div>

          ${msg.meta?.provider ? `
            <span class="text-[9px] font-mono text-faint">
              via ${escapeHtml(msg.meta.provider)}
            </span>
          ` : ''}
        </div>
      ` : ''}
    </div>
  `;
}

/**
 * Wire Boardroom Chamber & Single-Agent 1:1 Chat Interactions
 */
function wireBoardroomChamber({
  venture,
  currentPhase,
  phaseAgents,
  seatedAgents,
  activeMode: initialMode,
  activeTargetAgentId: initialTargetAgentId,
  currentTargetAgent: initialTargetAgent,
  activeSession: initialSession
}) {
  let activeMode = initialMode;
  let targetAgentId = initialTargetAgentId;
  let targetAgent = initialTargetAgent;
  let activeSession = initialSession;
  let activeAbortController = null;
  let isGenerating = false;
  let lastUserText = '';

  // Customizable room participants & in-session roundtable control flags
  let roomParticipants = phaseAgents.map(a => ({ ...a, enabled: true }));
  const sessionControl = {
    pauseAfterCurrent: false,
    isStopped: false,
    skipToChair: false
  };

  const textarea = document.getElementById('composer-textarea');
  const sendBtn = document.getElementById('composer-send-btn');
  const transcriptFeed = document.getElementById('transcript-feed');
  const messageCountBadge = document.getElementById('message-count-badge');
  const actionsBar = document.getElementById('composer-actions-bar');
  const modeTabAll = document.getElementById('mode-tab-all');
  const modeTabSingle = document.getElementById('mode-tab-single');
  const inlineAgentPicker = document.getElementById('inline-agent-picker');
  const roomParticipantsSheet = document.getElementById('room-participants-sheet');
  const roomParticipantsChips = document.getElementById('room-participants-chips');
  const activeParticipantsCount = document.getElementById('active-participants-count');
  const sessionControlsBar = document.getElementById('session-controls-bar');
  const sessionProgressText = document.getElementById('session-progress-text');
  const sessionProgressBar = document.getElementById('session-progress-bar');
  const sessionPauseBtn = document.getElementById('session-pause-btn');
  const sessionSkipChairBtn = document.getElementById('session-skip-chair-btn');
  const sessionStopBtn = document.getElementById('session-stop-btn');
  const transcriptHeaderTitle = document.getElementById('transcript-header-title');
  const transcriptModeBadge = document.getElementById('transcript-mode-badge');
  const composerFooterHint = document.getElementById('composer-footer-hint');

  // Render "Who's in the room?" pre-session sheet
  function renderRoomParticipantsSheet() {
    if (!roomParticipantsChips) return;

    const enabledCount = roomParticipants.filter(p => p.enabled !== false).length;
    if (activeParticipantsCount) {
      activeParticipantsCount.textContent = `${enabledCount} seated`;
    }

    roomParticipantsChips.innerHTML = roomParticipants.map((agent, idx) => {
      const isEnabled = agent.enabled !== false;
      const colorClass = `agent-${agent.color || 'cyan'}`;
      const colorBgClass = `agent-${agent.color || 'cyan'}-bg`;

      return `
        <div class="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-xs transition-all ${isEnabled ? 'border-subtle bg-panel text-slate-200' : 'border-subtle/50 bg-base/40 text-muted opacity-60'}">
          <label class="inline-flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              class="participant-toggle-cb rounded border-subtle text-brass focus:ring-brass bg-base cursor-pointer"
              data-agent-id="${agent.id}"
              ${isEnabled ? 'checked' : ''}
              ${isGenerating ? 'disabled' : ''}
              title="Toggle ${agent.name}"
            />
            <span class="text-[10px] font-mono text-faint">${idx + 1}.</span>
            <span class="avatar w-4 h-4 text-[8px] ${colorBgClass} ${colorClass} font-mono font-bold shrink-0">
              ${agent.initials}
            </span>
            <span class="font-medium ${!isEnabled ? 'line-through' : ''}">${agent.name}</span>
          </label>
          <div class="inline-flex items-center border-l border-subtle/60 pl-1 ml-0.5 gap-0.5">
            <button
              type="button"
              class="move-participant-up-btn px-1 text-[10px] text-muted hover:text-slate-100 rounded hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
              data-index="${idx}"
              ${idx === 0 || isGenerating ? 'disabled' : ''}
              title="Move earlier in speaking order"
              aria-label="Move ${agent.name} earlier"
            >←</button>
            <button
              type="button"
              class="move-participant-down-btn px-1 text-[10px] text-muted hover:text-slate-100 rounded hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
              data-index="${idx}"
              ${idx === roomParticipants.length - 1 || isGenerating ? 'disabled' : ''}
              title="Move later in speaking order"
              aria-label="Move ${agent.name} later"
            >→</button>
          </div>
        </div>
      `;
    }).join('');

    // Wire toggle checkboxes
    roomParticipantsChips.querySelectorAll('.participant-toggle-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const agentId = cb.getAttribute('data-agent-id');
        const target = roomParticipants.find(p => p.id === agentId);
        if (target) {
          target.enabled = cb.checked;
          renderRoomParticipantsSheet();
        }
      });
    });

    // Wire reorder earlier
    roomParticipantsChips.querySelectorAll('.move-participant-up-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-index'), 10);
        if (idx > 0) {
          const temp = roomParticipants[idx];
          roomParticipants[idx] = roomParticipants[idx - 1];
          roomParticipants[idx - 1] = temp;
          renderRoomParticipantsSheet();
        }
      });
    });

    // Wire reorder later
    roomParticipantsChips.querySelectorAll('.move-participant-down-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-index'), 10);
        if (idx < roomParticipants.length - 1) {
          const temp = roomParticipants[idx];
          roomParticipants[idx] = roomParticipants[idx + 1];
          roomParticipants[idx + 1] = temp;
          renderRoomParticipantsSheet();
        }
      });
    });

    // Disable Send to Board if 0 participants are checked
    const activeSendBtn = document.getElementById('composer-send-btn');
    if (activeSendBtn && activeMode === 'all' && !isGenerating) {
      activeSendBtn.disabled = enabledCount === 0;
      if (enabledCount === 0) {
        activeSendBtn.classList.add('opacity-50', 'cursor-not-allowed');
      } else {
        activeSendBtn.classList.remove('opacity-50', 'cursor-not-allowed');
      }
    }
  }

  renderRoomParticipantsSheet();

  // Wire in-session roundtable controls
  sessionPauseBtn?.addEventListener('click', () => {
    sessionControl.pauseAfterCurrent = !sessionControl.pauseAfterCurrent;
    if (sessionControl.pauseAfterCurrent) {
      sessionPauseBtn.textContent = 'Resume Session';
      sessionPauseBtn.className = 'btn text-xs py-1 px-2.5 bg-brass text-base font-bold shadow-sm';
      if (sessionProgressText) {
        sessionProgressText.textContent = 'Pausing after current speaker finishes...';
      }
    } else {
      sessionPauseBtn.textContent = 'Pause after current speaker';
      sessionPauseBtn.className = 'btn btn-ghost text-xs py-1 px-2.5 border border-subtle text-slate-300 hover:text-white hover:border-slate-400';
      if (sessionProgressText) {
        sessionProgressText.textContent = 'Resuming roundtable...';
      }
    }
  });

  sessionSkipChairBtn?.addEventListener('click', () => {
    sessionControl.skipToChair = true;
    sessionControl.pauseAfterCurrent = false;
    if (sessionProgressText) {
      sessionProgressText.textContent = 'Advancing directly to The Chair Round Summary...';
    }
  });

  sessionStopBtn?.addEventListener('click', () => {
    sessionControl.isStopped = true;
    sessionControl.pauseAfterCurrent = false;
    if (activeAbortController) {
      activeAbortController.abort();
    }
  });

  // Auto-grow textarea
  textarea?.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px';
  });

  // Keyboard shortcut: Cmd/Ctrl+Enter
  textarea?.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!isGenerating) {
        triggerSend();
      }
    }
  });

  sendBtn?.addEventListener('click', () => {
    if (!isGenerating) {
      triggerSend();
    }
  });

  // Switch between "Convene full board" and "Ask one member"
  modeTabAll?.addEventListener('click', async () => {
    if (activeMode === 'all' || isGenerating) return;
    activeMode = 'all';
    updateModeUI();
    await switchThread('all');
  });

  modeTabSingle?.addEventListener('click', async () => {
    if (activeMode === 'single' || isGenerating) return;
    activeMode = 'single';
    updateModeUI();
    await switchThread(targetAgentId);
  });

  // Inline Agent Picker chip clicks
  const pickerChips = document.querySelectorAll('.agent-picker-chip');
  pickerChips.forEach(chip => {
    chip.addEventListener('click', async () => {
      if (isGenerating) return;
      const agentId = chip.getAttribute('data-picker-agent');
      if (agentId && agentId !== targetAgentId) {
        targetAgentId = agentId;
        targetAgent = getAgent(agentId) || phaseAgents[0];
        updateAgentPickerUI();
        await switchThread(targetAgentId);
      }
    });
  });

  // "At the table" director card clicks (switch to that director directly)
  const directorCards = document.querySelectorAll('.director-table-card');
  directorCards.forEach(card => {
    card.addEventListener('click', async () => {
      if (isGenerating) return;
      const agentId = card.getAttribute('data-agent-id');
      if (agentId && agentId !== 'chair') {
        activeMode = 'single';
        targetAgentId = agentId;
        targetAgent = getAgent(agentId) || phaseAgents[0];
        updateModeUI();
        updateAgentPickerUI();
        await switchThread(targetAgentId);
      }
    });
  });

  // Wire message action buttons
  wireTranscriptActions();

  // Wire starter pitch button in empty state
  wireStarterBtn();

  // Update Mode UI Elements
  function updateModeUI() {
    if (activeMode === 'all') {
      modeTabAll?.classList.add('bg-brass', 'text-base', 'font-bold', 'shadow-sm');
      modeTabAll?.classList.remove('text-muted');
      modeTabSingle?.classList.remove('bg-brass', 'text-base', 'font-bold', 'shadow-sm');
      modeTabSingle?.classList.add('text-muted');

      inlineAgentPicker?.classList.add('hidden');
      inlineAgentPicker?.classList.remove('flex');
      roomParticipantsSheet?.classList.remove('hidden');

      if (transcriptHeaderTitle) transcriptHeaderTitle.textContent = 'Full Board Deliberation Record';
      if (transcriptModeBadge) transcriptModeBadge.textContent = 'Chamber Quorum';
      if (composerFooterHint) composerFooterHint.textContent = 'Multi-agent sequential deliberation · Quorum active';
      const activeSend = document.getElementById('composer-send-btn');
      if (activeSend?.querySelector('span')) activeSend.querySelector('span').textContent = 'Send to Board';
      if (textarea) textarea.placeholder = 'Pitch an assumption, challenge a director, or clarify market data...';
      renderRoomParticipantsSheet();
    } else {
      modeTabSingle?.classList.add('bg-brass', 'text-base', 'font-bold', 'shadow-sm');
      modeTabSingle?.classList.remove('text-muted');
      modeTabAll?.classList.remove('bg-brass', 'text-base', 'font-bold', 'shadow-sm');
      modeTabAll?.classList.add('text-muted');

      inlineAgentPicker?.classList.remove('hidden');
      inlineAgentPicker?.classList.add('flex');
      roomParticipantsSheet?.classList.add('hidden');

      if (transcriptHeaderTitle) transcriptHeaderTitle.textContent = `1:1 Consultation with ${targetAgent.name}`;
      if (transcriptModeBadge) transcriptModeBadge.textContent = `Direct Thread: ${targetAgent.shortRole}`;
      if (composerFooterHint) composerFooterHint.textContent = `1:1 Consultation with ${targetAgent.name} · Real-time streaming`;
      const activeSend = document.getElementById('composer-send-btn');
      if (activeSend) {
        activeSend.disabled = false;
        activeSend.classList.remove('opacity-50', 'cursor-not-allowed');
        if (activeSend.querySelector('span')) activeSend.querySelector('span').textContent = `Send to ${targetAgent.name}`;
      }
      if (textarea) textarea.placeholder = `Ask ${targetAgent.name} (${targetAgent.shortRole}) a direct question or challenge...`;
    }

    // Reflect in URL without full reload
    const url = new URL(window.location.href);
    if (activeMode === 'single') {
      url.hash = `#/venture/${venture.id}/boardroom?phase=${currentPhase.id}&mode=single&agent=${targetAgentId}`;
    } else {
      url.hash = `#/venture/${venture.id}/boardroom?phase=${currentPhase.id}`;
    }
    history.replaceState(null, '', url.href);
  }

  // Update Agent Picker visual selection
  function updateAgentPickerUI() {
    pickerChips.forEach(chip => {
      const chipAgentId = chip.getAttribute('data-picker-agent');
      if (chipAgentId === targetAgentId) {
        chip.className = 'agent-picker-chip btn btn-ghost text-xs py-1 px-2.5 rounded-lg border transition-all flex items-center gap-2 border-brass bg-brass/15 text-slate-100 font-semibold shadow-sm';
      } else {
        chip.className = 'agent-picker-chip btn btn-ghost text-xs py-1 px-2.5 rounded-lg border transition-all flex items-center gap-2 border-subtle bg-base text-muted hover:text-slate-200 hover:border-slate-500';
      }
    });

    directorCards.forEach(card => {
      const cardAgentId = card.getAttribute('data-agent-id');
      if (activeMode === 'single' && cardAgentId === targetAgentId) {
        card.classList.add('border-brass', 'bg-brass/10', 'ring-1', 'ring-brass');
        card.classList.remove('border-subtle');
      } else {
        card.classList.remove('border-brass', 'bg-brass/10', 'ring-1', 'ring-brass');
        card.classList.add('border-subtle');
      }
    });

    if (transcriptHeaderTitle) transcriptHeaderTitle.textContent = `1:1 Consultation with ${targetAgent.name}`;
    if (transcriptModeBadge) transcriptModeBadge.textContent = `Direct Thread: ${targetAgent.shortRole}`;
    if (composerFooterHint) composerFooterHint.textContent = `1:1 Consultation with ${targetAgent.name} · Real-time streaming`;
    const activeSend = document.getElementById('composer-send-btn');
    if (activeSend?.querySelector('span')) activeSend.querySelector('span').textContent = `Send to ${targetAgent.name}`;
    if (textarea) textarea.placeholder = `Ask ${targetAgent.name} (${targetAgent.shortRole}) a direct question or challenge...`;
  }

  // Switch Thread Session
  async function switchThread(agentScope) {
    activeSession = await getThreadSession(venture.id, currentPhase.id, agentScope);
    renderFeed();
    markAwaitingFounder();
  }

  // Render Transcript Feed
  function renderFeed() {
    if (!transcriptFeed) return;
    const msgs = activeSession.messages || [];

    if (msgs.length === 0) {
      const starterInfo = AGENT_STARTERS[targetAgent.id] || AGENT_STARTERS.maya;
      transcriptFeed.innerHTML = `
        <div class="h-full min-h-[320px] flex flex-col items-center justify-center p-8 text-center border border-dashed border-subtle rounded-xl bg-base/50" id="empty-state-box">
          <span class="avatar w-12 h-12 text-sm agent-${activeMode === 'single' ? targetAgent.color : 'brass'}-bg agent-${activeMode === 'single' ? targetAgent.color : 'brass'} font-mono font-bold border-2 border-current shadow-md mb-3">
            ${activeMode === 'single' ? targetAgent.initials : 'CH'}
          </span>
          <h3 class="font-serif text-xl text-slate-200 mb-1.5">
            ${activeMode === 'single' ? `Direct Inquiry with ${targetAgent.name}` : 'The Floor is Open'}
          </h3>
          <p class="text-xs text-muted max-w-md leading-relaxed mb-4">
            ${activeMode === 'single' ? starterInfo.copy : (EMPTY_STATES[currentPhase.id] || EMPTY_STATES['ideation'])}
          </p>
          <button type="button" class="btn btn-ghost border border-subtle text-xs text-brass-light hover:bg-brass/10 starter-pitch-btn">
            "${activeMode === 'single' ? starterInfo.pitch : `Here is the raw thesis for ${escapeHtml(venture.name)}: what is our asymmetric wedge?`}"
          </button>
        </div>
      `;
      wireStarterBtn();
    } else {
      transcriptFeed.innerHTML = renderGroupedMessages(msgs, currentPhase, activeMode, activeSession.rounds || []);
      wireTranscriptActions();
    }

    transcriptFeed.scrollTop = transcriptFeed.scrollHeight;

    if (messageCountBadge) {
      messageCountBadge.textContent = `${msgs.length} remarks`;
    }
  }

  function wireStarterBtn() {
    const starterBtn = document.querySelector('.starter-pitch-btn');
    if (starterBtn && textarea) {
      starterBtn.addEventListener('click', () => {
        const text = starterBtn.textContent.replace(/^"|"$/g, '').trim();
        textarea.value = text;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px';
        textarea.focus();
      });
    }
  }

  function showSessionControls() {
    if (sessionControlsBar) {
      sessionControlsBar.classList.remove('hidden');
      if (sessionPauseBtn) {
        sessionPauseBtn.textContent = 'Pause after current speaker';
        sessionPauseBtn.className = 'btn btn-ghost text-xs py-1 px-2.5 border border-subtle text-slate-300 hover:text-white hover:border-slate-400';
      }
      if (sessionProgressText) {
        sessionProgressText.textContent = 'Convening roundtable...';
      }
      if (sessionProgressBar) {
        sessionProgressBar.style.width = '8%';
      }
    }
    if (actionsBar) {
      actionsBar.classList.add('hidden');
    }
    renderRoomParticipantsSheet();
  }

  function hideSessionControls() {
    if (sessionControlsBar) {
      sessionControlsBar.classList.add('hidden');
    }
    if (actionsBar) {
      actionsBar.classList.remove('hidden');
    }
  }

  // Set up Stop button logic (1:1 mode or individual actions)
  function showStopButton(customLabel = null) {
    if (!actionsBar) return;
    actionsBar.classList.remove('hidden');
    actionsBar.innerHTML = `
      <div class="flex items-center gap-2 text-xs text-brass-light font-mono">
        <span class="w-2 h-2 rounded-full bg-brass animate-ping"></span>
        <span>${customLabel || (activeMode === 'single' ? `${targetAgent.name} is streaming...` : 'Deliberation in session...')}</span>
      </div>
      <button id="composer-stop-btn" class="btn bg-danger/20 hover:bg-danger/30 text-danger border border-danger/40 text-xs py-1.5 px-4 font-semibold">
        <svg class="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <rect x="6" y="6" width="12" height="12" stroke-width="2" rx="1" />
        </svg>
        Stop Generation
      </button>
    `;

    document.getElementById('composer-stop-btn')?.addEventListener('click', () => {
      if (activeAbortController) {
        activeAbortController.abort();
      }
    });
  }

  function restoreSendButton() {
    if (!actionsBar) return;
    actionsBar.classList.remove('hidden');
    actionsBar.innerHTML = `
      <span class="text-[10px] text-faint font-mono" id="composer-footer-hint">
        ${activeMode === 'single' ? `1:1 Consultation with ${targetAgent.name} · Real-time streaming` : 'Multi-agent sequential deliberation · Quorum active'}
      </span>
      <div class="flex items-center gap-2">
        <button id="composer-send-btn" class="btn btn-primary text-xs py-1.5 px-4">
          <span>${activeMode === 'single' ? `Send to ${targetAgent.name}` : 'Send to Board'}</span>
          <svg class="w-3.5 h-3.5 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
        </button>
      </div>
    `;

    document.getElementById('composer-send-btn')?.addEventListener('click', () => {
      if (!isGenerating) triggerSend();
    });
    renderRoomParticipantsSheet();
  }

  function setAgentSpeakingState(agentId, isSpeaking) {
    const card = document.querySelector(`.director-table-card[data-agent-id="${agentId}"]`);
    const pulseContainer = document.querySelector(`.director-pulse-container[data-pulse-agent="${agentId}"]`);

    if (card) {
      if (isSpeaking) {
        card.classList.add('is-speaking-card');
      } else {
        card.classList.remove('is-speaking-card');
      }
    }

    if (pulseContainer) {
      const dot = pulseContainer.querySelector('.pulse-indicator-dot');
      const text = pulseContainer.querySelector('.pulse-indicator-text');
      if (dot && text) {
        if (isSpeaking) {
          dot.className = 'pulse-indicator-dot w-2 h-2 rounded-full is-speaking-dot';
          text.className = 'pulse-indicator-text text-[9px] font-mono text-emerald-400 font-bold uppercase';
          text.textContent = 'Speaking';
        } else {
          dot.className = 'pulse-indicator-dot w-2 h-2 rounded-full bg-slate-600 transition-colors';
          text.className = 'pulse-indicator-text text-[9px] font-mono text-faint uppercase';
          text.textContent = 'Idle';
        }
      }
    }
  }

  // Trigger Send Routine
  async function triggerSend(textToOverride = null) {
    const text = textToOverride !== null ? textToOverride : textarea.value.trim();
    if (!text) return;

    const selectedParticipants = roomParticipants.filter(p => p.enabled !== false);
    if (activeMode === 'all' && selectedParticipants.length === 0) {
      return;
    }

    lastUserText = text;
    setAwaitingFounder(false);

    if (textarea) {
      textarea.value = '';
      textarea.style.height = 'auto';
      textarea.disabled = true;
    }
    isGenerating = true;
    activeAbortController = new AbortController();

    sessionControl.pauseAfterCurrent = false;
    sessionControl.isStopped = false;
    sessionControl.skipToChair = false;

    // Remove any prior error bubble
    document.querySelector('.inline-error-bubble')?.remove();

    if (activeMode === 'single') {
      showStopButton();
      // 1:1 Single-Agent Execution
      try {
        await singleAgentChat({
          venture,
          phase: currentPhase,
          text,
          targetAgentId,
          session: activeSession,
          signal: activeAbortController.signal,
          onAgentSpeakingChange: (agentId, isSpeaking) => {
            setAgentSpeakingState(agentId, isSpeaking);
          },
          onMessageStart: (agentMsg) => {
            appendMessageBubble(agentMsg);
          },
          onChunk: (msgId, fullChunkText) => {
            updateMessageBubble(msgId, fullChunkText);
          },
          onMessageDone: (agentMsg) => {
            finalizeMessageBubble(agentMsg);
          }
        });
      } catch (err) {
        console.error('Single-agent chat error:', err);
        renderInlineError(err, text);
      } finally {
        finishTurn();
      }
    } else {
      // Full-Board Sequenced Roundtable
      showSessionControls();
      try {
        await conveneDeliberationRound({
          venture,
          phase: currentPhase,
          text,
          participants: selectedParticipants,
          session: activeSession,
          sessionControl,
          signal: activeAbortController.signal,
          onSessionStart: () => {
            renderFeed();
          },
          onProgress: ({ current, total, agentName, isChairSummary }) => {
            if (sessionProgressText) {
              if (isChairSummary) {
                sessionProgressText.textContent = `${total} of ${total} spoke · The Chair formulating summary...`;
              } else {
                const spokeCount = Math.max(0, current - 1);
                sessionProgressText.textContent = `${spokeCount} of ${total} spoke · ${agentName} speaking...`;
              }
            }
            if (sessionProgressBar) {
              const pct = isChairSummary ? 100 : Math.max(10, Math.round((current / Math.max(1, total)) * 90));
              sessionProgressBar.style.width = `${pct}%`;
            }
          },
          onPauseStateChange: (isPaused) => {
            if (sessionProgressText && isPaused) {
              sessionProgressText.textContent = 'Paused between speakers · Click Resume Session to continue';
            }
          },
          onAgentSpeakingChange: (agentId, isSpeaking) => {
            setAgentSpeakingState(agentId, isSpeaking);
          },
          onSpeakerStart: (agentMsg) => {
            appendMessageBubble(agentMsg);
          },
          onChunk: (msgId, fullChunkText) => {
            updateMessageBubble(msgId, fullChunkText);
          },
          onSpeakerDone: (agentMsg) => {
            finalizeMessageBubble(agentMsg);
          },
          onSpeakerError: (agentMsg) => {
            finalizeMessageBubble(agentMsg);
          }
        });
      } catch (err) {
        console.error('Multi-agent deliberation error:', err);
        renderInlineError(err, text);
      } finally {
        finishTurn();
      }
    }
  }

  function finishTurn() {
    isGenerating = false;
    hideSessionControls();
    if (textarea) {
      textarea.disabled = false;
      textarea.focus();
    }
    restoreSendButton();
    wireTranscriptActions();
    markAwaitingFounder();
    window.dispatchEvent(new CustomEvent('boardroom:sync'));
  }

  /**
   * Toggle the "board is awaiting your reply" banner.
   */
  function setAwaitingFounder(show, customText = '') {
    const banner = document.getElementById('awaiting-founder-banner');
    const label = document.getElementById('awaiting-founder-text');
    if (!banner) return;
    if (label && customText) label.textContent = customText;
    if (show) {
      banner.classList.remove('hidden');
      banner.classList.add('flex');
    } else {
      banner.classList.add('hidden');
      banner.classList.remove('flex');
    }
  }

  /**
   * Show the hand-back prompt when the board has spoken since the founder's last message,
   * so the founder knows the floor has returned to them (the Socratic turn).
   */
  function markAwaitingFounder() {
    if (isGenerating) return;

    const msgs = activeSession.messages || [];
    if (msgs.length === 0) {
      setAwaitingFounder(false);
      return;
    }

    let lastFounderIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user' || msgs[i].author === 'Founder') {
        lastFounderIdx = i;
        break;
      }
    }

    const boardReplied = lastFounderIdx !== -1 && msgs.length - 1 > lastFounderIdx;
    if (!boardReplied) {
      setAwaitingFounder(false);
      return;
    }

    if (activeMode === 'single') {
      setAwaitingFounder(true, `${targetAgent.name} is waiting on your answer — reply to go deeper.`);
      if (textarea) textarea.placeholder = `Answer ${targetAgent.name} (${targetAgent.shortRole})...`;
    } else {
      setAwaitingFounder(true, 'The board has questions for you — reply to continue the dialogue.');
      if (textarea) textarea.placeholder = "Answer the board's questions to continue the dialogue...";
    }
  }

  function appendMessageBubble(msg) {
    if (!transcriptFeed) return;

    // Replace empty state if still showing
    if (document.getElementById('empty-state-box')) {
      renderFeed();
      return;
    }

    const msgs = activeSession.messages || [];
    const idx = msgs.findIndex(m => m.id === msg.id);

    // Ensure preceding founder message (e.g. in 1:1 thread) is in the DOM first
    if (idx > 0) {
      const prevMsg = msgs[idx - 1];
      if (prevMsg && !document.getElementById(prevMsg.id)) {
        transcriptFeed.insertAdjacentHTML('beforeend', renderMessageBubble(prevMsg, currentPhase));
      }
    }

    if (!document.getElementById(msg.id)) {
      const bubbleHtml = renderMessageBubble(msg, currentPhase);
      transcriptFeed.insertAdjacentHTML('beforeend', bubbleHtml);
    }

    transcriptFeed.scrollTop = transcriptFeed.scrollHeight;

    if (messageCountBadge) {
      messageCountBadge.textContent = `${msgs.length} remarks`;
    }
  }

  function updateMessageBubble(msgId, fullText) {
    const bubble = document.getElementById(msgId);
    if (!bubble) return;

    const bodyEl = bubble.querySelector('.message-body');
    if (bodyEl) {
      bodyEl.innerHTML = renderMarkdown(fullText);
      transcriptFeed.scrollTop = transcriptFeed.scrollHeight;
    }
  }

  function updateChallengeBubble(msgId, fullText) {
    const bubble = document.getElementById(msgId);
    if (!bubble) return;

    const challengeEl = bubble.querySelector('.challenge-content');
    if (challengeEl) {
      challengeEl.innerHTML = renderMarkdown(fullText);
      transcriptFeed.scrollTop = transcriptFeed.scrollHeight;
    }
  }

  function finalizeMessageBubble(msg) {
    const bubble = document.getElementById(msg.id);
    if (bubble) {
      bubble.outerHTML = renderMessageBubble(msg, currentPhase);
    } else {
      renderFeed();
      return;
    }
    wireTranscriptActions();
  }

  // Render Inline Error Bubble with Retry & Settings Link
  function renderInlineError(err, originalText) {
    if (!transcriptFeed) return;

    const errorHtml = `
      <div class="inline-error-bubble p-4 rounded-xl border border-danger/40 bg-danger/10 text-xs text-slate-200 space-y-2.5 my-3 animate-fadeIn">
        <div class="flex items-center gap-2 text-danger font-medium">
          <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span>Director Consultation Error</span>
        </div>
        <p class="text-xs text-slate-300 leading-relaxed font-mono">
          ${escapeHtml(err.message || 'The LLM provider failed to generate a response.')}
        </p>
        <div class="flex items-center gap-3 pt-1">
          <button type="button" class="btn btn-primary text-xs py-1 px-3 retry-chat-btn">
            <svg class="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Retry Response
          </button>
          <a href="#/settings" class="text-xs text-brass-light hover:underline font-medium">
            Configure Provider in Settings →
          </a>
        </div>
      </div>
    `;

    transcriptFeed.insertAdjacentHTML('beforeend', errorHtml);
    transcriptFeed.scrollTop = transcriptFeed.scrollHeight;

    const retryBtn = transcriptFeed.querySelector('.retry-chat-btn');
    retryBtn?.addEventListener('click', () => {
      document.querySelector('.inline-error-bubble')?.remove();
      triggerSend(originalText);
    });
  }

  // Wire message actions (Challenge, Copy, Regenerate, Retry Speaker, Round 2, Cross-Ask, Promote)
  function wireTranscriptActions() {
    // Copy button
    const copyBtns = document.querySelectorAll('.msg-action-copy-btn');
    copyBtns.forEach(btn => {
      btn.onclick = async () => {
        const msgId = btn.getAttribute('data-msg-id');
        const targetMsg = (activeSession.messages || []).find(m => m.id === msgId);
        const bubble = document.getElementById(msgId);
        const text = targetMsg?.text || bubble?.querySelector('.message-body')?.innerText || '';
        if (text) {
          await navigator.clipboard.writeText(text);
          const span = btn.querySelector('span');
          if (span) {
            const original = span.textContent;
            span.textContent = '✓ Copied!';
            setTimeout(() => { span.textContent = original; }, 2000);
          }
        }
      };
    });

    // Challenge button (David Okafor Validation Interrogation)
    const challengeBtns = document.querySelectorAll('.msg-action-challenge-btn');
    challengeBtns.forEach(btn => {
      btn.onclick = async () => {
        if (isGenerating) return;
        const msgId = btn.getAttribute('data-msg-id');
        const targetMsg = (activeSession.messages || []).find(m => m.id === msgId);
        if (!targetMsg) return;

        const agentName = btn.getAttribute('data-author') || targetMsg.author || 'Director';
        const claimText = targetMsg.text || '';

        isGenerating = true;
        if (textarea) textarea.disabled = true;
        showStopButton('David Okafor is interrogating claim...');
        activeAbortController = new AbortController();
        setAgentSpeakingState('david', true);

        try {
          await challengeClaimWithDavid({
            venture,
            phase: currentPhase,
            messageId: msgId,
            agentName,
            claimText,
            session: activeSession,
            signal: activeAbortController.signal,
            onStart: () => {
              renderFeed();
            },
            onChunk: (_chId, fullText) => {
              updateChallengeBubble(msgId, fullText);
            },
            onDone: () => {
              renderFeed();
            }
          });
        } catch (err) {
          console.error('Challenge error:', err);
          renderFeed();
        } finally {
          setAgentSpeakingState('david', false);
          finishTurn();
        }
      };
    });

    // Per-speaker retry button (for errored directors in a round)
    const retrySpeakerBtns = document.querySelectorAll('.msg-retry-speaker-btn');
    retrySpeakerBtns.forEach(btn => {
      btn.onclick = async () => {
        if (isGenerating) return;
        const msgId = btn.getAttribute('data-msg-id');
        const targetMsg = (activeSession.messages || []).find(m => m.id === msgId);
        if (!targetMsg) return;

        isGenerating = true;
        if (textarea) textarea.disabled = true;
        showStopButton(`Retrying ${targetMsg.author || 'Director'}...`);
        activeAbortController = new AbortController();
        if (targetMsg.agentId) setAgentSpeakingState(targetMsg.agentId, true);

        try {
          await retrySpeakerInRound({
            venture,
            phase: currentPhase,
            messageId: msgId,
            session: activeSession,
            signal: activeAbortController.signal,
            onStart: () => {
              renderFeed();
            },
            onChunk: (mId, fullChunkText) => {
              updateMessageBubble(mId, fullChunkText);
            },
            onDone: (retriedMsg) => {
              finalizeMessageBubble(retriedMsg);
            }
          });
        } catch (err) {
          console.error('Retry speaker error:', err);
          renderFeed();
        } finally {
          if (targetMsg.agentId) setAgentSpeakingState(targetMsg.agentId, false);
          finishTurn();
        }
      };
    });

    // Round 2 Continuation button on Executive Round Summary
    const roundTwoBtns = document.querySelectorAll('.round-two-btn');
    roundTwoBtns.forEach(btn => {
      btn.onclick = () => {
        if (isGenerating) return;
        if (activeMode !== 'all') {
          activeMode = 'all';
          updateModeUI();
        }
        if (textarea) {
          if (!textarea.value.trim()) {
            textarea.value = 'Round 2 follow-up: ';
          }
          textarea.style.height = 'auto';
          textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px';
          textarea.focus();
          textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      };
    });

    // Regenerate button
    const regenBtns = document.querySelectorAll('.msg-action-regen-btn');
    regenBtns.forEach(btn => {
      btn.onclick = async () => {
        if (isGenerating) return;
        const agentId = btn.getAttribute('data-agent-id') || targetAgentId;

        isGenerating = true;
        if (textarea) textarea.disabled = true;
        showStopButton();
        activeAbortController = new AbortController();

        try {
          await regenerateLastAgentReply({
            venture,
            phase: currentPhase,
            targetAgentId: agentId,
            session: activeSession,
            signal: activeAbortController.signal,
            onAgentSpeakingChange: (id, isSpeaking) => setAgentSpeakingState(id, isSpeaking),
            onMessageStart: () => renderFeed(),
            onChunk: (msgId, fullChunkText) => updateMessageBubble(msgId, fullChunkText),
            onMessageDone: () => renderFeed()
          });
        } catch (err) {
          console.error('Regenerate error:', err);
          renderInlineError(err, lastUserText);
        } finally {
          finishTurn();
        }
      };
    });

    // Ask another member about this button
    const crossAskBtns = document.querySelectorAll('.msg-action-cross-ask-btn');
    crossAskBtns.forEach(btn => {
      btn.onclick = () => {
        if (isGenerating) return;
        const msgId = btn.getAttribute('data-msg-id');
        const targetMsg = (activeSession.messages || []).find(m => m.id === msgId);
        const bubble = document.getElementById(msgId);
        const agentName = targetMsg?.author || bubble?.querySelector('.font-semibold')?.textContent || 'Director';
        const rawText = targetMsg?.text || bubble?.querySelector('.message-body')?.innerText || '';
        const excerpt = rawText.slice(0, 100).replace(/\s+/g, ' ').trim();

        // Switch to next active member
        const otherAgents = phaseAgents.filter(a => a.id !== (targetMsg?.agentId || targetAgentId));
        const nextAgent = otherAgents[0] || phaseAgents[0];

        activeMode = 'single';
        targetAgentId = nextAgent.id;
        targetAgent = nextAgent;

        updateModeUI();
        updateAgentPickerUI();
        switchThread(targetAgentId).then(() => {
          if (textarea) {
            textarea.value = `${agentName} stated: "${excerpt}..." What is your analytical perspective on this?`;
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px';
            textarea.focus();
          }
        });
      };
    });

    // Promote to deliverable note button
    const promoteBtns = document.querySelectorAll('.msg-action-promote-btn');
    promoteBtns.forEach(btn => {
      btn.onclick = async () => {
        const msgId = btn.getAttribute('data-msg-id');
        const targetMsg = (activeSession.messages || []).find(m => m.id === msgId);
        const bubble = document.getElementById(msgId);
        const agentName = targetMsg?.author || bubble?.querySelector('.font-semibold')?.textContent || 'Director';
        const role = targetMsg?.role || bubble?.querySelector('.chip')?.textContent || '';
        const text = targetMsg?.text || bubble?.querySelector('.message-body')?.innerText || '';

        const noteSnippet = `\n\n[Director Insight — ${agentName} (${role}) in Phase 0${currentPhase.number}: ${currentPhase.label}]:\n${text.trim()}\n`;
        venture.notes = (venture.notes || '') + noteSnippet;
        await saveVenture(venture);

        const span = btn.querySelector('span');
        if (span) {
          span.textContent = '✓ Saved to Notes!';
          setTimeout(() => { span.textContent = 'Promote to note'; }, 2500);
        }
      };
    });
  }

  // Reflect any existing "board awaiting founder" state on initial load
  markAwaitingFounder();
}

/**
 * Wire Synthesis Modal and Triggers
 */
function wireSynthesisTriggers(venture, currentPhase, activeSession) {
  const topbarBtn = document.getElementById('topbar-synthesize-btn');
  const bannerBtn = document.getElementById('banner-synthesize-btn');
  const cardBtns = document.querySelectorAll('.card-synthesize-btn');

  const modal = document.getElementById('synthesis-modal');
  const closeBtn = document.getElementById('close-synthesis-btn');
  const stopBtn = document.getElementById('stop-synthesis-btn');
  const copyBtn = document.getElementById('synthesis-copy-btn');
  const doneBtn = document.getElementById('synthesis-done-btn');
  const streamContent = document.getElementById('synthesis-stream-content');
  const streamIndicator = document.getElementById('synthesis-streaming-indicator');
  const statusChip = document.getElementById('synthesis-status-chip');

  if (!modal) return;

  let synthesisAbortController = null;
  let synthesizedDeliverable = null;

  async function openSynthesis() {
    modal.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');

    if (streamContent) streamContent.innerHTML = '';
    if (streamIndicator) streamIndicator.classList.remove('hidden');
    if (statusChip) {
      statusChip.textContent = 'Synthesizing';
      statusChip.className = 'chip text-[10px] py-0 px-2 agent-brass-bg agent-brass uppercase font-mono animate-pulse';
    }
    if (copyBtn) copyBtn.classList.add('hidden');
    if (doneBtn) doneBtn.classList.add('hidden');
    if (stopBtn) stopBtn.classList.remove('hidden');

    synthesisAbortController = new AbortController();

    try {
      const result = await synthesizePhaseDeliverable({
        venture,
        phase: currentPhase,
        session: activeSession,
        signal: synthesisAbortController.signal,
        onChunk: (fullText) => {
          if (streamContent) {
            streamContent.innerHTML = renderMarkdown(fullText);
            const body = document.getElementById('synthesis-stream-body');
            if (body) body.scrollTop = body.scrollHeight;
          }
        }
      });

      synthesizedDeliverable = result.deliverable;

      // Update UI on completion
      if (streamIndicator) streamIndicator.classList.add('hidden');
      if (statusChip) {
        statusChip.textContent = '✓ Ratified & Synthesized';
        statusChip.className = 'chip text-[10px] py-0 px-2 bg-success/20 text-success border-success/40 uppercase font-mono';
      }
      if (stopBtn) stopBtn.classList.add('hidden');
      if (copyBtn) copyBtn.classList.remove('hidden');
      if (doneBtn) doneBtn.classList.remove('hidden');

      // Update Board Memory preview in header
      const memContent = document.getElementById('board-memory-content');
      if (memContent && venture.boardMemory) {
        memContent.textContent = venture.boardMemory;
      }

      // Update Stage dots in header
      const stageCount = document.getElementById('completed-phases-count');
      if (stageCount) {
        stageCount.textContent = `${(venture.completedPhases || []).length}/4`;
      }

      // Update Deliverables tab count
      const delivBadge = document.getElementById('deliverables-tab-badge');
      if (delivBadge) {
        const count = parseInt(delivBadge.textContent || '0', 10);
        delivBadge.textContent = `${count + 1}`;
      }

      window.dispatchEvent(new CustomEvent('boardroom:sync'));

    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Synthesis failed:', err);
      }
    }
  }

  function closeSynthesis() {
    if (synthesisAbortController) {
      synthesisAbortController.abort();
    }
    modal.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');

    if (synthesizedDeliverable) {
      // Re-render deliverable card dynamically without hard page reload
      const cardContainer = document.getElementById('phase-deliverable-card-container');
      if (cardContainer) {
        cardContainer.innerHTML = `
          <div class="flex items-center justify-between pb-2 border-b border-subtle">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-muted font-mono">
              Phase Deliverable
            </h3>
            <span class="chip text-[10px] py-0 px-1.5 bg-base border-subtle font-mono">
              Phase 0${currentPhase.number}
            </span>
          </div>

          <div class="p-3.5 rounded-lg bg-base border border-subtle space-y-2.5">
            <div class="text-xs font-medium text-slate-200 flex items-center gap-1.5">
              <svg class="w-4 h-4 text-brass" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span>${currentPhase.deliverableType}</span>
            </div>

            <div class="pt-1 text-[11px] space-y-2">
              <span class="chip text-[10px] bg-success/10 text-success border-success/30 font-mono block w-fit">
                ✓ Synthesized & Ratified
              </span>
              <p class="text-muted text-[11px] line-clamp-2">
                ${escapeHtml(synthesizedDeliverable.title || 'Official Board Memo')}
              </p>
              <div class="pt-1 flex flex-col gap-1.5">
                <a href="#/venture/${venture.id}/deliverables" class="text-brass-light hover:underline font-medium text-xs flex items-center gap-1">
                  View Deliverable Memo →
                </a>
                <button class="btn btn-ghost text-[11px] py-1 px-2 border border-subtle text-muted hover:text-slate-200 card-synthesize-btn">
                  Re-synthesize Memo
                </button>
              </div>
            </div>
          </div>
        `;
        const newCardBtn = cardContainer.querySelector('.card-synthesize-btn');
        if (newCardBtn) newCardBtn.addEventListener('click', openSynthesis);
      }
      window.dispatchEvent(new CustomEvent('boardroom:sync'));
    }
  }

  topbarBtn?.addEventListener('click', openSynthesis);
  bannerBtn?.addEventListener('click', openSynthesis);
  cardBtns.forEach(btn => btn.addEventListener('click', openSynthesis));

  closeBtn?.addEventListener('click', closeSynthesis);
  stopBtn?.addEventListener('click', () => {
    if (synthesisAbortController) synthesisAbortController.abort();
    modal.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
  });

  copyBtn?.addEventListener('click', async () => {
    if (synthesizedDeliverable?.content) {
      await navigator.clipboard.writeText(synthesizedDeliverable.content);
      const span = copyBtn.querySelector('span') || copyBtn;
      const prevText = span.textContent;
      span.textContent = '✓ Copied!';
      setTimeout(() => { span.textContent = prevText; }, 2000);
    }
  });

  doneBtn?.addEventListener('click', () => {
    modal.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
    window.location.hash = `#/venture/${venture.id}/deliverables`;
  });
}

/**
 * Render Deliverables Tab (with Export Tools: Copy, Download, Print)
 */
function renderDeliverablesTab({ venture, ventureDeliverables }) {
  if (ventureDeliverables.length === 0) {
    return `
      <div class="panel p-8 text-center border-subtle space-y-3">
        <div class="w-12 h-12 rounded-full bg-base border border-subtle text-brass-light flex items-center justify-center mx-auto">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <h3 class="font-serif text-2xl text-slate-100">No Phase Deliverables Synthesized Yet</h3>
        <p class="text-xs text-muted max-w-md mx-auto leading-relaxed">
          Deliberate with your board in the Boardroom Chamber. When a milestone session concludes, click "Synthesize Memo" and The Chair will synthesize the record into an official executive memo.
        </p>
        <div class="pt-2">
          <a href="#/venture/${venture.id}/boardroom?phase=ideation" class="btn btn-primary text-xs">
            Convene Boardroom Chamber →
          </a>
        </div>
      </div>
    `;
  }

  return `
    <div class="space-y-6">
      <div class="flex items-center justify-between pb-2">
        <div>
          <h2 class="font-serif text-2xl text-slate-100">Executive Deliverables Archive</h2>
          <p class="text-xs text-muted">Official board memos synthesized and ratified across stage-gate milestones.</p>
        </div>
        <button id="print-all-deliverables-btn" class="btn btn-ghost text-xs py-1.5 px-3 border border-subtle hover:text-slate-100">
          <svg class="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
          </svg>
          Print / PDF Export
        </button>
      </div>

      <div class="space-y-6">
        ${ventureDeliverables.map(deliv => `
          <div class="panel p-6 sm:p-8 border-subtle space-y-4 deliverable-print-card" data-deliv-id="${deliv.id}">
            <!-- Header Toolbar -->
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-subtle">
              <div class="space-y-1">
                <div class="flex items-center gap-2">
                  <span class="chip text-[10px] py-0 px-2 bg-brass/10 text-brass-light border-brass/30 uppercase font-mono">
                    Phase: ${escapeHtml(deliv.phase)}
                  </span>
                  <span class="chip text-[10px] py-0 px-1.5 bg-success/10 text-success border-success/30 font-mono">
                    ✓ Ratified
                  </span>
                </div>
                <h3 class="font-serif text-2xl text-slate-100">${escapeHtml(deliv.title || 'Executive Memo')}</h3>
                <div class="text-[11px] font-mono text-muted">Ratified on ${new Date(deliv.createdAt).toLocaleDateString()} at ${new Date(deliv.createdAt).toLocaleTimeString()}</div>
              </div>

              <!-- Export Tools -->
              <div class="flex items-center gap-2 shrink-0">
                <button class="btn btn-ghost text-xs py-1.5 px-3 border border-subtle copy-deliv-btn" data-deliv-id="${deliv.id}">
                  <svg class="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                  </svg>
                  <span>Copy Markdown</span>
                </button>
                <button class="btn btn-ghost text-xs py-1.5 px-3 border border-subtle download-deliv-btn" data-deliv-id="${deliv.id}">
                  <svg class="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  <span>Download .md</span>
                </button>
              </div>
            </div>

            <!-- Deliverable Content -->
            <div class="markdown-body p-5 rounded-lg bg-base border border-subtle text-xs text-slate-200">
              ${renderMarkdown(deliv.content || '')}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

/**
 * Wire Deliverables Tab Tools
 */
function wireDeliverablesTab(venture, deliverables) {
  // Print / PDF Export
  const printBtn = document.getElementById('print-all-deliverables-btn');
  if (printBtn) {
    printBtn.addEventListener('click', () => {
      window.print();
    });
  }

  // Copy Markdown buttons
  const copyBtns = document.querySelectorAll('.copy-deliv-btn');
  copyBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-deliv-id');
      const deliv = deliverables.find(d => d.id === id);
      if (deliv && deliv.content) {
        await navigator.clipboard.writeText(deliv.content);
        const span = btn.querySelector('span');
        if (span) {
          const original = span.textContent;
          span.textContent = '✓ Copied!';
          setTimeout(() => { span.textContent = original; }, 2000);
        }
      }
    });
  });

  // Download .md buttons
  const downloadBtns = document.querySelectorAll('.download-deliv-btn');
  downloadBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-deliv-id');
      const deliv = deliverables.find(d => d.id === id);
      if (deliv && deliv.content) {
        const slug = (venture.name || 'venture').toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const filename = `${slug}-${deliv.phase}-deliverable.md`;
        const blob = new Blob([deliv.content], { type: 'text/markdown;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    });
  });
}

/**
 * Render Notes Tab
 */
function renderNotesTab({ venture }) {
  return `
    <div class="panel p-6 border-subtle space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <h3 class="font-serif text-xl text-slate-100">Founder Strategy Scratchpad</h3>
          <p class="text-xs text-muted">Private founder workspace notes — persisted locally in IndexedDB.</p>
        </div>
        <span id="notes-status-badge" class="text-xs text-brass-light font-medium font-mono"></span>
      </div>
      <textarea 
        id="venture-notes-textarea" 
        rows="12" 
        class="input font-mono text-xs leading-relaxed p-4" 
        placeholder="Capture customer discovery quotes, unit economic assumptions, investor feedback, or questions for upcoming board sessions..."
      >${escapeHtml(venture.notes || '')}</textarea>
      <div class="flex justify-end">
        <button id="save-notes-btn" class="btn btn-primary text-xs py-1.5 px-4">
          Save Notes
        </button>
      </div>
    </div>
  `;
}

/**
 * Wire Header Inline Name Edit
 */
function wireHeaderRename(venture, topbarVenture) {
  const editBtn = document.getElementById('edit-name-btn');
  const editContainer = document.getElementById('inline-edit-name-container');
  const displayName = document.getElementById('venture-display-name');
  const nameInput = document.getElementById('inline-name-input');
  const saveNameBtn = document.getElementById('save-name-btn');
  const cancelNameBtn = document.getElementById('cancel-name-btn');

  if (editBtn && editContainer && displayName && nameInput) {
    editBtn.addEventListener('click', () => {
      displayName.classList.add('hidden');
      editBtn.classList.add('hidden');
      editContainer.classList.remove('hidden');
      nameInput.focus();
    });

    cancelNameBtn?.addEventListener('click', () => {
      displayName.classList.remove('hidden');
      editBtn.classList.remove('hidden');
      editContainer.classList.add('hidden');
      nameInput.value = venture.name;
    });

    saveNameBtn?.addEventListener('click', async () => {
      const newName = nameInput.value.trim();
      if (newName) {
        venture.name = newName;
        await saveVenture(venture);
        displayName.textContent = newName;
        if (topbarVenture) topbarVenture.textContent = newName;
        displayName.classList.remove('hidden');
        editBtn.classList.remove('hidden');
        editContainer.classList.add('hidden');
      }
    });

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveNameBtn?.click();
      if (e.key === 'Escape') cancelNameBtn?.click();
    });
  }
}

/**
 * Wire Notes Tab saving
 */
function wireNotesTab(venture) {
  const saveNotesBtn = document.getElementById('save-notes-btn');
  const notesTextarea = document.getElementById('venture-notes-textarea');
  if (saveNotesBtn && notesTextarea) {
    saveNotesBtn.addEventListener('click', async () => {
      venture.notes = notesTextarea.value;
      await saveVenture(venture);
      const noteStatus = document.getElementById('notes-status-badge');
      if (noteStatus) {
        noteStatus.textContent = 'Saved to IndexedDB';
        setTimeout(() => { noteStatus.textContent = ''; }, 3000);
      }
    });
  }
}
