import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { addToShortlist, getLead, setBotState, upsertLeadMemory } from '../src/leadMemory.js';
import { claimsVisitButton, guardAmounts, mentionUnavailable, moneyHint, withoutBackstage, withoutCardTapping, withoutDashes, withoutPhantomButtons, withoutPhotoClaims } from '../src/telegram/agent.js';
import { asksAboutPhotos, isNegotiation } from '../src/telegram/intent.js';
import { buildInstructions } from '../src/telegram/systemPrompt.js';
import { createBot } from '../src/telegram/bot.js';
import { CAPTION_LIMIT, renderCard } from '../src/telegram/cards.js';
import { FALLBACK, NON_TEXT, OFF_TOPIC, RATE_LIMITED, STALE_PROPERTY, TOO_LONG } from '../src/telegram/copy.js';
import { Cr, L, properties } from './fixtures/properties.js';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

const USER = 4242;
const SALES = 999;
const ID = `telegram:${USER}`;

// ---- harness ------------------------------------------------------------------------------

let counter = 1000;
const next = () => ++counter;
const person = (id = USER) => ({ id, is_bot: false, first_name: 'Asha', username: 'asha_k' });
const privateChat = (id = USER) => ({ id, type: 'private', first_name: 'Asha' });

const say = (text, id = USER) => ({
  update_id: next(),
  message: {
    message_id: next(),
    date: 0,
    chat: privateChat(id),
    from: person(id),
    text,
    ...(text.startsWith('/')
      ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] }
      : {})
  }
});

const tap = (data, id = USER, message = {}) => ({
  update_id: next(),
  callback_query: {
    id: String(next()),
    from: person(id),
    chat_instance: 'x',
    data,
    message: { message_id: 77, date: 0, chat: privateChat(id), text: 'card', ...message }
  }
});

const BOT_INFO = {
  id: 123, is_bot: true, first_name: 'Bot', username: 'testbot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false
};

function harness({ generate = async () => ({ text: 'ok' }), tables = {}, config = {}, failMethod = null } = {}) {
  const supabase = createFakeSupabase({ properties, ...tables });
  const calls = [];
  const bot = createBot({
    token: '123:test',
    botInfo: BOT_INFO,
    supabase,
    config: { salesDeskChatId: SALES, businessHours: 'Mon to Sat, 10am to 7pm', agentTimeoutMs: 5000, ...config },
    ai: { generate, model: {}, providerOptions: undefined }
  });
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload });
    if (method === failMethod) return { ok: false, error_code: 400, description: 'Bad Request: wrong file identifier/HTTP URL specified' };
    const result =
      method === 'sendMessage'
        ? { message_id: next(), date: 0, chat: privateChat(payload.chat_id), text: payload.text }
        : method === 'sendPhoto'
          ? { message_id: next(), date: 0, chat: privateChat(payload.chat_id), caption: payload.caption }
          : true;
    return { ok: true, result };
  });

  return {
    bot,
    supabase,
    calls,
    send: (update) => bot.handleUpdate(update),
    sent: (method = 'sendMessage') => calls.filter((c) => c.method === method).map((c) => c.payload),
    toUser: () => calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === USER).map((c) => c.payload),
    toSales: () => calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === SALES).map((c) => c.payload),
    rows: (table) => supabase.tables[table] ?? []
  };
}

const toolCall = { toolCallId: 't', messages: [] };
const buttons = (payload) => payload.reply_markup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? [];

async function seedLead(h, fields = {}, stage) {
  await upsertLeadMemory(h.supabase, { customerId: ID, displayName: 'Asha', ...fields }, { actor: 'system' });
  if (stage) h.supabase.tables.customer_leads.find((r) => r.customer_id === ID).lead_stage = stage;
}

// ---- /start and the welcome -----------------------------------------------------------------

test('/start creates the lead at initiated, records the campaign, and offers category buttons', async () => {
  const h = harness();
  await h.send(say('/start omr_ad1'));

  const lead = await getLead(h.supabase, ID);
  assert.equal(lead.leadStage, 'initiated');
  assert.equal(lead.source, 'omr_ad1');
  assert.equal(lead.displayName, 'Asha');
  assert.equal(lead.handle, 'asha_k');

  const [welcome] = h.toUser();
  assert.match(welcome.text, /Hi Asha!/);
  assert.match(welcome.text, /indicative and subject to verification/);
  assert.deepEqual(buttons(welcome), [
    'action:browse:residential', 'action:browse:commercial', 'action:browse:land',
    'action:browse:hospitality', 'action:browse:industrial'
  ]);
});

test('groups, duplicates and non-text messages', async () => {
  let asked = 0;
  const h = harness({ generate: async () => (asked++, { text: 'ok' }) });

  const group = say('show me flats');
  group.message.chat = { id: -5, type: 'group', title: 'g' };
  await h.send(group);
  assert.equal(h.calls.length, 0, 'group chats are ignored');

  const update = say('show me flats');
  await h.send(update);
  await h.send(update);
  assert.equal(asked, 1, 'a repeated update_id is processed once');

  const photo = { update_id: next(), message: { message_id: next(), date: 0, chat: privateChat(), from: person(), photo: [{ file_id: 'a', file_unique_id: 'b', width: 1, height: 1 }] } };
  await h.send(photo);
  assert.equal(h.toUser().at(-1).text, NON_TEXT);
});

