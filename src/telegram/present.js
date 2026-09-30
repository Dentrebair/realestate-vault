// Sends a search result to the chat as cards. Returns the properties shown, in order.
import { loadPhotos } from '../photos.js';
import { CAPTION_LIMIT, cardKeyboard, moreKeyboard, renderCard } from './cards.js';
import { log } from './log.js';

// One property card. With photos it is the cover photo, captioned, with buttons to step through the rest.
// If Telegram cannot fetch the photo, the card is still sent, as text.
export async function sendCard(api, chatId, view, { saved = false, photos = [] } = {}) {
  if (photos.length) {
    try {
      await api.sendPhoto(chatId, photos[0].url, {
        caption: renderCard(view, { maxLength: CAPTION_LIMIT }),
        parse_mode: 'HTML',
        reply_markup: cardKeyboard(view.id, { saved, photo: { index: 0, total: photos.length } })
      });
      return;
    } catch (error) {
      log('photo_failed', { propertyId: view.id, error: error.message }, 'error');
    }
  }
  await api.sendMessage(chatId, renderCard(view), {
    parse_mode: 'HTML',
    reply_markup: cardKeyboard(view.id, { saved }),
    link_preview_options: { is_disabled: true }
  });
}

export async function sendSearchResult({ api, supabase, chatId, result, lead }) {
  const saved = new Set(lead?.shortlistedPropertyIds ?? []);
  const views = result.results.length ? result.results : result.recommendations;
  const photos = await loadPhotos(supabase, views.map((v) => v.id)).catch((error) => {
    log('photos_unavailable', { error: error.message }, 'error');
    return new Map();
  });

  for (const view of views) {
    await sendCard(api, chatId, view, { saved: saved.has(view.id), photos: photos.get(view.id) ?? [] });
  }
  if (result.nextOffset !== null && result.nextOffset !== undefined) {
    await api.sendMessage(chatId, `Showing ${result.nextOffset} of ${result.totalMatches}.`, {
      reply_markup: moreKeyboard()
    });
  }
  return views;
}

// What the bot remembers about a result so "the second one" and "show more" work next turn.
export function rememberShown(views) {
  return views.map((v) => ({ id: v.id, title: v.title, location: v.location, priceDisplay: v.priceDisplay }));
}
