import { createHash, timingSafeEqual } from 'node:crypto';
import { log } from './log.js';

function sameSecret(given, expected) {
  if (!given || !expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

// Updates being worked on right now. A deploy waits for them (see drain) so a reply is not cut off.
const inFlight = new Set();

export function track(promise) {
  inFlight.add(promise);
  promise.finally(() => inFlight.delete(promise));
  return promise;
}

export async function drain(timeoutMs) {
  await Promise.race([Promise.allSettled([...inFlight]), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  return inFlight.size;
}

export const updatesInFlight = () => new Set([...inFlight].map((p) => p.updateId));

function handle(bot, inbox, update) {
  const work = bot
    .handleUpdate(update)
    .catch((error) => log('update_failed', { updateId: update?.update_id, error: error.message }, 'error'))
    .then(() => inbox?.done(update.update_id))
    .catch((error) => log('update_failed', { updateId: update?.update_id, error: error.message }, 'error'));
  work.updateId = update?.update_id;
  return track(work);
}

// Telegram retries any update that is not answered quickly, and a model turn can take many seconds.
// So: check the secret, write the update down, answer 200, and do the work afterwards.
// If the update cannot be written down we answer 500 and Telegram sends it again.
export function webhookHandler(bot, secret, inbox = null) {
  return async (request, response) => {
    if (!sameSecret(request.get('x-telegram-bot-api-secret-token'), secret)) {
      return response.status(401).json({ error: 'unauthorized' });
    }
    const update = request.body;
    if (inbox && update?.update_id !== undefined) {
      try {
        if ((await inbox.accept(update)) === 'duplicate') return response.sendStatus(200);
      } catch (error) {
        log('inbox_failed', { updateId: update.update_id, error: error.message }, 'error');
        return response.sendStatus(500);
      }
    }
    response.sendStatus(200);
    handle(bot, inbox, update);
  };
}

// Picks up updates that were accepted but never finished, for example because the service was stopped mid-reply.
export function startRecovery(bot, inbox, { everyMs = 60 * 1000 } = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      for (const row of await inbox.pending({ skip: updatesInFlight() })) {
        log('update_recovered', { updateId: row.update_id });
        await handle(bot, inbox, row.payload);
      }
    } catch (error) {
      log('recovery_failed', { error: error.message }, 'error');
    } finally {
      running = false;
    }
  };
  const first = setTimeout(run, 5000);
  const every = setInterval(run, everyMs);
  const cleanup = setInterval(() => inbox.cleanup(), 6 * 3600 * 1000);
  for (const timer of [first, every, cleanup]) timer.unref();
  return { run, stop: () => { clearTimeout(first); clearInterval(every); clearInterval(cleanup); } };
}