// ---- a conversational turn ------------------------------------------------------------------

test('a search turn sends cards first, then the reply; saves requirements; moves the lead to interested', async () => {
  const h = harness({
    generate: async ({ tools }) => {
      await tools.save_requirements.execute(
        { maxBudget: { amount: 1.5, unit: 'crore' }, preferredLocations: ['OMR'], bedrooms: 3 },
        toolCall
      );
      await tools.search_properties.execute(
        { location: 'OMR', category: 'residential', bedrooms: 3, maxBudget: { amount: 1.5, unit: 'crore' } },
        toolCall
      );
      return { text: 'There is no exact match, but this is the closest option.', usage: { totalTokens: 10 } };
    }
  });

  await h.send(say('3BHK in OMR under 1.5 crore'));

  const messages = h.toUser();
  assert.equal(messages.length, 2);
  const [card, reply] = messages;
  assert.match(card.text, /Close option/);
  assert.match(card.text, /Navalur/);
  assert.match(card.text, /1 bedroom fewer \(2 instead of 3\)/);
  assert.match(card.text, /₹62 L/);
  assert.equal(card.parse_mode, 'HTML');
  assert.deepEqual(buttons(card), ['action:visit:p04', 'action:save:p04']);
  assert.equal(reply.text, 'There is no exact match, but this is the closest option.');

  assert.ok(h.sent('sendChatAction').some((a) => a.action === 'typing'));

  const lead = await getLead(h.supabase, ID);
  assert.equal(lead.leadStage, 'interested');
  assert.equal(lead.budgetMax, Cr(1.5));
  assert.deepEqual(lead.preferredLocations, ['OMR']);
  assert.deepEqual(lead.botState.shown.map((s) => s.id), ['p04']);

  assert.deepEqual(h.rows('chat_messages').map((m) => m.role), ['user', 'assistant']);
  assert.ok(h.rows('lead_events').some((e) => e.event_type === 'zero_result'));
});

test('the model never chooses whose lead it is', async () => {
  const other = 'telegram:777';
  const h = harness({
    generate: async ({ tools }) => {
      await tools.save_requirements.execute({ customerId: other, urgency: 'tomorrow' }, toolCall);
      return { text: 'Noted.' };
    }
  });
  await upsertLeadMemory(h.supabase, { customerId: other, displayName: 'Other' }, { actor: 'system' });
  await h.send(say('hello'));

  assert.equal((await getLead(h.supabase, other)).urgency, undefined);
  assert.equal((await getLead(h.supabase, ID)).urgency, 'tomorrow');
});

test('a saved budget carries into the next search without being asked again', async () => {
  const h = harness({
    generate: async ({ tools }) => {
      await tools.search_properties.execute({ category: 'residential' }, toolCall);
      return { text: 'Here are homes within your budget.' };
    }
  });
  await seedLead(h, { budgetMax: L(70), propertyCategories: ['residential'] });
  await h.send(say('show me homes'));

  const cards = h.toUser().slice(0, -1).map((m) => m.text).join('\n');
  assert.match(cards, /Navalur/);
  assert.doesNotMatch(cards, /Sky Mansion/, 'the ₹4.8 Cr flat is over the saved budget');
  assert.doesNotMatch(cards, /Penthouse/, 'sold listings are never shown');
});

test('a null-price listing never gets a number', async () => {
  const h = harness({
    generate: async ({ tools }) => {
      await tools.search_properties.execute({ category: 'residential', query: 'bungalow' }, toolCall);
      return { text: 'This one is price on request.' };
    }
  });
  await h.send(say('heritage bungalow in Alwarpet'));
  assert.match(h.toUser()[0].text, /Price on Request \(POR\)/);
});

test('an amount the model invents is replaced', async () => {
  assert.equal(guardAmounts('It costs ₹99 Cr.', ['₹4.8 Cr']).blocked, true);
  assert.equal(guardAmounts('It costs ₹4.8 Cr.', ['{"price":"₹4.8 Cr"}']).blocked, false);
  assert.equal(guardAmounts('Your budget of 1.5 crore is noted.', ['under 1.5 crore']).blocked, false);
  assert.equal(guardAmounts('Around 3 BHK homes.', []).blocked, false);

  const h = harness({ generate: async () => ({ text: 'That one is about ₹2 Cr.' }) });
  await h.send(say('what does the Alwarpet bungalow cost?'));
  assert.doesNotMatch(h.toUser().at(-1).text, /₹2 Cr/);
});

test('the model can ask about a property already shown, by position', async () => {
  let details;
  const h = harness({
    generate: async ({ tools }) => {
      await tools.search_properties.execute({ category: 'residential', bedrooms: 4 }, toolCall);
      details = await tools.get_property.execute({ position: 1 }, toolCall);
      return { text: 'Here you go.' };
    }
  });
  await h.send(say('4 bhk homes'));
  assert.equal(details.id, 'p03');
  assert.equal(details.price, '₹4.8 Cr');
});

