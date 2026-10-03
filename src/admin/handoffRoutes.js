// The Requests tab: what the bot passed to the team, the conversation about each, and replying from the board.
import { config as appConfig } from '../config.js';
import { OPEN, countOpen, getHandoff, getThread, listHandoffs, setStatus } from '../handoff.js';
import { replyToCustomer } from '../telegram/handoff.js';
import { recordAccess } from './audit.js';

const MAX_REPLY = 1500;

// `telegram` is { api, config } so a reply from the board can reach the customer; without it replies are only saved.
export function mountHandoffRoutes(router, { supabase, requireStaff, requireJson, telegram = null }) {
  const titlesFor = async (ids) => {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const { data } = await supabase.from(appConfig.propertiesTable).select('property_id,title,location').in('property_id', unique);
    return new Map((data ?? []).map((p) => [p.property_id, p]));
  };

  router.get('/api/handoffs', requireStaff('admin'), async (request, response, next) => {
    try {
      const status = ['open', 'resolved'].includes(request.query.status) ? request.query.status : null;
      const all = await listHandoffs(supabase, { status });
      const requests = request.query.tests === '0' ? all.filter((h) => !h.isTest) : all;
      const titles = await titlesFor(requests.map((h) => h.propertyId));
      response.json({
        requests: requests.map((h) => ({ ...h, propertyTitle: titles.get(h.propertyId)?.title ?? null })),
        open: await countOpen(supabase)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/handoffs/:id', requireStaff('admin'), async (request, response, next) => {
    try {
      const handoff = await getHandoff(supabase, Number(request.params.id));
      if (!handoff) return response.status(404).json({ error: 'not_found' });
      const thread = await getThread(supabase, handoff.id);
      // The thread is what the customer wrote, so opening it is logged like opening a conversation.
      await recordAccess(supabase, { staffEmail: request.staff.email, customerId: handoff.customerId, conversation: true })
        .catch((error) => console.error('Could not write the access log:', error.message));
      response.json({ request: handoff, thread });
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/handoffs/:id/reply', requireJson, requireStaff('admin'), async (request, response, next) => {
    try {
      const text = String(request.body?.text ?? '').trim();
      if (text.length < 1 || text.length > MAX_REPLY) {
        return response.status(400).json({ error: 'invalid_reply', message: `Write a reply of up to ${MAX_REPLY} characters.` });
      }
      const handoff = await getHandoff(supabase, Number(request.params.id));
      if (!handoff) return response.status(404).json({ error: 'not_found' });

      if (!telegram?.api) {
        return response.status(503).json({ error: 'telegram_unavailable', message: 'Telegram is not connected, so the reply cannot be sent.' });
      }
      const result = await replyToCustomer({ deps: { supabase, api: telegram.api, config: telegram.config }, handoff, text, by: request.staff.email, via: 'board' });
      return response.json({ delivered: result.delivered, reason: result.reason });
    } catch (error) {
      return next(error);
    }
  });

  for (const [action, status] of [['resolve', 'resolved'], ['reopen', 'open']]) {
    router.post(`/api/handoffs/:id/${action}`, requireStaff('admin'), async (request, response, next) => {
      try {
        const handoff = await setStatus(supabase, Number(request.params.id), status, request.staff.email);
        return handoff ? response.json({ request: handoff }) : response.status(404).json({ error: 'not_found' });
      } catch (error) {
        return next(error);
      }
    });
  }
}

export { OPEN };
