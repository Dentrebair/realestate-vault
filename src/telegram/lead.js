import { getLead, upsertLeadMemory } from '../leadMemory.js';

export const customerIdOf = (from) => `telegram:${from.id}`;

// The Lead for this Telegram user, created at `initiated` on first contact.
export async function ensureLead(supabase, from, { source } = {}) {
  const customerId = customerIdOf(from);
  const existing = await getLead(supabase, customerId);
  if (existing) return existing;

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