test('request_site_visit sends a confirm button and does not change the stage', async () => {
  const h = harness({
    generate: async ({ tools }) => {
      await tools.search_properties.execute({ location: 'Tambaram', category: 'residential' }, toolCall);
      await tools.request_site_visit.execute({ position: 1 }, toolCall);
      return { text: 'Tap the button to confirm.' };
    }
  });
  await h.send(say('I want to see the flat in Tambaram'));

  const prompt = h.toUser().find((m) => /Would you like to visit/.test(m.text));
  assert.deepEqual(buttons(prompt), ['action:visit:p16']);
  assert.equal((await getLead(h.supabase, ID)).leadStage, 'interested');
});

test('the model can reach negotiating but not site_visit_ready', async () => {
  let blocked;
  const h = harness({
    generate: async ({ tools }) => {
      await tools.save_requirements.execute({ leadStage: 'negotiating', stageReason: 'asked for 10% off' }, toolCall);
      blocked = await tools.save_requirements.execute({ leadStage: 'site_visit_ready' }, toolCall).catch((e) => e);
      return { text: 'Our sales team handles pricing.' };
    }
  });
  await seedLead(h, { budgetMax: Cr(5) });
  await h.send(say('can you give me a 10% discount?'));

  assert.equal((await getLead(h.supabase, ID)).leadStage, 'negotiating');
  assert.ok(!(blocked instanceof Error));
});

test('if the model fails, the customer gets the fallback and the Sales desk is told', async () => {
  const h = harness({ generate: async () => { throw new Error('model timed out'); } });
  await h.send(say('show me flats'));

  assert.equal(h.toUser().at(-1).text, FALLBACK);
  assert.match(h.toSales()[0].text, /could not answer a customer/);
  assert.match(h.toSales()[0].text, /model timed out/);
});

// ---- guards ---------------------------------------------------------------------------------

test('off-topic first message: one polite line, then silence until they ask about property', async () => {
  let classified = 0;
  const h = harness({
    generate: async ({ instructions, prompt }) => {
      if (prompt) {
        classified++;
        return { text: 'NO' };
      }
      return { text: 'Sure, here are flats.' };
    }
  });

  await h.send(say('what is the weather today'));
  assert.equal(h.toUser().at(-1).text, OFF_TOPIC);
  const after = h.toUser().length;

  await h.send(say('tell me a joke'));
  assert.equal(h.toUser().length, after, 'no second reply');
  assert.equal(classified, 2);

  await h.send(say('show me flats in Anna Nagar'));
  assert.equal(h.toUser().at(-1).text, 'Sure, here are flats.');
});

test('greetings and property words are on topic without asking the model', async () => {
  let classified = 0;
  const h = harness({ generate: async ({ prompt }) => (prompt ? (classified++, { text: 'NO' }) : { text: 'Hello!' }) });
  await h.send(say('hi'));
  await h.send(say('looking for a 2bhk'));
  assert.equal(classified, 0);
  assert.equal(h.toUser().at(-1).text, 'Hello!');
});

test('if the scope check fails, the message is treated as on topic', async () => {
  const h = harness({
    generate: async ({ prompt }) => {
      if (prompt) throw new Error('classifier down');
      return { text: 'Happy to help.' };
    }
  });
  await h.send(say('umm what do you have'));
  assert.equal(h.toUser().at(-1).text, 'Happy to help.');
});

test('the 21st message in an hour is refused; long messages are refused', async () => {
  const h = harness({ generate: async () => ({ text: 'ok' }) });
  for (let i = 0; i < 20; i++) await h.send(say('hi'));
  await h.send(say('hi'));
  assert.equal(h.toUser().at(-1).text, RATE_LIMITED);

  const other = harness();
  await other.send(say('flat '.repeat(300)));
  assert.equal(other.toUser().at(-1).text, TOO_LONG);
});

// ---- buttons --------------------------------------------------------------------------------

test('Book Site Visit: sets site_visit_ready, records the property, alerts the Sales desk once', async () => {
  const h = harness();
  await seedLead(h, { budgetMax: L(70), preferredLocations: ['OMR'], urgency: 'this month' });

  await h.send(tap('action:visit:p04'));

  const lead = await getLead(h.supabase, ID);
  assert.equal(lead.leadStage, 'site_visit_ready');
  const requested = h.rows('lead_events').find((e) => e.event_type === 'site_visit_requested');
  assert.equal(requested.property_id, 'p04');
  assert.ok(requested.alerted_at, 'the alert is marked as sent');

  assert.match(h.toUser()[0].text, /Site visit request noted for High-Rise 2BHK Apartment/);
  assert.match(h.toUser()[0].text, /Mon to Sat, 10am to 7pm/);
  assert.ok(h.toUser().some((m) => /share your number/.test(m.text)), 'offers the share-number button');

  const [alert] = h.toSales();
  assert.match(alert.text, /Site visit requested/);
  assert.match(alert.text, /Asha/);
  assert.match(alert.text, /High-Rise 2BHK Apartment/);
  assert.match(alert.text, /₹62 L/);
  assert.match(alert.text, /OMR/);

  assert.equal(h.sent('answerCallbackQuery').length, 1);

  await h.send(tap('action:visit:p04'));
  assert.equal(h.toSales().length, 1, 'a second tap sends no second alert');
  assert.match(h.toUser().at(-1).text, /already asked to visit/);
});

