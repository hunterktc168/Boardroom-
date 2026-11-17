/**
 * Boardroom Multi-Provider LLM Engine
 * Pure Vanilla ES Module — Zero dependencies
 *
 * Implements:
 * 1. mock (Default) — Deterministic, offline, persona-aware canned responses echoing venture/phase/last message
 * 2. openai — OpenAI-compatible /chat/completions with SSE streaming and AbortSignal
 * 3. anthropic — Anthropic /v1/messages with x-api-key & anthropic-dangerous-direct-browser-access
 * 4. gemini — Google Gemini streamGenerateContent SSE
 */

import { getSetting } from './db.js';

/**
 * Format messages for OpenAI compatibility
 */
function formatOpenAIMessages(system, messages = []) {
  const result = [];
  if (system) {
    result.push({ role: 'system', content: system });
  }
  for (const m of messages) {
    result.push({
      role: m.role === 'model' || m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content || m.text || ''
    });
  }
  return result;
}

/**
 * Format messages for Anthropic API
 */
function formatAnthropicMessages(messages = []) {
  const result = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // Anthropic expects system as top-level parameter
    result.push({
      role: m.role === 'model' || m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content || m.text || ''
    });
  }
  if (result.length === 0) {
    result.push({ role: 'user', content: 'Begin board deliberation.' });
  }
  return result;
}

/**
 * Format messages for Gemini API
 */
function formatGeminiContents(messages = []) {
  if (!messages || messages.length === 0) {
    return [{ role: 'user', parts: [{ text: 'Initiate board deliberation.' }] }];
  }

  return messages.map(m => ({
    role: m.role === 'model' || m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content || m.text || '' }]
  }));
}

/**
 * Helper to process SSE ReadableStream chunks line by line
 */
