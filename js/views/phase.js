/**
 * Phase Chamber View Module
 * Route: #/venture/:id/phase/:p
 * Re-routes to the full Venture Boardroom Chamber view for the specified phase.
 */
import { render as renderVenture } from './venture.js';

export async function render(container, params = {}) {
  return await renderVenture(container, {
    ...params,
    tab: 'boardroom',
    phase: params.phase || 'ideation'
  });
}