test('an old card for a sold property cannot be booked', async () => {
  const h = harness();
  await seedLead(h, {});
  await h.send(tap('action:visit:p19'));

  assert.equal((await getLead(h.supabase, ID)).leadStage, 'initiated');
  assert.equal(h.toSales().length, 0);
  const answer = h.sent('answerCallbackQuery')[0];
  assert.equal(answer.text, STALE_PROPERTY);
  assert.equal(answer.show_alert, true);
});

test('Shortlist and remove: the button swaps, the lead moves to interested', async () => {
  const h = harness();
  await seedLead(h, {});

  await h.send(tap('action:save:p09'));
  assert.deepEqual((await getLead(h.supabase, ID)).shortlistedPropertyIds, ['p09']);
  assert.equal((await getLead(h.supabase, ID)).leadStage, 'interested');
  const saved = h.sent('editMessageReplyMarkup')[0];
  assert.deepEqual(saved.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['action:visit:p09', 'action:unsave:p09']);

  await h.send(tap('action:unsave:p09'));
  assert.deepEqual((await getLead(h.supabase, ID)).shortlistedPropertyIds, []);
  const removed = h.sent('editMessageReplyMarkup')[1];
  assert.deepEqual(removed.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['action:visit:p09', 'action:save:p09']);
});

test('quick-pick buttons list a category without the model', async () => {
  let asked = 0;
  const h = harness({ generate: async () => (asked++, { text: 'x' }) });
  await seedLead(h, {});
  await h.send(tap('action:browse:residential'));

  assert.equal(asked, 0);
  const texts = h.toUser().map((m) => m.text);
  assert.equal(texts.filter((t) => /Matches your requirements/.test(t)).length, 5);
  assert.match(texts.at(-1), /Tell me your budget/);
  assert.ok(texts.some((t) => /Showing 5 of/.test(t)));

  const lead = await getLead(h.supabase, ID);
  assert.equal(lead.botState.scope, 'on_topic');
  assert.equal(lead.leadStage, 'interested');
});

test('Show more continues from where the last search stopped', async () => {
  const h = harness();
  await seedLead(h, {});
  await h.send(tap('action:browse:residential'));
  const firstPage = h.toUser().filter((m) => /Matches your requirements/.test(m.text)).map((m) => m.text);

  await h.send(tap('action:more'));
  const all = h.toUser().filter((m) => /Matches your requirements/.test(m.text)).map((m) => m.text);
  assert.ok(all.length > firstPage.length);
  assert.equal(new Set(all.map((t) => t.split('\n')[1])).size, all.length, 'no property repeated');
});

// ---- commands -------------------------------------------------------------------------------

test('/saved lists the shortlist and says when a saved property has sold', async () => {
  const h = harness();
  await seedLead(h, {});
  await addToShortlist(h.supabase, ID, 'p03');
  await addToShortlist(h.supabase, ID, 'p19');
  await h.send(say('/saved'));

  const messages = h.toUser();
  assert.match(messages[0].text, /Your shortlist/);
  assert.match(messages[0].text, /Sky Mansion/);
  assert.match(messages[1].text, /Penthouse.*no longer available/);
});

test('/reset clears the conversation but keeps the profile and the shortlist', async () => {
  const h = harness({ generate: async () => ({ text: 'ok' }) });
  await seedLead(h, { budgetMax: Cr(2) });
  await addToShortlist(h.supabase, ID, 'p09');
  await h.send(say('hello'));
  assert.ok(h.rows('chat_messages').length > 0);

  await h.send(say('/reset'));
  assert.equal(h.rows('chat_messages').length, 0);
  const lead = await getLead(h.supabase, ID);
  assert.equal(lead.budgetMax, Cr(2));
  assert.deepEqual(lead.shortlistedPropertyIds, ['p09']);
});

test('a shared contact saves the number; someone else\'s contact is refused', async () => {
  const h = harness();
  await seedLead(h, {});

  const contact = (user_id) => ({
    update_id: next(),
    message: { message_id: next(), date: 0, chat: privateChat(), from: person(), contact: { phone_number: '919876543210', first_name: 'Asha', user_id } }
  });

  await h.send(contact(999999));
  assert.equal((await getLead(h.supabase, ID)).phone, undefined);

  await h.send(contact(USER));
  assert.equal((await getLead(h.supabase, ID)).phone, '+919876543210');
  assert.match(h.toSales().at(-1).text, /shared their number/);
});

// ---- webhook and routes ---------------------------------------------------------------------

test('the webhook rejects a wrong or missing secret and answers 200 before processing', async () => {
  const seen = [];
  const bot = { handleUpdate: async (update) => { seen.push(update); } };
  const secret = 's'.repeat(32);
  const app = createApp({ supabase: null, telegramBot: bot, telegramSecret: secret });

  await request(app).post('/telegram/webhook').send({ update_id: 1 }).expect(401);
  await request(app).post('/telegram/webhook').set('X-Telegram-Bot-Api-Secret-Token', 'wrong').send({ update_id: 1 }).expect(401);
  assert.equal(seen.length, 0);

  await request(app).post('/telegram/webhook').set('X-Telegram-Bot-Api-Secret-Token', secret).send({ update_id: 7 }).expect(200);
  assert.deepEqual(seen, [{ update_id: 7 }]);
});

