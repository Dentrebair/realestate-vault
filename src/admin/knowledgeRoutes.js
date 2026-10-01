// The Knowledge tab: what the assistant could not answer, and the answers the owners approve.
import { config } from '../config.js';
import { answerGap, deleteEntry, dismissGap, listEntries, listGapGroups, updateEntry } from '../knowledge.js';
import { TOPICS } from '../telegram/facts.js';

const topicLabel = (key) => TOPICS.find((t) => t.key === key)?.label ?? null;
const MAX_ANSWER = 1000;

export function mountKnowledgeRoutes(router, { supabase, requireStaff, requireJson }) {
  // Titles for the properties that gaps and entries are about.
  const titlesFor = async (ids) => {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const { data, error } = await supabase.from(config.propertiesTable).select('property_id,title,location').in('property_id', unique);
    if (error) throw error;
    return new Map(data.map((p) => [p.property_id, p]));
  };

  const validAnswer = (value) => typeof value === 'string' && value.trim().length >= 2 && value.trim().length <= MAX_ANSWER;

  router.get('/api/knowledge/gaps', requireStaff(), async (request, response, next) => {
    try {
      const status = ['open', 'answered', 'dismissed'].includes(request.query.status) ? request.query.status : 'open';
      const groups = await listGapGroups(supabase, { status, includeTests: request.query.tests !== '0' });
      const titles = await titlesFor(groups.map((g) => g.propertyId));
      response.json({
        gaps: groups.map((g) => ({
          ...g,
          topicLabel: topicLabel(g.topic),
          propertyTitle: titles.get(g.propertyId)?.title ?? null
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/knowledge/gaps/:id/answer', requireJson, requireStaff('admin'), async (request, response, next) => {
    try {
      if (!validAnswer(request.body?.answer)) {
        return response.status(400).json({ error: 'invalid_answer', message: `Write an answer of up to ${MAX_ANSWER} characters.` });
      }
      const entry = await answerGap(supabase, Number(request.params.id), { answer: request.body.answer, by: request.staff.email });
      if (!entry) return response.status(404).json({ error: 'not_found' });
      return response.status(201).json({ entry });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/api/knowledge/gaps/:id/dismiss', requireStaff('admin'), async (request, response, next) => {
    try {
      const done = await dismissGap(supabase, Number(request.params.id));
      return done ? response.json({ ok: true }) : response.status(404).json({ error: 'not_found' });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/api/knowledge/entries', requireStaff(), async (_request, response, next) => {
    try {
      const entries = await listEntries(supabase);
      const titles = await titlesFor(entries.map((e) => e.property_id));
      response.json({
        entries: entries.map((e) => ({
          id: e.id, scope: e.scope, topic: e.topic, topicLabel: topicLabel(e.topic), area: e.area, propertyId: e.property_id,
          propertyTitle: titles.get(e.property_id)?.title ?? null, question: e.question, answer: e.answer, active: e.active,
          servedCount: e.served_count, lastServedAt: e.last_served_at, createdBy: e.created_by, updatedAt: e.updated_at
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/api/knowledge/entries/:id', requireJson, requireStaff('admin'), async (request, response, next) => {
    try {
      const { answer, active } = request.body ?? {};
      if (answer !== undefined && !validAnswer(answer)) return response.status(400).json({ error: 'invalid_answer' });
      if (active !== undefined && typeof active !== 'boolean') return response.status(400).json({ error: 'invalid_active' });
      const entry = await updateEntry(supabase, Number(request.params.id), { answer, active });
      return entry ? response.json({ entry }) : response.status(404).json({ error: 'not_found' });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/api/knowledge/entries/:id', requireStaff('admin'), async (request, response, next) => {
    try {
      const done = await deleteEntry(supabase, Number(request.params.id));
      return done ? response.json({ ok: true }) : response.status(404).json({ error: 'not_found' });
    } catch (error) {
      return next(error);
    }
  });
}