async function* parseSSEStream(response, onDataChunk, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      if (signal && signal.aborted) {
        throw new DOMException('Operation aborted by user', 'AbortError');
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep partial line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;

        if (trimmed.startsWith('data: ')) {
          const dataStr = trimmed.slice(6).trim();
          if (dataStr === '[DONE]') {
            return;
          }
          const textChunk = onDataChunk(dataStr);
          if (textChunk) {
            yield textChunk;
          }
        }
      }
    }

    // Leftover buffer
    if (buffer.trim().startsWith('data: ')) {
      const dataStr = buffer.trim().slice(6).trim();
      if (dataStr && dataStr !== '[DONE]') {
        const textChunk = onDataChunk(dataStr);
        if (textChunk) yield textChunk;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * PROVIDER 1: Mock Provider (Default)
 * 100% Offline, deterministic, persona-aware, echoes venture/phase/last message
 *
 * Dialogue-aware: on the founder's first turn each persona delivers its opening
 * analysis; on every subsequent turn it reacts to the founder's *latest answer*
 * and escalates with the next Socratic question — producing a real back-and-forth
 * between the founder and the board while fully offline.
 */

/**
 * Per-persona Socratic dialogue ladders. Indexed by founder turn (0-based).
 * Each element pairs a reaction to the founder's answer with the next probing question.
 */
const SOCRATIC_LADDERS = {
  maya: {
    header: 'Chief Innovation Officer — Maya Chen',
    framings: [
      'That answer points at a genuinely non-consensus angle — most operators would instinctively dismiss it as too narrow.',
      'What you just described is a behavioural shift, not a feature gap. That is exactly where the asymmetric upside hides.',
      'Good — that gives us a beachhead, but the analogy only holds if the trigger event repeats on its own.'
    ],
    questions: [
      'Which adjacent market has already trained these customers to expect this behaviour, and how do we borrow that distribution instead of rebuilding it?',
      'What is the one contrarian assumption here that, if you are right, makes the incumbents structurally unable to respond?',
      'If we could serve only one job-to-be-done for the next 90 days, which one would make the rest of the wedge inevitable?'
    ]
  },
  david: {
    header: 'Validation Partner — David Okafor',
    framings: [
      'Noted — but that is still stated intent, not commitment, and the gap between the two is where ventures die.',
      'That is closer to signal, yet the sample is too small and too friendly to trust.',
      'Fine — you have a directional read. Now we need to prove it is not survivor bias in a flattering sample.'
    ],
    questions: [
      'How many of those prospects have actually put money, calendar time, or technical access behind that statement in the last 14 days?',
      'What is the exact number and price point at which you would declare this hypothesis falsified and kill the vector outright?',
      'Which single assumption, if it were false, would collapse the whole thesis — and when exactly do we test it?'
    ]
  },
  priya: {
    header: 'COO / Strategy — Priya Raman',
    framings: [
      'That is a real operating constraint, which is useful — constraints are where moats are built.',
      'Good. That tells me where the delivery model breaks before scale exposes it.',
      'Understood — that shifts the bottleneck from demand to throughput, which changes the sequencing entirely.'
    ],
    questions: [
      'What is the single operational dependency that breaks first if transaction volume grows 5x next quarter?',
      'If you had to standardise onboarding down to 48 hours, which bespoke step survives and which do we delete immediately?',
      'What proprietary data does each completed transaction generate that a competitor cannot copy?'
    ]
  },
  marcus: {
    header: 'Chief Marketing Officer — Marcus Webb',
    framings: [
      'That is sharper, but it is still a segment — not yet a wedge that converts on its own.',
      'Good — that narrows the ICP. Now the question is whether the channel can reach them without paid spend.',
      'That narrative positions us against the status quo. The risk is whether the antagonist is vivid enough to be shared.'
    ],
    questions: [
      'What is the exact sentence on your landing page that makes this ICP forward it to their CFO unprompted?',
      'Which single non-obvious channel can you test in the next 14 days for under $500 and still reach 50 qualified buyers?',
      'Who is the named antagonist in your story — the bloated incumbent, the manual status quo, or the internal workaround?'
    ]
  },
  elena: {
    header: 'CFO — Elena Vasquez',
    framings: [
      'That number helps, but revenue is vanity — I need to see contribution margin, not bookings.',
      'Good. Now let us stress-test it, because every one of these models quietly assumes free onboarding.',
      'Understood — that changes the payback window, which is the only number that decides whether we can fund the next stage.'
    ],
    questions: [
      'What is our marginal cost to service the hundredth customer versus the first — including support and compute?',
      'If gross margin must clear 78%, which cost line has to be cut or automated before you hire anyone?',
      'How many months of runway do you get if fully-loaded CAC payback slips from 8 to 14 months?'
    ]
  },
  sam: {
    header: 'Customer Advocate & Head of Product — Sam Torres',
    framings: [
      'That is honest, and honesty about friction is rare — but it also means our onboarding is leaking customers.',
      'Good. That tells me the value moment is real; the problem is everything the user must do before they reach it.',
      'Understood — so the question is no longer what to build, but what to remove so the aha lands faster.'
    ],
    questions: [
      'Where exactly in the first four minutes do users pause, hesitate, or abandon the flow?',
      'Which two features on the roadmap could we delete tomorrow without any paying customer noticing?',
      'What is the one action a new user must complete to feel the product is working — and can we make it the very first thing they see?'
    ]
  },
  chair: {
    header: 'The Chair — Chief of Staff',
    framings: [
      'The board has registered your answer and the tone of the room has shifted.',
      'That clarifies the founder position; the directors will now need to react to it.',
      'Your answer resolves one dispute and opens another. Let us make that explicit.'
    ],
    questions: [
      'Which single question from the board are you deliberately deferring, and why?',
      'On which disagreement do you want the board to take a formal position before you commit resources?',
      'What would have to be true for you to reverse the decision you are leaning toward?'
    ]
  },
  director: {
    header: 'Board Advisory',
    framings: [
      'That answer narrows the problem usefully.',
      'Understood — that moves the discussion onto firmer ground.',
      'That helps, but it also surfaces the next unresolved assumption.'
    ],
    questions: [
      'What empirical evidence do you hold today that supports that answer?',
      'Which assumption behind that answer is the most expensive if it turns out to be wrong?',
      'What is the next concrete step you will take in the next seven days to de-risk it?'
    ]
  }
};

export class MockProvider {
  constructor(config = {}) {
    this.name = 'mock';
  }

  validateConfig() {
    return { ok: true, message: 'Mock provider active (100% offline, zero network, zero keys).' };
  }

  _detectAgentId(meta, system) {
    if (meta && meta.agentId) return meta.agentId.toLowerCase();
    const sys = (system || '').toLowerCase();
    if (sys.includes('maya chen') || sys.includes('chief innovation officer')) return 'maya';
    if (sys.includes('david okafor') || sys.includes('validation partner')) return 'david';
    if (sys.includes('priya raman') || sys.includes('coo') || sys.includes('strategy')) return 'priya';
    if (sys.includes('marcus webb') || sys.includes('chief marketing officer')) return 'marcus';
    if (sys.includes('elena vasquez') || sys.includes('chief financial officer')) return 'elena';
    if (sys.includes('sam torres') || sys.includes('head of product') || sys.includes('customer advocate')) return 'sam';
    if (sys.includes('the chair') || sys.includes('chief of staff')) return 'chair';
    return 'director';
  }

  _extractContextDetails(meta, system, messages) {
    let ventureName = meta?.venture?.name || meta?.ventureName || '';
    let phase = meta?.phase || '';

    // Fallbacks from system prompt if not in meta
    if (!ventureName && system) {
      const match = system.match(/VENTURE NAME:\s*([^\n\r]+)/i);
      if (match) ventureName = match[1].trim();
    }
    if (!phase && system) {
      const match = system.match(/CURRENT PHASE:\s*([^\n\r]+)/i);
      if (match) phase = match[1].trim();
    }

    ventureName = ventureName || 'Apex Robotics';
    phase = phase || 'Ideation';

    // Find last user message
    let lastUserMessage = '';
    if (messages && messages.length > 0) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === 'user' || msg.author === 'Founder' || msg.isFounder) {
          lastUserMessage = (msg.content || msg.text || '').trim();
          break;
        }
      }
    }

    // Founder dialogue turn tracking (0 = opening message, 1+ = founder is answering)
    const founderTurnCount = Number.isFinite(meta?.founderTurnCount)
      ? meta.founderTurnCount
      : 0;
    const founderAnswer = (meta?.founderAnswer || lastUserMessage || '').trim();

    return { ventureName, phase, lastUserMessage, founderTurnCount, founderAnswer };
  }

  _generatePersonaResponse(agentId, { ventureName, phase, lastUserMessage, founderTurnCount = 0, founderAnswer = '' }, meta = {}, system = '') {
    // 1. Validation Challenge Target (David interrogating another director's remark)
    if (meta?.action === 'challenge' || (system && system.includes('CLAIM UNDER INTERROGATION'))) {
      const claimText = meta?.claimText || meta?.challengedText || 'the stated assumption';
      const speaker = meta?.agentName || meta?.challengedSpeaker || 'the prior speaker';
      return `### Validation Interrogation — David Okafor

> *Interrogating statement by ${speaker}:*  
> "${claimText.slice(0, 160)}${claimText.length > 160 ? '...' : ''}"

I am putting this claim directly under the falsification microscope.

#### 1. The Hidden Unfalsified Premise:
${speaker}'s recommendation assumes market willingness without pricing customer inertia. Verbal enthusiasm and polite user interviews are statistical noise.

#### 2. Falsifiable 14-Day Smoke Test:
- **Core Hypothesis**: At least 3 out of 8 target enterprise buyers will sign a 30-day trial pilot letter with a refundable $500 deposit within 10 calendar days.
- **Explicit Kill Criterion**: If fewer than 2 prospects commit budget, this assumption is formally falsified and removed from our active roadmap.`;
    }

    // 2. The Chair Round Summary (3 agreements, 2 disagreements, 1 next action)
    if (meta?.action === 'round_summary' || (system && system.includes('3 Biggest Points of Agreement'))) {
      const founderTopic = meta?.founderText || lastUserMessage || `${ventureName} Strategy`;
      const roundAnswer = (meta?.founderAnswer || lastUserMessage || '').trim();
      const answerAck = (meta?.founderTurnCount >= 1 && roundAnswer)
        ? `\nThe board has registered your latest answer — *"${roundAnswer.slice(0, 120)}${roundAnswer.length > 120 ? '...' : ''}"*. It settles one dispute and sharpens another; both are reflected below.\n`
        : '';
      return `### Round Summary — The Chair

The board has concluded its sequenced roundtable on: *"${founderTopic.slice(0, 90)}${founderTopic.length > 90 ? '...' : ''}"*. 
${answerAck}
Here is the executive consensus, divergences, and immediate milestone directive:

#### 3 Biggest Points of Agreement:
1. **Asymmetric Wedge Primacy**: The directors agree that head-to-head confrontation with legacy incumbents will exhaust runway. A hyper-focused wedge must be established immediately.
2. **Falsifiable Evidence Bar**: Unanimous alignment that customer validation must require non-refundable commitments of operational time or capital within the next 14 to 30 days.
3. **Aggressive Scope Reduction**: Agreement across product and finance that stripping secondary features compresses time-to-value to under four minutes.

#### 2 Sharpest Disagreements:
1. **Pacing vs. Contribution Margin Hurdle**: Tension remains between scaling early customer acquisition velocity versus waiting until unit economics achieve a verified gross margin floor.
2. **High-Touch White-Glove Onboarding vs. Pure Self-Serve**: Debate between intensive manual client onboarding to guarantee pilot retention versus enforcing automated self-serve workflows.

#### Single Most Important Next Action (Proposed):
Deploy a 14-day customer smoke test with binding pilot commitment thresholds and an explicit kill criterion before committing engineering velocity to secondary roadmap modules.

#### Open Questions for the Founder:
1. **Evidence before scale**: Which named prospect has committed non-refundable budget, calendar time, or technical access in the last 14 days — and at what price point?
2. **Wedge vs. breadth**: Which single ICP segment do we serve exclusively for the next 90 days, and what do we explicitly say "no" to?

The board now awaits your answers. Reply directly to continue the deliberation — The Chair drafts the official deliverable only once the dialogue has converged.`;
    }

    // 3. Socratic dialogue follow-up: the founder has already answered at least once.
    // React to their latest answer and escalate with the next probing question rather than
    // replaying the opening monologue — this is what creates the founder ↔ board back-and-forth.
    const isDialogueAction = !meta?.action || meta.action === 'chat' || meta.action === 'deliberate';
    if (isDialogueAction && founderTurnCount >= 1) {
      return this._generateDialogueFollowUp(agentId, { ventureName, phase, founderAnswer, founderTurnCount }, meta);
    }

    // Dynamic Context Chaining Prefix
    const chainingPrefix = (meta?.priorSpeakers && meta.priorSpeakers.length > 0)
      ? `*I have reviewed the remarks from ${meta.priorSpeakers.join(' and ')}.* Building on their arguments while sharpening the key risks:\n\n`
      : '';

    const userEcho = lastUserMessage
      ? `Regarding your point on *"${lastUserMessage.slice(0, 80)}${lastUserMessage.length > 80 ? '...' : ''}"* — we must dissect this carefully.`
      : `Looking closely at the fundamental positioning for **${ventureName}** in this **${phase}** review:`;

    switch (agentId) {
      case 'maya':
        return `### Chief Innovation Officer Analysis — ${ventureName}

${chainingPrefix}${userEcho}

Most competitors in this space make the fatal mistake of optimizing existing workflows by 15%. That is an incumbent's game. To achieve asymmetric traction in **${ventureName}**, we need an analogical shift—borrowing distribution mechanics from adjacent high-velocity verticals.

Consider how logistics networks decoupled dispatch from asset ownership. If we treat our core offering not as monolithic software, but as a frictionless micro-utility, the customer's barrier to adoption drops to zero.

#### Strategic Reframes for ${phase}:
1. **The Inverted Workflow**: What if instead of asking operators to adopt a new dashboard, we embed our outputs directly into their existing messaging pipelines?
2. **The Contrarian Wedge**: Where does the current market consensus assume manual intervention is necessary, but deterministic automation can deliver a 10x delta?

**Direct inquiry for the founder:**
What is the single operational truth about your customers' daily frustration that legacy vendors refuse to acknowledge?`;

      case 'david':
        return `### Validation Partner Audit — ${ventureName}

${userEcho}

I will be blunt: enthusiasm is not traction. Verbal commitments and polite user survey responses are statistically meaningless. In this **${phase}** milestone for **${ventureName}**, our mandate is to falsify assumptions before capital is burned.

Every unvalidated assumption in your pitch represents unpriced downside risk. We need a rigorous, time-boxed smoke test with unambiguous kill criteria.

#### Falsifiable Hypothesis & Kill Criterion:
- **Core Hypothesis**: At least 4 out of 10 prospective enterprise buyers will execute a binding, refundable $500 pilot letter of intent within 14 calendar days of reviewing our 3-page scope document.
- **Explicit Kill Criterion**: If fewer than 3 signed letters of intent are secured after 12 qualified prospect pitches, we immediately halt development and pivot the primary value proposition.

**Direct inquiry for the founder:**
What specific empirical evidence do you hold *today* that demonstrates a customer has committed non-refundable time or budget?`;

      case 'priya':
        return `### Operational Architecture & Moat Review — ${ventureName}

${userEcho}

Vision without an operational cadence is expensive speculation. For **${ventureName}** to scale smoothly through **${phase}**, we must engineer repeatability into our delivery mechanics and construct structural moats that compound with volume.

If our delivery cycle requires bespoke manual configuration for each new account, our unit throughput collapses as volume increases.

#### 90-Day Execution Cadence:
1. **Days 1–30 (Standardized Onboarding)**: Compress client integration from 14 days down to sub-48 hours by eliminating custom API shims.
2. **Days 31–60 (SLA & Vendor Redundancy)**: Establish automated failover triggers across our cloud compute pipelines to guarantee 99.8% uptime during peak loads.
3. **Days 61–90 (Data Flywheel)**: Instrument telemetry loops so each completed transaction trains our predictive scheduling models, widening our competitive moat.

**Operational checkpoint:**
What is the primary operational dependency in our delivery stack that will break if transaction volume increases 5x next month?`;

      case 'marcus':
        return `### Go-To-Market & Growth Architecture — ${ventureName}

${userEcho}

If your messaging attempts to speak to every stakeholder in the enterprise, your customer acquisition cost will consume your margin. In this **${phase}** sprint for **${ventureName}**, we must define a razor-sharp wedge persona.

We do not win by out-spending established players on paid acquisition. We win through narrative asymmetry—positioning the status quo as active operational negligence.

#### GTM Wedge Strategy:
- **The Ideal Customer Profile (ICP)**: Operations directors managing 20+ distributed units who are held personally accountable for margin slippage.
- **The Core Antagonist**: Bloated enterprise software suites that demand six-figure implementation fees and 12-month lock-in.
- **Repeatable Wedge Channel**: Direct programmatic outreach delivering personalized ROI calculators benchmarking their specific facility inefficiencies.

**Growth inquiry for the founder:**
What is the exact sentence you put on the hero section of your landing page that makes an operations leader immediately forward it to their CFO?`;

      case 'elena':
        return `### CFO Financial Discipline & Unit Economics — ${ventureName}

${userEcho}

Let us examine the cold arithmetic. Revenue is vanity; contribution margin is sanity; cash runway is oxygen. In evaluating **${ventureName}** at the **${phase}** stage, I cannot endorse financial projections predicated on hand-waved SaaS margins.

When you factor in third-party API compute, onboarding support, and sales commissions, what is the *true* marginal contribution of account number fifty?

#### Financial Stress-Test:
- **Gross Margin Floor**: We must maintain a non-negotiable 78% gross margin floor. If custom onboarding requires more than 6 hours of engineer time per customer, our model degrades into professional services.
- **Payback Window**: Fully-loaded CAC payback must settle under 8 months to maintain an 18-month runway buffer without requiring emergency dilutive financing.
- **Churn Sensitivity**: A 1.5% increase in monthly logo churn expands our capital requirements by $350,000 over the next four quarters.

**Financial probe for the founder:**
What is our marginal cost to service the hundredth customer versus the first customer?`;

      case 'sam':
        return `### Customer Advocate & Product Scope Audit — ${ventureName}

${userEcho}

I am here to represent the actual human being who has to use this software on a stressful Tuesday afternoon. For **${ventureName}** to earn authentic product-market fit during this **${phase}** stage, we must eliminate cognitive friction.

Right now, our proposed workflow asks too much of the user upfront. If the customer does not experience their primary 'aha' moment within the first four minutes of account creation, our activation rate will plummet below 20%.

#### Product Scope Cuts:
1. **Kill Feature Bloat**: Remove the secondary configuration wizard and analytics export tab from the MVP release.
2. **One Primary Action**: Ensure the user has exactly one clear, high-contrast button to click after signing in.
3. **Frictionless Handoff**: Automate the data ingestion step so the user sees live, relevant output before being asked to invite team members.

**Product inquiry for the founder:**
Where in the current onboarding sequence do prospective users most frequently pause, ask questions, or hesitate?`;

      case 'chair':
        // Deliverable synthesis memo
        if (meta?.action === 'synthesize' || (system && system.includes('SYNTHESIS INSTRUCTIONS'))) {
          return `# Executive Boardroom Synthesis Memo — ${ventureName}

## Milestone Status: ${phase} Review

The board has convened to deliberate on the strategic posture of **${ventureName}**. Having reviewed the venture dossier and founder responses${lastUserMessage ? ` (including remarks on "${lastUserMessage.slice(0, 50)}...")` : ''}, the directors have arrived at unanimous consensus on critical stage-gate priorities.

### 1. Key Board Findings & Divergences
- **Innovation & Wedge (Maya Chen)**: The board agrees that targeting underserved regional operators provides our strongest asymmetric advantage against legacy incumbents.
- **Evidence Threshold (David Okafor)**: A strict validation gate is established—at least 3 signed letters of intent with refundable deposits are required before scaling engineering velocity.
- **Financial Hurdle (Elena Vasquez)**: The CFO has established a mandatory 78% gross margin floor to prevent dilution from service-heavy onboarding.

### 2. Immediate 30-Day Executive Directive
1. Execute the 14-day validation pilot sprint with strict kill criteria.
2. Strip secondary product modules to compress user time-to-first-value to under four minutes.
3. Finalize the 90-day operational delivery sequence to eliminate single points of failure.

*Respectfully submitted on behalf of the Board of Directors,*  
**The Chair (Chief of Staff)**`;
        }

        // Deliberation opening / moderation
        return `### Chief of Staff Opening — ${ventureName}

${userEcho}

The floor is open for **${phase}** review. As Chair, I direct the founder's statement to the quorum. 

Directors, please present your analytical assessments, challenge unverified premises, and isolate the critical path for **${ventureName}**.`;

      default:
        return `### Board Advisory Analysis — ${ventureName}

${userEcho}

Deliberating on the **${phase}** milestone for **${ventureName}**: our primary responsibility is to ensure that early validation signals translate into a defensible, unit-economic positive business architecture.

We recommend focusing all available bandwidth on resolving the highest-risk assumption currently facing the venture before capital is deployed to secondary growth channels.

**Next Action Step:** Formulate two falsifiable customer commitment benchmarks and audit contribution margins on initial pilot accounts.`;
    }
  }

  /**
   * Generate a dialogue-aware follow-up turn: react to the founder's latest answer and
   * escalate with the next Socratic question. Keeps the founder ↔ board loop alive.
   */
  _generateDialogueFollowUp(agentId, { ventureName, phase, founderAnswer, founderTurnCount }, meta = {}) {
    const ladder = SOCRATIC_LADDERS[agentId] || SOCRATIC_LADDERS.director;
    const turnIndex = Math.max(0, (founderTurnCount || 1) - 1);
    const framing = ladder.framings[Math.min(turnIndex, ladder.framings.length - 1)];
    const question = ladder.questions[Math.min(turnIndex, ladder.questions.length - 1)];

    const answer = (founderAnswer || '').trim();
    const answerQuote = answer
      ? `> **Your answer:** "${answer.slice(0, 220)}${answer.length > 220 ? '...' : ''}"\n\n`
      : '';

    const chainingPrefix = (meta?.priorSpeakers && meta.priorSpeakers.length > 0)
      ? `*Building on what ${meta.priorSpeakers.join(' and ')} just argued:*\n\n`
      : '';

    const progressNote = turnIndex >= 1
      ? `\n\n*We are ${turnIndex + 1} turns deep in this thread — I am tracking your answers, not restarting the briefing.*`
      : '';

    return `### ${ladder.header} — ${ventureName}

${chainingPrefix}${answerQuote}${framing}

${question}${progressNote}

**Over to you, founder** — answer this and I will take the analysis one level deeper.`;
  }

  async *stream({ system, messages, signal, meta }) {
    const agentId = this._detectAgentId(meta, system);
    const context = this._extractContextDetails(meta, system, messages);
    const fullText = this._generatePersonaResponse(agentId, context, meta, system);

    // Split into realistic small word/punctuation chunks
    const chunks = fullText.split(/(\s+)/);

    for (const chunk of chunks) {
      if (signal && signal.aborted) {
        throw new DOMException('Operation aborted by user', 'AbortError');
      }

      yield chunk;

      // Realistic typing simulation delay: 30-60ms with small random jitter
      const delay = 30 + Math.floor(Math.random() * 30);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  async complete({ system, messages, signal, meta }) {
    let full = '';
    for await (const chunk of this.stream({ system, messages, signal, meta })) {
      full += chunk;
    }
    return full;
  }
}

/**
 * PROVIDER 2: OpenAI-Compatible Provider
 * Configurable baseURL (default https://api.openai.com/v1), model, key, SSE streaming, AbortSignal
 */
export class OpenAIProvider {
  constructor(config = {}) {
    this.name = 'openai';
    this.baseURL = (config.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey = config.apiKey || '';
    this.model = config.model || 'gpt-4o';
    this.temperature = config.temperature !== undefined ? config.temperature : 0.7;
    this.maxTokens = config.maxTokens || 2048;
  }

  validateConfig() {
    if (!this.apiKey || this.apiKey.trim() === '') {
      return { ok: false, message: 'OpenAI API key is missing. Configure it in Settings.' };
    }
    return { ok: true, message: `Configured for ${this.model} via ${this.baseURL}.` };
  }

  async *stream({ system, messages, temperature, maxTokens, signal }) {
    const valid = this.validateConfig();
    if (!valid.ok) throw new Error(valid.message);

    const temp = temperature !== undefined ? temperature : this.temperature;
    const tokens = maxTokens || this.maxTokens;
    const url = `${this.baseURL}/chat/completions`;

    const bodyPayload = {
      model: this.model,
      messages: formatOpenAIMessages(system, messages),
      stream: true,
      temperature: temp,
      max_tokens: tokens
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey.trim()}`
      },
      body: JSON.stringify(bodyPayload),
      signal
    });

    if (!response.ok) {
      let errText = '';
      try {
        const errJson = await response.json();
        errText = errJson.error?.message || response.statusText;
      } catch (e) {
        errText = await response.text();
      }
      throw new Error(`OpenAI API Error (${response.status}): ${errText}`);
    }

    const chunkExtractor = (dataStr) => {
      try {
        const parsed = JSON.parse(dataStr);
        return parsed.choices?.[0]?.delta?.content || '';
      } catch (err) {
        return '';
      }
    };

    yield* parseSSEStream(response, chunkExtractor, signal);
  }

  async complete({ system, messages, temperature, maxTokens, signal }) {
    let full = '';
    for await (const chunk of this.stream({ system, messages, temperature, maxTokens, signal })) {
      full += chunk;
    }
    return full;
  }
}

/**
 * PROVIDER 3: Anthropic Provider
 * /v1/messages with x-api-key & anthropic-dangerous-direct-browser-access
 */
export class AnthropicProvider {
  constructor(config = {}) {
    this.name = 'anthropic';
    this.baseURL = (config.baseURL || 'https://api.anthropic.com').replace(/\/+$/, '');
    this.apiKey = config.apiKey || '';
    this.model = config.model || 'claude-3-7-sonnet-20250219';
    this.temperature = config.temperature !== undefined ? config.temperature : 0.7;
    this.maxTokens = config.maxTokens || 2048;
  }

  validateConfig() {
    if (!this.apiKey || this.apiKey.trim() === '') {
      return { ok: false, message: 'Anthropic API key is missing. Configure it in Settings.' };
    }
    return { ok: true, message: `Configured for ${this.model} via ${this.baseURL}.` };
  }

  async *stream({ system, messages, temperature, maxTokens, signal }) {
    const valid = this.validateConfig();
    if (!valid.ok) throw new Error(valid.message);

    const temp = temperature !== undefined ? temperature : this.temperature;
    const tokens = maxTokens || this.maxTokens;
    const url = `${this.baseURL}/v1/messages`;

    const bodyPayload = {
      model: this.model,
      messages: formatAnthropicMessages(messages),
      max_tokens: tokens,
      temperature: temp,
      stream: true
    };

    if (system) {
      bodyPayload.system = system;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey.trim(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(bodyPayload),
      signal
    });

    if (!response.ok) {
      let errText = '';
      try {
        const errJson = await response.json();
        errText = errJson.error?.message || response.statusText;
      } catch (e) {
        errText = await response.text();
      }
      throw new Error(`Anthropic API Error (${response.status}): ${errText}`);
    }

    const chunkExtractor = (dataStr) => {
      try {
        const parsed = JSON.parse(dataStr);
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          return parsed.delta.text;
        }
        return '';
      } catch (err) {
        return '';
      }
    };

    yield* parseSSEStream(response, chunkExtractor, signal);
  }

  async complete({ system, messages, temperature, maxTokens, signal }) {
    let full = '';
    for await (const chunk of this.stream({ system, messages, temperature, maxTokens, signal })) {
      full += chunk;
    }
    return full;
  }
}

/**
 * PROVIDER 4: Google Gemini Provider
 */
export class GeminiProvider {
  constructor(config = {}) {
    this.name = 'gemini';
    this.apiKey = config.apiKey || '';
    this.model = config.model || 'gemini-3.8-flash';
    this.temperature = config.temperature !== undefined ? config.temperature : 0.7;
    this.maxTokens = config.maxTokens || 2048;
  }

  validateConfig() {
    if (!this.apiKey || this.apiKey.trim() === '') {
      return { ok: false, message: 'Gemini API key is missing. Configure it in Settings.' };
    }
    return { ok: true, message: `Configured for ${this.model}.` };
  }

  async *stream({ system, messages, temperature, maxTokens, signal }) {
    const valid = this.validateConfig();
    if (!valid.ok) throw new Error(valid.message);

    const temp = temperature !== undefined ? temperature : this.temperature;
    const tokens = maxTokens || this.maxTokens;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey.trim())}`;

    const bodyPayload = {
      contents: formatGeminiContents(messages),
      generationConfig: {
        temperature: temp,
        maxOutputTokens: tokens
      }
    };

    if (system) {
      bodyPayload.systemInstruction = {
        parts: [{ text: system }]
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyPayload),
      signal
    });

    if (!response.ok) {
      let errText = '';
      try {
        const errJson = await response.json();
        errText = errJson.error?.message || response.statusText;
      } catch (e) {
        errText = await response.text();
      }
      throw new Error(`Gemini API Error (${response.status}): ${errText}`);
    }

    const chunkExtractor = (dataStr) => {
      try {
        const parsed = JSON.parse(dataStr);
        return parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
      } catch (err) {
        return '';
      }
    };

    yield* parseSSEStream(response, chunkExtractor, signal);
  }

  async complete({ system, messages, temperature, maxTokens, signal }) {
    let full = '';
    for await (const chunk of this.stream({ system, messages, temperature, maxTokens, signal })) {
      full += chunk;
    }
    return full;
  }
}

/**
 * Registry of Provider Constructors
 */
export const PROVIDERS = {
  mock: MockProvider,
  openai: OpenAIProvider,
  anthropic: AnthropicProvider,
  gemini: GeminiProvider,
};

/**
 * Resolve the active provider from stored settings (Default: mock)
 */
export async function getProvider() {
  const activeType = await getSetting('llm_provider_type', 'mock');

  if (activeType === 'openai') {
    const baseURL = await getSetting('openai_base_url', 'https://api.openai.com/v1');
    const apiKey = await getSetting('openai_api_key', await getSetting('llm_api_key', ''));
    const model = await getSetting('openai_model', 'gpt-4o');
    const temperature = parseFloat(await getSetting('llm_temperature', '0.7'));
    const maxTokens = parseInt(await getSetting('llm_max_tokens', '2048'), 10);
    return new OpenAIProvider({ baseURL, apiKey, model, temperature, maxTokens });
  }

  if (activeType === 'anthropic') {
    const baseURL = await getSetting('anthropic_base_url', 'https://api.anthropic.com');
    const apiKey = await getSetting('anthropic_api_key', await getSetting('llm_api_key', ''));
    const model = await getSetting('anthropic_model', 'claude-3-7-sonnet-20250219');
    const temperature = parseFloat(await getSetting('llm_temperature', '0.7'));
    const maxTokens = parseInt(await getSetting('llm_max_tokens', '2048'), 10);
    return new AnthropicProvider({ baseURL, apiKey, model, temperature, maxTokens });
  }

  if (activeType === 'gemini') {
    const apiKey = await getSetting('gemini_api_key', await getSetting('llm_api_key', ''));
    const model = await getSetting('gemini_model', 'gemini-3.8-flash');
    const temperature = parseFloat(await getSetting('llm_temperature', '0.7'));
    const maxTokens = parseInt(await getSetting('llm_max_tokens', '2048'), 10);
    return new GeminiProvider({ apiKey, model, temperature, maxTokens });
  }

  // Default: Mock Provider
  return new MockProvider();
}

/**
 * Universal Stream caller: resolves active provider and streams chunks
 */
export async function* stream(options = {}) {
  const provider = await getProvider();
  yield* provider.stream(options);
}

/**
 * Universal Complete caller: resolves active provider and resolves full text
 */
export async function complete(options = {}) {
  const provider = await getProvider();
  return await provider.complete(options);
}

/**
 * Validate configuration of the active provider
 */
export async function validateConfig() {
  const provider = await getProvider();
  return provider.validateConfig();
}

/**
 * Test Connection ping (1-token test)
 */
export async function testConnection(providerInstance = null) {
  const provider = providerInstance || await getProvider();
  const startTime = performance.now();

  try {
    const valid = provider.validateConfig();
    if (!valid.ok) {
      return { ok: false, latencyMs: 0, message: valid.message };
    }

    if (provider.name === 'mock') {
      await new Promise(r => setTimeout(r, 60));
      return {
        ok: true,
        latencyMs: Math.round(performance.now() - startTime),
        message: 'Mock engine ready. Instant deterministic streaming operational (no network/keys).'
      };
    }

    // Live ping: send 1-token test prompt with 10s timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const result = await provider.complete({
      system: 'Output exactly one word: OK',
      messages: [{ role: 'user', content: 'Ping' }],
      maxTokens: 5,
      temperature: 0.1,
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const latencyMs = Math.round(performance.now() - startTime);

    return {
      ok: true,
      latencyMs,
      message: `Connection successful (${latencyMs}ms). Response: "${result.trim().slice(0, 30)}"`
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - startTime);
    return {
      ok: false,
      latencyMs,
      message: err.name === 'AbortError' ? 'Connection timed out after 10 seconds.' : err.message
    };
  }
}