test('with the tool routes off, the HTTP tools do not exist', async () => {
  const app = createApp({ supabase: null, enableToolRoutes: false });
  await request(app).post('/tools/search-properties').send({}).expect(404);
  await request(app).post('/tools/upsert-lead-memory').send({}).expect(404);
  await request(app).get('/health').expect(200);
});

test('setBotState merges instead of replacing', async () => {
  const h = harness();
  await seedLead(h, {});
  await setBotState(h.supabase, ID, { scope: 'on_topic' });
  await setBotState(h.supabase, ID, { shown: [{ id: 'p01' }] });
  const state = (await getLead(h.supabase, ID)).botState;
  assert.equal(state.scope, 'on_topic');
  assert.equal(state.shown.length, 1);
});

test('replies never contain em or en dashes', async () => {
  assert.equal(withoutDashes('discounts—pricing is handled by our team'), 'discounts, pricing is handled by our team');
  assert.equal(withoutDashes('We can help — happily.'), 'We can help, happily.');
  assert.equal(withoutDashes('Open 10am–7pm'), 'Open 10am to 7pm');
  assert.equal(withoutDashes('Budget 50–60 lakh'), 'Budget 50 to 60 lakh');
  assert.equal(withoutDashes('Well–known area'), 'Well, known area');

  const h = harness({ generate: async () => ({ text: 'Pricing is handled by sales—happy to arrange a visit.' }) });
  await h.send(say('can you reduce the price?'));
  assert.equal(h.toUser().at(-1).text, 'Pricing is handled by sales, happy to arrange a visit.');
});

test('a lead who already has a profile is never silenced by the scope check', async () => {
  let classified = 0;
  const h = harness({ generate: async ({ prompt }) => (prompt ? (classified++, { text: 'NO' }) : { text: 'Here are cheaper options.' }) });
  await seedLead(h, { budgetMax: Cr(5) }, 'interested');
  await h.send(say('show me something cheaper'));
  assert.equal(classified, 0);
  assert.equal(h.toUser().at(-1).text, 'Here are cheaper options.');
});

test('an unanswered search claim is retried with a tool forced on the first step', async () => {
  const calls = [];
  const h = harness({
    generate: async (options) => {
      calls.push(options);
      if (calls.length === 1) return { text: 'Searching for 3 BHK in Anna Nagar now.' };
      await options.tools.search_properties.execute({ location: 'Anna Nagar', category: 'residential', bedrooms: 3 }, toolCall);
      return { text: 'Here are the closest options.' };
    }
  });
  await seedLead(h, {}, 'interested');
  await h.send(say('3 bhk in anna nagar'));

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].prepareStep({ stepNumber: 0 }), { toolChoice: 'required' });
  assert.deepEqual(calls[1].prepareStep({ stepNumber: 1 }), {});
  assert.ok(h.toUser().some((m) => /How it differs|Matches your requirements/.test(m.text)), 'cards were sent');
  assert.equal(h.toUser().at(-1).text, 'Here are the closest options.');
});

test('a clarifying question may repeat the number the customer typed, with any unit', () => {
  assert.equal(guardAmounts('Do you mean 80 lakh or 80 crore?', [], 'budget is around 80').blocked, false);
  assert.equal(guardAmounts('Do you mean 90 lakh or 90 crore?', [], 'budget is around 80').blocked, true);
});

test('money in the customer\'s message is read by code and handed to the model as a fact', () => {
  assert.match(moneyHint('150L to 2 crore'), /minimum ₹1.5 Cr, maximum ₹2 Cr/);
  assert.match(moneyHint('150L to 2 crore'), /do not ask about them/);
  assert.match(moneyHint('3BHK in OMR under 1.5C'), /maximum ₹1.5 Cr/);
  assert.match(moneyHint('my budget is around 80'), /no unit/);
  assert.match(moneyHint('budget 2 crore to 1 crore'), /wrong way round/);
  assert.equal(moneyHint('I need 2 bedrooms'), '');
  assert.equal(moneyHint('show me flats in Anna Nagar'), '');
});

test('numbers that describe the property are not read as money', () => {
  assert.match(moneyHint('Anna Nagar la 3 BHK venum, budget 2 crore'), /maximum ₹2 Cr/);
  assert.doesNotMatch(moneyHint('Anna Nagar la 3 BHK venum, budget 2 crore'), /wrong way round/);
  assert.equal(moneyHint('3 BHK in Anna Nagar'), '');
  assert.equal(moneyHint('1200 sq ft plot 5 km from OMR'), '');
  assert.match(moneyHint('2 bedroom, 70 lakh'), /maximum ₹70 L/);
});

test('a sold or reserved match is always named, even if the model forgets', () => {
  const unavailable = [{ title: 'Exclusive Rooftop Penthouse', status: 'sold' }];
  assert.equal(mentionUnavailable('Here is a close option.', unavailable), 'Here is a close option. Note: Exclusive Rooftop Penthouse is sold.');
  assert.equal(mentionUnavailable('The penthouse is sold, sorry.', unavailable), 'The penthouse is sold, sorry.');
  assert.equal(mentionUnavailable('Hello', []), 'Hello');
  assert.match(mentionUnavailable('Hi', [{ title: 'Showroom', status: 'reserved' }]), /Showroom is reserved/);
});

