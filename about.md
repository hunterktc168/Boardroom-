# Boardroom — Executive AI Board of Directors

Boardroom is a **local-first, zero-build executive advisory web application** that gives startup founders a virtual board of directors. Instead of a single chatbot, it convenes a room of **six specialized C-suite personas** — orchestrated by **The Chair** — who engage the founder in a genuine, human-in-the-loop **Socratic dialogue** to plan, design, and strategize together across four strategic stage-gate phases.

Everything runs in the browser. There is no backend, no build step, and no required API key: the default engine is a fully offline simulation, and you can optionally plug in a live LLM provider for higher-fidelity responses.

---

## What It Is

- A **simulated board of directors** for early-stage founders, not a generic assistant.
- A **structured stage-gate process**: Ideation → Validation → Business Plan → Marketing Strategy.
- A **back-and-forth deliberation**, where directors build on, challenge, and sharpen each other's arguments — and hand the floor back to the founder for answers before converging.
- **Local-first and private**: all ventures, transcripts, and deliverables live in the browser's IndexedDB. Nothing leaves your machine unless you explicitly configure a remote provider.

---

## Capabilities

### Structured deliberation
- **Full board rounds**: The Chair convenes a round; each assigned director speaks in turn, building on and challenging the previous remarks by name.
- **Single-director 1:1 inquiries**: Ask one specific member a focused question without convening the full board.
- **The Chair's synthesis**: The Chair moderates, summarizes each round, and — once the dialogue has converged — drafts the official phase deliverable.

### Human-in-the-loop Socratic dialogue
- Every director response **hands the floor back to the founder** with 1–2 targeted questions rather than delivering a final verdict.
- Each subsequent turn **reacts to the founder's latest answer** — quoting or paraphrasing it and escalating the line of inquiry one step deeper.
- An **"awaiting founder" banner** in the composer makes it explicit when the board is waiting on your reply, so the loop is never left hanging.

### Real-time streaming & control
- **Live chunk streaming** into transcript bubbles with active typing indicators.
- **Auto-scroll** to the newest message and **speaking pulse** indicators on the director cards currently talking.
- **Instant stop / interrupt**: the founder can abort any in-flight generation with the Stop button.

### Milestone deliverable synthesis
- The Chair synthesizes **official stage-gate memos** (e.g. Opportunity Brief, Validation Matrix, Business Model Memo, GTM Playbook).
- Each deliverable is **ratified into the permanent venture repository** and folded into **cumulative board memory** so later phases inherit the context.

### Export tools
- **Copy Markdown**, **Download `.md`**, and a clean **`@media print`** PDF/print export of any deliverable.

### Persistence & provider configuration
- IndexedDB-backed storage (`boardroom_db`) for ventures, agents, sessions, deliverables, and settings.
- Provider selection (Mock / OpenAI-compatible / Anthropic / Gemini), credential entry, temperature control, a connection test ping, and local database wipe tools.

---

## The Board Roster

| Member | Role | Color token | Focus |
| --- | --- | --- | --- |
| **Maya Chen** | Chief Innovation Officer (CIO) | `#06b6d4` cyan | Adjacent market vacuums, contrarian wedges, blue-ocean strategy |
| **David Okafor** | Validation Partner (VP) | `#f59e0b` amber | Falsifiable hypotheses, smoke tests, explicit kill criteria |
| **Priya Raman** | COO / Strategy | `#8b5cf6` violet | 90-day operating cadence, structural moats, execution sequencing |
| **Marcus Webb** | Chief Marketing Officer (CMO) | `#10b981` emerald | ICP wedge narrative, positioning, asymmetric acquisition channels, CAC/LTV |
| **Elena Vasquez** | Chief Financial Officer (CFO) | `#f43f5e` rose | Unit economics, gross margin floors, pricing, cash runway |
| **Sam Torres** | Customer Advocate & Head of Product | `#0ea5e9` sky | User friction mapping, brutal MVP scope cuts, PMF signals |
| **The Chair** | Chief of Staff (orchestrator) | `#C9A227` brass | Convenes the boardroom, moderates interjections, drafts synthesized deliverables |

Each persona has a distinct worldview, tone, and set of questions, defined in `js/agents.js`. The directors assigned to each phase are mapped in `PHASE_AGENTS`.

---

## The Four Stage-Gate Phases

| # | Phase | Objective | Target Deliverable |
| --- | --- | --- | --- |
| 1 | **Ideation** | Explore adjacent market vacuums, contrarian angles, and non-consensus value propositions. | Opportunity Brief & Concept Architecture |
| 2 | **Validation** | Subject core assumptions to falsification tests, kill criteria, and real customer commitment thresholds. | Validation Matrix & Experiment Log |
| 3 | **Business Plan** | Architect defensible moats, positive contribution margins, operating cadence, and capital runway. | Executive Business Model Memo |
| 4 | **Marketing Strategy** | Establish sharp ICP positioning, repeatable acquisition wedges, and unit-economic-positive CAC/LTV scaling. | Go-To-Market & Growth Playbook |

