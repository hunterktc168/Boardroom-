# Boardroom — Executive AI Board of Directors

Boardroom is a local-first web application providing startup founders with a structured, 6-director virtual advisory board across four strategic stage-gates: **Ideation**, **Validation**, **Business Plan**, and **Marketing Strategy**.

## Architecture & Principles

- **Zero-Build Vanilla ES Modules**: Runs natively in modern browsers with zero bundler, zero npm dependencies, and no build pipeline.
- **Executive Boardroom Design System**: Built on Tailwind Play CDN with custom theme extensions (`#0B0F14` dark base, `#131A22` panels, warm brass `#C9A227` accent, and custom `.panel`, `.btn`, `.chip`, `.input` utility classes).
- **Client-Side Hash Router**: Lightweight zero-dependency router managing route transitions, mobile drawer state, topbar synchronization, and right-rail director assignment.
- **Accessible Layout**: Responsive from 375px mobile viewports to desktop 1440px displays, complete with skip links, focus-visible outlines, ARIA attributes, and `prefers-reduced-motion` compliance.

## File Structure

```text
├── index.html               # Main entry point, Tailwind CDN, fonts, persistent shell
├── css/
│   └── styles.css           # Custom utilities (.panel, .btn, .chip), agent tokens, scrollbars
├── js/
│   ├── app.js               # Bootstrap, hash-based router (#/dashboard, #/venture/:id/phase/:p, #/agents, #/settings)
│   ├── agents-data.js       # Executive roster metadata & stage-gate phase definitions
│   └── views/
│       ├── dashboard.js     # Workspace overview & stage-gate cards
│       ├── phase.js         # Deliberation chamber view & stage-gate controller
│       ├── agents.js        # Full 6+1 board member roster with domain quotes & focus areas
│       └── settings.js      # LLM provider configuration & IndexedDB local storage status
└── README.md                # Project documentation
```

## Director Roster & Color Tokens

1. **Chief Innovation Officer (CIO)** — `cyan` (`#06b6d4`) — Gaps, adjacent opportunities, and blue-ocean strategies.
2. **Validation Partner (VP)** — `amber` (`#f59e0b`) — Hypothesis testing, falsification standards, and smoke tests.
3. **Chief Strategy Officer (CSO)** — `violet` (`#8b5cf6`) — Economic moats, defensibility, and competitive positioning.
4. **Chief Marketing Officer (CMO)** — `emerald` (`#10b981`) — ICP clarity, positioning, channels, and CAC/LTV.
5. **Chief Financial Officer (CFO)** — `rose` (`#f43f5e`) — Unit economics, gross margin hurdles, and burn rate.
6. **Chief Operating Officer (COO)** — `sky` (`#0ea5e9`) — Operational execution, supply/delivery pipelines, and cadence.
7. **The Chair (Chief of Staff)** — `brass` (`#C9A227`) — Orchestration, founder interjection mediation, and memo synthesis.

## Route Schema

- `#/dashboard` — Executive venture overview and milestone stage-gate tracker.
- `#/venture/:id/phase/:phase` — Boardroom chamber for the specified phase (`ideation`, `validation`, `business-plan`, `marketing`).
- `#/agents` — Detailed roster cards for all 6 board members and The Chair.
- `#/settings` — AI inference provider selection, local IndexedDB management, and theme settings.