test('asking for a discount moves the lead to negotiating even if the model does nothing', async () => {
  const h = harness({ generate: async () => ({ text: 'Our sales team handles pricing.' }) });
  await seedLead(h, { budgetMax: Cr(5) }, 'interested');
  await h.send(say('Can you give me a 10% discount?'));

  assert.equal((await getLead(h.supabase, ID)).leadStage, 'negotiating');
  const moved = h.rows('lead_events').find((e) => e.event_type === 'stage_changed' && e.to_stage === 'negotiating');
  assert.equal(moved.note, 'asked about price or a discount');
  assert.equal(moved.payload.actor, 'system');
});

test('price talk is recognised, ordinary searches are not', () => {
  for (const yes of ['Can you give me a 10% discount?', 'is the price negotiable', 'can the plot come down to 50 lakh?', 'reduce the price a bit', 'what is your best price', 'Another broker is cheaper, can you match?', '15% off?']) {
    assert.equal(isNegotiation(yes), true, yes);
  }
  for (const no of ['show me something cheaper', '3BHK in OMR under 1.5 crore', 'ROI is 8% they say', 'what is the price of the bungalow', 'I need a house']) {
    assert.equal(isNegotiation(no), false, no);
  }
});

test('notes about the assistant\'s own bookkeeping are removed from replies', () => {
  assert.equal(
    withoutBackstage('Pricing is handled by our sales team.\n\n(Updating lead stage to negotiating so the team knows you want to discuss price.)'),
    'Pricing is handled by our sales team.'
  );
  assert.equal(withoutBackstage('I have updated the lead stage. Here are options.'), 'Here are options.');
  assert.equal(withoutBackstage('Here are three flats (all in OMR).'), 'Here are three flats (all in OMR).');
});

test('a button that was never sent is not mentioned', () => {
  assert.equal(claimsVisitButton('Tap the "Confirm site visit" button to request it.'), true);
  assert.equal(claimsVisitButton('Which property would you like to see?'), false);
  assert.equal(withoutPhantomButtons('I can arrange that. Tap the "Confirm site visit" button to request it.', false), 'I can arrange that.');
  assert.equal(withoutPhantomButtons('Tap the "Confirm site visit" button.', false), 'Which property would you like to visit?');
  assert.equal(withoutPhantomButtons('Tap the "Confirm site visit" button.', true), 'Tap the "Confirm site visit" button.');
});

test('a promised confirm button is sent by re-running the turn with that tool forced', async () => {
  const calls = [];
  const h = harness({
    generate: async (options) => {
      calls.push(options);
      if (calls.length === 1) {
        await options.tools.search_properties.execute({ location: 'Tambaram', category: 'residential' }, toolCall);
        return { text: 'Tap the "Confirm site visit" button to request the visit.' };
      }
      await options.tools.request_site_visit.execute({ position: 1 }, toolCall);
      return { text: 'Tap the "Confirm site visit" button to request it.' };
    }
  });
  await seedLead(h, {}, 'interested');
  await h.send(say('confirm site visit'));

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].prepareStep({ stepNumber: 0 }), { toolChoice: { type: 'tool', toolName: 'request_site_visit' } });
  assert.ok(h.toUser().some((m) => /Would you like to visit/.test(m.text) && buttons(m).includes('action:visit:p16')), 'the confirm button was sent');
  assert.match(h.toUser().at(-1).text, /Confirm site visit/);
});

test('if no button can be sent, the promise to send one is removed', async () => {
  const h = harness({ generate: async () => ({ text: 'Happy to arrange it. Tap the "Confirm site visit" button to request it.' }) });
  await seedLead(h, {}, 'interested');
  await h.send(say('I want to visit'));
  assert.equal(h.toUser().at(-1).text, 'Happy to arrange it.');
});

// ---- photos -------------------------------------------------------------------------------

const photoRows = (propertyId, count) =>
  Array.from({ length: count }, (_, i) => ({ id: i + 1, property_id: propertyId, path: `${propertyId}/photo-${i}.jpg`, position: i }));

const searchNavalur = async ({ tools }) => {
  await tools.search_properties.execute({ location: 'OMR', category: 'residential', bedrooms: 2 }, toolCall);
  return { text: 'Here is one.' };
};

test('a listing with photos is sent as its cover photo, with the card as the caption and a gallery row', async () => {
  const h = harness({ generate: searchNavalur, tables: { property_photos: photoRows('p04', 3) } });
  await h.send(say('2BHK in OMR'));

  const [card] = h.sent('sendPhoto');
  assert.ok(card.photo.endsWith('/storage/v1/object/public/property-photos/p04/photo-0.jpg'));
  assert.match(card.caption, /High-Rise 2BHK Apartment/);
  assert.match(card.caption, /₹62 L/);
  assert.equal(card.parse_mode, 'HTML');
  assert.deepEqual(card.reply_markup.inline_keyboard.map((row) => row.map((b) => b.callback_data)), [
    ['action:visit:p04', 'action:save:p04'],
    ['action:ph:p04:2', 'action:noop', 'action:ph:p04:1']
  ]);
  assert.equal(card.reply_markup.inline_keyboard[1][1].text, '📷 1/3');
  assert.equal(h.toUser().filter((m) => /Matches your requirements|Close option/.test(m.text)).length, 0, 'no duplicate text card');
});

