import { getLead, setBotState, upsertLeadMemory } from '../leadMemory.js';

export const customerIdOf = (from) => `telegram:${from.id}`;

// The Lead for this Telegram user, created at `initiated` on first contact.
// When consent is required, a new Lead holds only their Telegram id until they agree: no name, no username.
export async function ensureLead(supabase, from, { source, config } = {}) {
  const customerId = customerIdOf(from);
  const existing = await getLead(supabase, customerId);
  if (existing) return existing;

  if (config?.requireConsent) {
    const created = await upsertLeadMemory(supabase, { customerId }, { actor: 'system' });
    if (source) await setBotState(supabase, customerId, { pendingSource: source });
    return getLead(supabase, created.lead.customerId);
  }

  const created = await upsertLeadMemory(
    supabase,
    {
      customerId,
      displayName: from.first_name || undefined,
      handle: from.username || undefined,
      source: source || undefined
    },
    { actor: 'system' }
  );
  return created.lead;
}
