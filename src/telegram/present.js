// Sends a search result to the chat as cards. Returns the properties shown, in order.
import { cardKeyboard, moreKeyboard, renderCard } from './cards.js';

export async function sendSearchResult(api, chatId, result, lead) {
  const saved = new Set(lead?.shortlistedPropertyIds ?? []);
  const views = result.results.length ? result.results : result.recommendations;

  for (const view of views) {
    await api.sendMessage(chatId, renderCard(view), {
      parse_mode: 'HTML',
      reply_markup: cardKeyboard(view.id, { saved: saved.has(view.id) }),
      link_preview_options: { is_disabled: true }
    });
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
