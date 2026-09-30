import { createHash, timingSafeEqual } from 'node:crypto';
import { log } from './pipeline.js';

function sameSecret(given, expected) {
  if (!given || !expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

// Telegram retries any update that is not answered quickly, and a model turn can take many seconds.
// So: check the secret, answer 200 at once, and do the work afterwards.
export function webhookHandler(bot, secret) {
  return (request, response) => {
    if (!sameSecret(request.get('x-telegram-bot-api-secret-token'), secret)) {
      return response.status(401).json({ error: 'unauthorized' });
    }
    response.sendStatus(200);
    bot.handleUpdate(request.body).catch((error) => {
      log('update_failed', { updateId: request.body?.update_id, error: error.message }, 'error');
    });
  };
}
