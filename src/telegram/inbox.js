// Every Telegram update is written to the database before the bot answers "received". If the service stops in the
// middle of a reply (a crash, a deploy), the update is still there and is processed again on the next start.
// The update number is the primary key, so a repeat from Telegram is recognised even after a restart.
//
// Without the table (before sql/006 is run) the bot still works, with the older in-memory behaviour.
import { log } from './log.js';

const RECOVER_AFTER_MS = 2 * 60 * 1000;
const KEEP_DONE_MS = 7 * 24 * 3600 * 1000;

const tableMissing = (error) =>
  ['42P01', 'PGRST205'].includes(error?.code) || /does not exist|schema cache/i.test(error?.message ?? '');

export function createInbox({ supabase, now = () => Date.now() }) {
  let warned = false;
  const unavailable = (error) => {
    if (!warned) {
      warned = true;
      log('inbox_unavailable', { note: 'run sql/006_reliability.sql to make updates durable', error: error.message }, 'warn');
    }
    return 'unavailable';
  };

  return {
    // 'new', 'duplicate' or 'unavailable'. Any other database error is thrown, so the webhook can answer 500
    // and Telegram will send the update again.
    async accept(update) {
      const { error } = await supabase.from('telegram_updates').insert({ update_id: update.update_id, payload: update });
      if (!error) return 'new';
      if (error.code === '23505') return 'duplicate';
      if (tableMissing(error)) return unavailable(error);
      throw error;
    },

    // Never throws: a failure here only means the update may be processed once more after a restart.
    async done(updateId) {
      try {
        const { error } = await supabase
          .from('telegram_updates')
          .update({ status: 'done', payload: null, done_at: new Date(now()).toISOString() })
          .eq('update_id', updateId);
        if (error && !tableMissing(error)) log('inbox_done_failed', { updateId, error: error.message }, 'error');
      } catch (error) {
        log('inbox_done_failed', { updateId, error: error.message }, 'error');
      }
    },

    // Updates that were accepted but never finished, older than any turn that could still be running.
    async pending({ skip = new Set() } = {}) {
      const cutoff = new Date(now() - RECOVER_AFTER_MS).toISOString();
      const { data, error } = await supabase
        .from('telegram_updates')
        .select('update_id,payload')
        .eq('status', 'received')
        .lt('received_at', cutoff)
        .order('received_at', { ascending: true })
        .limit(50);
      if (error) {
        if (!tableMissing(error)) log('inbox_read_failed', { error: error.message }, 'error');
        return [];
      }
      return data.filter((row) => row.payload && !skip.has(row.update_id));
    },

    async cleanup() {
      const cutoff = new Date(now() - KEEP_DONE_MS).toISOString();
      const { error } = await supabase.from('telegram_updates').delete().eq('status', 'done').lt('done_at', cutoff);
      if (error && !tableMissing(error)) log('inbox_cleanup_failed', { error: error.message }, 'error');
    }
  };
}