test('a listing with one photo has no gallery row; one with none stays a text card', async () => {
  const one = harness({ generate: searchNavalur, tables: { property_photos: photoRows('p04', 1) } });
  await one.send(say('2BHK in OMR'));
  assert.equal(one.sent('sendPhoto')[0].reply_markup.inline_keyboard.length, 1);

  const none = harness({ generate: searchNavalur });
  await none.send(say('2BHK in OMR'));
  assert.equal(none.sent('sendPhoto').length, 0);
  assert.match(none.toUser()[0].text, /High-Rise 2BHK Apartment/);
});

test('if Telegram cannot fetch the photo, the card is still sent as text', async () => {
  const h = harness({ generate: searchNavalur, tables: { property_photos: photoRows('p04', 2) }, failMethod: 'sendPhoto' });
  await h.send(say('2BHK in OMR'));
  assert.match(h.toUser()[0].text, /High-Rise 2BHK Apartment/);
  assert.deepEqual(buttons(h.toUser()[0]), ['action:visit:p04', 'action:save:p04']);
});

test('the arrows swap the photo in place, keep the caption, and wrap around', async () => {
  const h = harness({ tables: { property_photos: photoRows('p04', 3) } });
  await seedLead(h, {});
  const caption = 'High-Rise 2BHK\n₹62 L';
  const entities = [{ type: 'bold', offset: 0, length: 4 }];
  const card = { caption, caption_entities: entities, reply_markup: { inline_keyboard: [[], []] } };

  await h.send(tap('action:ph:p04:1', USER, card));
  const [edit] = h.sent('editMessageMedia');
  assert.ok(edit.media.media.endsWith('p04/photo-1.jpg'));
  assert.equal(edit.media.caption, caption);
  assert.deepEqual(edit.media.caption_entities, entities);
  assert.equal(edit.reply_markup.inline_keyboard[1][1].text, '📷 2/3');
  assert.deepEqual(edit.reply_markup.inline_keyboard[1].map((b) => b.callback_data), ['action:ph:p04:0', 'action:noop', 'action:ph:p04:2']);

  await h.send(tap('action:ph:p04:-1', USER, card));
  assert.ok(h.sent('editMessageMedia')[1].media.media.endsWith('p04/photo-2.jpg'), 'before the first is the last');
  await h.send(tap('action:ph:p04:3', USER, card));
  assert.ok(h.sent('editMessageMedia')[2].media.media.endsWith('p04/photo-0.jpg'), 'after the last is the first');
  assert.equal(h.sent('answerCallbackQuery').length, 3);
});

test('the gallery remembers whether the property is shortlisted', async () => {
  const h = harness({ tables: { property_photos: photoRows('p04', 2) } });
  await seedLead(h, {});
  await addToShortlist(h.supabase, ID, 'p04');
  await h.send(tap('action:ph:p04:1', USER, { caption: 'c', reply_markup: { inline_keyboard: [[], []] } }));
  assert.deepEqual(h.sent('editMessageMedia')[0].reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['action:visit:p04', 'action:unsave:p04']);
});

test('the counter button does nothing, and a missing gallery says so quietly', async () => {
  const h = harness();
  await seedLead(h, {});
  await h.send(tap('action:noop'));
  await h.send(tap('action:ph:p04:1', USER, { caption: 'c' }));
  assert.equal(h.sent('editMessageMedia').length, 0);
  assert.equal(h.sent('answerCallbackQuery').length, 2);
  assert.equal(h.sent('answerCallbackQuery')[1].text, 'No photos to show.');
});

test('saving a property on a photo card keeps the gallery row', async () => {
  const h = harness({ tables: { property_photos: photoRows('p09', 3) } });
  await seedLead(h, {});
  const galleryRow = [{ text: '◀', callback_data: 'action:ph:p09:2' }, { text: '📷 1/3', callback_data: 'action:noop' }, { text: '▶', callback_data: 'action:ph:p09:1' }];
  await h.send(tap('action:save:p09', USER, { reply_markup: { inline_keyboard: [[], galleryRow] } }));

  const rows = h.sent('editMessageReplyMarkup')[0].reply_markup.inline_keyboard;
  assert.deepEqual(rows[0].map((b) => b.callback_data), ['action:visit:p09', 'action:unsave:p09']);
  assert.deepEqual(rows[1], galleryRow);
});

test('a caption never exceeds Telegram\'s limit', () => {
  const long = {
    kind: 'recommendation', title: 'T'.repeat(200), location: 'L'.repeat(150), priceDisplay: '₹1 Cr', status: 'under_construction',
    statusLabel: 'Under construction', bedrooms: 3, rera: 'R'.repeat(80),
    highlights: Array.from({ length: 6 }, (_, i) => ({ label: `Label ${i}`, value: 'v'.repeat(180) })),
    differences: Array.from({ length: 5 }, () => 'a fairly long explanation of how this property differs from the request')
  };
  assert.ok(renderCard(long).length > 1024, 'the fixture really is too long');
  assert.ok(renderCard(long, { maxLength: CAPTION_LIMIT }).length <= CAPTION_LIMIT);
  assert.match(renderCard(long, { maxLength: CAPTION_LIMIT }), /How it differs/);
});