---

## Tech Stack

- **Vanilla ES modules** — no bundler, no framework, no build pipeline. The app runs directly in a modern browser.
- **Tailwind CSS Play CDN** — with a custom executive theme (`#0B0F14` base, `#131A22` panels, warm brass `#C9A227` accent) and semantic utility classes.
- **Custom CSS design system** — `.panel`, `.panel-header`, `.btn`, `.btn-primary`, `.btn-ghost`, `.input`, `.avatar`, `.chip`, `.divider`, plus agent color tokens, speaking-glow/pulse animations, and `@media print` executive formatting.
- **Google Fonts** — Instrument Serif & Inter.
- **IndexedDB** — Promise-based local persistence wrapper (`boardroom_db`).
- **Multi-provider LLM abstraction** — an async-generator `stream()` interface with `AbortController` support.
- **Custom XSS-safe markdown renderer** — escapes HTML entities before parsing, so no raw tags can execute.
- **Zero runtime dependencies** for the app itself.

> Note: the repo's `package.json` includes a Vite setup for local dev tooling, but the application itself is plain ES modules and does not require it to run.

### Module map

```text
├── index.html               # Entry point: shell layout, Tailwind CDN, fonts
├── css/
│   └── styles.css           # Executive utilities, agent tokens, print styles
├── js/
│   ├── app.js               # Hash router, mobile drawer, sidebar/right-rail sync
│   ├── db.js                # IndexedDB engine (agents, ventures, sessions, deliverables, settings)
│   ├── markdown.js          # XSS-safe markdown renderer
│   ├── agents.js            # Roster, PHASE_AGENTS, prompt builders, context packet
│   ├── llm.js               # MockProvider + OpenAI + Anthropic + Gemini, stream()
│   ├── orchestrator.js      # Deliberation sequencer, streaming, synthesis, board memory
│   └── views/
│       ├── dashboard.js     # Venture catalog, search/sort, templates, New Venture modal
│       ├── venture.js       # Workspace shell: boardroom, deliverables, notes tabs
│       ├── phase.js         # Re-routes phase URLs to the boardroom chamber
│       ├── agents.js        # Director directory, enable/disable, prompt inspection
│       └── settings.js      # Provider config, credentials, connection test, DB tools
└── metadata.json            # App metadata
```

---

## LLM Providers

Selected in **Settings & Keys**. The default requires no configuration.

| Provider | Endpoint / Notes |
| --- | --- |
| **Mock** (default) | Fully offline, deterministic, persona-aware. Generates a real turn-aware Socratic back-and-forth with no network or API key. |
| **OpenAI-compatible** | `POST /chat/completions` with SSE streaming. Works with any OpenAI-compatible endpoint (configurable base URL). |
| **Anthropic Claude** | `POST /v1/messages` with `x-api-key` and browser-direct-access header. |
| **Google Gemini** | `streamGenerateContent` SSE (default model `gemini-3.8-flash`). |

Credentials and preferences are stored **only** in the local browser IndexedDB — never sent anywhere except the provider you choose. Streaming responses can be aborted at any time via `AbortSignal`.

---

## Workflow

1. **Create a venture** — from the Dashboard, start blank or from one of four starter templates; enter the name, thesis, target ICP, problem, and solution.
2. **Enter a phase** — pick one of the four stage-gates from the sidebar stepper or a venture card.
3. **Convene the board** — the founder and The Chair open a boardroom session. Directors assigned to that phase (`PHASE_AGENTS`) take the table.
4. **Deliberate** — send a prompt (single director or full board). Directors stream responses in real time, build on each other, and end by **handing the floor back with questions**.
5. **Answer back** — the founder replies; each director reacts to the latest answer and escalates the inquiry. This Socratic loop continues until the dialogue converges. An "awaiting founder" banner appears whenever the board has spoken last.
6. **Synthesize** — when the dialogue has converged, The Chair drafts the official phase deliverable.
7. **Ratify & persist** — the deliverable is logged to the permanent venture repository and summarized into cumulative board memory for the next phase.
8. **Export** — copy, download as `.md`, or print to PDF.
9. **Advance** — move to the next stage-gate, where the board inherits the accumulated context.

---

## Route Schema

- `#/dashboard` — Venture catalog and stage-gate tracker.
- `#/venture/:id/boardroom?phase=ideation&mode=single&agent=maya` — Boardroom chamber (full board or single-director mode).
- `#/venture/:id/phase/:phase` — Convenience route that opens the boardroom at a given phase.
- `#/agents` — Full 6 + Chair roster, toggles, and prompt inspection.
- `#/settings` — Provider selection, credentials, temperature, connection test, DB tools.

---

## Design & Accessibility

- Dark "executive boardroom" aesthetic built on a warm brass accent.
- Responsive from 375px mobile viewports up to 1440px desktop, with a collapsible mobile drawer sidebar and a hidden-on-mobile right rail ("Board at the Table").
- Skip links, focus-visible outlines, ARIA attributes, and `prefers-reduced-motion` support.
