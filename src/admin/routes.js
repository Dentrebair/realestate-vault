import { fileURLToPath } from 'node:url';
import express from 'express';
import { setStage } from '../leadMemory.js';
import { STAGES } from '../stages.js';
import { clearSessionCookies, createLoginLimiter, setSessionCookies, staffFromRequest } from './auth.js';
import { listAccess, recordAccess } from './audit.js';
import { getBoard, getDemand, getLeadDetail } from './board.js';
import { mountHandoffRoutes } from './handoffRoutes.js';
import { mountKnowledgeRoutes } from './knowledgeRoutes.js';
import { mountPhotoRoutes } from './photoRoutes.js';
import { mountVisitRoutes } from './visitRoutes.js';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));

// `auth` checks passwords and sessions; `showConversations` is 'test', 'all' or 'none'.
export function createAdminRouter({ supabase, auth, showConversations = 'test', secureCookies = false, limiter = createLoginLimiter(), telegram = null }) {
  const router = express.Router();
  const cookieOptions = { secure: secureCookies };

  const showConversation = (lead) =>
    showConversations === 'all' || (showConversations === 'test' && lead.is_test === true);

  // The page and its scripts are public; everything under /api needs a signed-in staff member.
  router.use(express.static(publicDir, { index: 'index.html' }));

  router.post('/api/login', requireJson, async (request, response, next) => {
    try {
      const email = String(request.body?.email ?? '').trim().toLowerCase();
      const password = String(request.body?.password ?? '');
      const key = `${request.ip}|${email}`;

      if (limiter.blocked(key)) {
        return response.status(429).json({ error: 'too_many_attempts', message: 'Too many attempts. Try again later.' });
      }
      const session = email && password ? await auth.signIn(email, password) : null;
      if (!session) {
        limiter.fail(key);
        return response.status(401).json({ error: 'invalid_login', message: 'Email or password is not right.' });
      }

      const { data: staff, error } = await supabase.from('staff').select('role,email').eq('user_id', session.user.id).maybeSingle();
      if (error) throw error;
      if (!staff) {
        return response.status(403).json({ error: 'not_staff', message: 'This account is not allowed to use the board.' });
      }

      limiter.clear(key);
      setSessionCookies(response, session, cookieOptions);
      return response.json({ email: staff.email ?? session.user.email, role: staff.role });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/api/logout', (_request, response) => {
    clearSessionCookies(response, cookieOptions);
    response.json({ ok: true });
  });

  const requireStaff = (role) => async (request, response, next) => {
    try {
      const { user, notStaff } = await staffFromRequest({ request, response, auth, supabase, secure: secureCookies });
      if (!user) {
        return response.status(notStaff ? 403 : 401).json({ error: notStaff ? 'not_staff' : 'unauthorized' });
      }
      if (role && user.role !== role) return response.status(403).json({ error: 'admin_only' });
      request.staff = user;
      return next();
    } catch (error) {
      return next(error);
    }
  };

  router.get('/api/me', requireStaff(), (request, response) => {
    response.json({ email: request.staff.email, role: request.staff.role, conversations: showConversations });
  });

  router.get('/api/board', requireStaff(), async (request, response, next) => {
    try {
      response.json(await getBoard(supabase, { includeTests: request.query.tests !== '0' }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/demand', requireStaff(), async (request, response, next) => {
    try {
      response.json(await getDemand(supabase, { includeTests: request.query.tests !== '0' }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/audit', requireStaff('admin'), async (_request, response, next) => {
    try {
      response.json({ entries: await listAccess(supabase) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/leads/:id', requireStaff(), async (request, response, next) => {
    try {
      const detail = await getLeadDetail(supabase, request.params.id, { showConversation, role: request.staff.role });
      if (!detail) return response.status(404).json({ error: 'not_found' });
      await recordAccess(supabase, {
        staffEmail: request.staff.email,
        customerId: detail.id,
        phone: detail.phone,
        conversation: detail.conversationVisible
      }).catch((error) => console.error('Could not write the access log:', error.message));
      return response.json(detail);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/api/leads/:id/stage', requireJson, requireStaff('admin'), async (request, response, next) => {
    try {
      const stage = request.body?.stage;
      if (!STAGES.includes(stage)) return response.status(400).json({ error: 'invalid_stage' });
      const reason = String(request.body?.reason ?? '').trim().slice(0, 200) || 'moved from the lead board';

      const result = await setStage(supabase, request.params.id, stage, {
        actor: 'board',
        reason,
        by: request.staff.email
      });
      return response.status(result.changed ? 200 : 409).json(result);
    } catch (error) {
      return next(error);
    }
  });

  mountPhotoRoutes(router, { supabase, requireStaff, requireJson });
  mountVisitRoutes(router, { supabase, requireStaff, requireJson });
  mountKnowledgeRoutes(router, { supabase, requireStaff, requireJson });
  mountHandoffRoutes(router, { supabase, requireStaff, requireJson, telegram });

  return router;
}

// Cookies are sent on cross-site form posts unless we insist on JSON, which a plain HTML form cannot send.
function requireJson(request, response, next) {
  if (!request.is('application/json')) return response.status(415).json({ error: 'json_required' });
  return next();
}
