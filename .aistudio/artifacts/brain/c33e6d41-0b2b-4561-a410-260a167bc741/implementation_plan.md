# Implementation Plan — Boardroom

Boardroom is a local-first, zero-build executive advisory web application that simulates a high-caliber startup board of directors. Founders progress through four strategic stage-gate phases—**Ideation, Validation, Business Plan, and Marketing Strategy**—engaging with six specialized C-suite executive personas orchestrated by The Chair, backed by IndexedDB persistence and multi-provider LLM streaming (**Mock offline simulation**, **Gemini 3.8 Flash**, **OpenAI-compatible APIs**, and **Anthropic Claude**).

## User Review & Critical Decisions

- **Structured Deliberation Orchestration**: Supports full multi-agent deliberation rounds convened by The Chair, followed by sequentially prompted directors who build upon and challenge prior remarks, plus single-director inquiries.
- **Real-Time Chunk Streaming & Abort**: Live streaming into transcript bubbles with active typing indicators, auto-scroll, speaking pulse indicators on director cards, and instant founder stop/interrupt controls.
- **Milestone Deliverable Synthesis**: The Chair synthesizes official stage-gate memos with ratifications logged to the permanent venture repository and cumulative board memory updated.
- **Deliverables Export Tools**: Direct "Copy Markdown", "Download .md", and clean `@media print` PDF/print exports.
- **Local-First Zero-Build**: Vanilla ES modules, Tailwind CSS Play CDN, IndexedDB wrapper (`boardroom_db`), and XSS-sanitized markdown parser.

---

## 1. Overview & Architecture

### Four Stage-Gate Phases
1. **Phase 1: Ideation** — Market vacuums, contrarian wedges, adjacent market mapping.
2. **Phase 2: Validation** — Falsifiable hypotheses, smoke test design, and kill criteria.
3. **Phase 3: Business Plan** — Unit economics, gross margin hurdle, 90-day operating cadence, and capital runway.
4. **Phase 4: Marketing Strategy** — ICP clarity, asymmetric acquisition channels, and CAC/LTV economics.

### Executive Board Roster
1. **Maya Chen (Chief Innovation Officer / CIO)** — Cyan token (`#06b6d4`) — Expansive, generative, analogical thinker mapping adjacent markets and contrarian wedges.
2. **David Okafor (Validation Partner / VP)** — Amber token (`#f59e0b`) — Unsparing skeptic demanding empirical evidence, falsifiable hypotheses, and kill criteria.
3. **Priya Raman (COO / Strategy)** — Violet token (`#8b5cf6`) — Systems thinker turning ideas into 90-day operating cadences and defensible moats.
4. **Marcus Webb (Chief Marketing Officer / CMO)** — Emerald token (`#10b981`) — Go-to-market strategist focused on ICP wedge narrative and channel economics.
5. **Elena Vasquez (Chief Financial Officer / CFO)** — Rose token (`#f43f5e`) — Numbers-first auditor enforcing gross margin floors and cash runway discipline.
6. **Sam Torres (Customer Advocate & Head of Product)** — Sky token (`#0ea5e9`) — User-centric auditor mapping workflow friction and enforcing brutal MVP scope cuts.
*Orchestrated by:* **The Chair (Chief of Staff)** — Warm brass token (`#C9A227`) — Neutral executive who convenes the boardroom, moderates founder interjections, and drafts synthesized phase deliverables.

---

## 2. Implemented Modules

1. `/index.html`: Entry point with dark boardroom aesthetic (`#0B0F14` base, `#131A22` panels, `#C9A227` brass accent), Google Fonts (Instrument Serif & Inter), persistent shell layout (collapsible drawer sidebar, persistent topbar, hidden-on-mobile right rail).
2. `/css/styles.css`: Custom executive utility classes (`.panel`, `.panel-header`, `.btn`, `.btn-primary`, `.btn-ghost`, `.input`, `.avatar`, `.chip`, `.divider`), agent color tokens, speaking glow & pulse animations, and `@media print` executive print formatting.
3. `/js/db.js`: Complete Promise-based IndexedDB engine managing `agents`, `ventures`, `sessions`, `deliverables`, and `settings` object stores.
4. `/js/markdown.js`: XSS-safe markdown renderer enforcing HTML entity escaping prior to parsing headings, lists, blockquotes, code blocks, and links.
5. `/js/agents.js`: Roster configurations, `PHASE_AGENTS`, stage-gate metadata, token-efficient `buildContextPacket`, and custom `systemPromptTemplate` generators.
6. `/js/llm.js`: Multi-provider LLM abstraction supporting `MockProvider` (offline, persona-aware, deterministic streaming), `OpenAIProvider`, `AnthropicProvider`, and `GeminiProvider` (`gemini-3.8-flash`).
7. `/js/orchestrator.js`: Multi-agent deliberation sequencer, real-time chunk streaming, speaking pulse state management, deliverable synthesis engine, and cumulative board memory updates.
8. `/js/views/dashboard.js`: Venture catalog with search/sort, stage-gate completion dots, empty state with 4 starter templates, and a 2-step keyboard-navigable New Venture modal.
9. `/js/views/venture.js`: Workspace shell supporting `boardroom`, `deliverables`, and `notes` tabs, editable name, expandable Board Memory panel, real-time composer with Stop button, live speaking pulse, synthesis modal, and deliverable export tools.
10. `/js/views/agents.js`: Directory of all 6 directors + The Chair, enable/disable toggles, prompt inspection drawer, and deliberation participation metrics.
11. `/js/views/settings.js`: Provider selection (`mock`, `openai`, `anthropic`, `gemini`), credentials, temperature slider, connection test ping, security warning, and DB wipe tools.
12. `/js/app.js`: Hash router, responsive mobile drawer controls, sidebar stepper synchronization, and cross-view `boardroom:sync` dispatching.

---

## 3. Verification Outcomes

- **Applet Compilation**: `compile_applet` passed successfully.
- **Type & Syntax Linting**: `lint_applet` (`tsc --noEmit`) passed with zero errors or warnings.
- **Dev Server**: Running on port 3000.