test('/saved shows photos too', async () => {
  const h = harness({ tables: { property_photos: photoRows('p03', 2) } });
  await seedLead(h, {});
  await addToShortlist(h.supabase, ID, 'p03');
  await h.send(say('/saved'));
  const [photo] = h.sent('sendPhoto');
  assert.match(photo.caption, /Your shortlist/);
  assert.equal(photo.reply_markup.inline_keyboard[1].length, 3);
});

test('before the photos table exists, searches and /saved still work as text cards', async () => {
  const h = harness({ generate: searchNavalur });
  const realFrom = h.supabase.from;
  h.supabase.from = (name) =>
    name === 'property_photos'
      ? { select: () => ({ in: () => ({ order: async () => ({ data: null, error: { message: 'relation "property_photos" does not exist' } }) }) }) }
      : realFrom(name);

  await h.send(say('2BHK in OMR'));
  assert.equal(h.sent('sendPhoto').length, 0);
  assert.match(h.toUser()[0].text, /High-Rise 2BHK Apartment/);

  await addToShortlist(h.supabase, ID, 'p03');
  await h.send(say('/saved'));
  assert.ok(h.toUser().some((m) => /Sky Mansion/.test(m.text)));
});

test('questions about photos are recognised', () => {
  for (const yes of ['do you have images', 'show me photos', 'any pictures?', 'can I see pics', 'is there a gallery']) assert.equal(asksAboutPhotos(yes), true, yes);
  for (const no of ['I need a house', '3BHK in OMR', 'what is the price', 'tell me more about the first one']) assert.equal(asksAboutPhotos(no), false, no);
});

test('"do you have images" is answered from the real photo counts, without the model', async () => {
  let asked = 0;
  const h = harness({ generate: async () => (asked++, { text: 'Listings have images in their cards, tap a card.' }), tables: { property_photos: photoRows('p04', 3) } });
  await seedLead(h, {}, 'interested');
  await setBotState(h.supabase, ID, { shown: [
    { id: 'p04', title: 'High-Rise 2BHK Apartment', priceDisplay: '₹62 L' },
    { id: 'p11', title: 'Villa Plot', priceDisplay: '₹84 L' }
  ] });
  await h.send(say('do you have images'));

  assert.equal(asked, 0, 'the model is not asked');
  const reply = h.toUser().at(-1).text;
  assert.match(reply, /High-Rise 2BHK Apartment: 3 photos\. Use the ◀ ▶ buttons/);
  assert.match(reply, /Villa Plot: no photos yet\./);
  assert.doesNotMatch(reply, /tap a card/i);
  assert.deepEqual(h.rows('chat_messages').map((m) => m.role), ['user', 'assistant']);
});

test('with nothing shown yet, the photo answer is general and does not promise any', async () => {
  const h = harness();
  await seedLead(h, {}, 'interested');
  await h.send(say('any photos?'));
  assert.match(h.toUser().at(-1).text, /Some of our listings have photos/);
  assert.match(h.toUser().at(-1).text, /◀ ▶/);
});

test('the model is told how many photos each shown property has', async () => {
  const h = harness({ generate: searchNavalur, tables: { property_photos: photoRows('p04', 2) } });
  await h.send(say('2BHK in OMR'));
  const lead = await getLead(h.supabase, ID);
  assert.equal(lead.botState.shown[0].photoCount, 2);
  const prompt = buildInstructions(lead);
  assert.match(prompt, /High-Rise 2BHK Apartment near Tech Parks \(₹62 L, 2 photos\)/);
  assert.match(buildInstructions({ ...lead, botState: { shown: [{ title: 'Plot', priceDisplay: '₹84 L', photoCount: 0 }] } }), /Plot \(₹84 L, no photos\)/);
  assert.match(prompt, /never say a card can be tapped or opened/i);
});

test('talk of photos is removed when nothing in play has any', async () => {
  assert.equal(withoutPhotoClaims('I found a flat. Which detail would you like next, photos or site visit?', false), 'I found a flat.');
  assert.equal(withoutPhotoClaims('I found a flat. There are no photos yet.', false), 'I found a flat. There are no photos yet.');
  assert.equal(withoutPhotoClaims('I found a flat. Use the arrows to see photos.', true), 'I found a flat. Use the arrows to see photos.');
  assert.equal(withoutPhotoClaims('I found a flat.', false), 'I found a flat.');

  const h = harness({ generate: async ({ tools }) => {
    await tools.search_properties.execute({ category: 'residential', location: 'Tambaram' }, toolCall);
    return { text: 'This one is available. Would you like to see photos or book a visit?' };
  } });
  await h.send(say('1BHK in Tambaram'));
  assert.equal(h.toUser().at(-1).text, 'This one is available.');
});

test('"tap the card" is removed, because the card itself is not tappable', () => {
  assert.equal(withoutCardTapping('I found one 1BHK. Tap the card to see details. Want a site visit?'), 'I found one 1BHK. Want a site visit?');
  assert.equal(withoutCardTapping('Tap Book Site Visit under the card to request a visit.'), 'Tap Book Site Visit under the card to request a visit.');
  assert.equal(withoutCardTapping('Listings have images in their cards, tap a card to view them.'), '');
});
