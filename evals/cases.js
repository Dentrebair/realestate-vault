// What must be true of the bot's behaviour for each test lead. Assertions are on tool calls, cards,
// stages and forbidden content, never on exact wording. A `fail` is a real problem; a `warn` is style.
import { toInr } from '../src/money.js';

export const CORE = [
  '001', '002', '003', '004', '005', '006', '007', '008', '009', '011', '012', '013', '014', '015',
  '016', '017', '018', '019', '020', '021', '022', '026', '028', '030', '032', '033', '039', '040',
  '041', '043', '044', '045', '047', '048', '049', '050'
];

const RANK = { initiated: 0, interested: 1, negotiating: 2, site_visit_ready: 3, closed: 4 };

const inr = (m) => (m ? toInr(m.amount, m.unit) : undefined);

export function checksFor(n, r) {
  const fail = [];
  const warn = [];
  const need = (ok, message) => ok || fail.push(message);
  const nice = (ok, message) => ok || warn.push(message);

  const id = String(n).padStart(3, '0');
  const cards = r.cards.join('\n');
  const replies = r.replies.join('\n');
  const everything = [...r.replies, ...r.cards, ...r.sales].join('\n');
  const searches = r.tools.filter((t) => t.name === 'search_properties').map((t) => t.input);
  const hasCard = (re) => re.test(cards);

  // ---- rules for every lead ----
  need(!/[–—]/.test(everything), 'used an em or en dash');
  need(!/(would you like|want|happy to|i can|i'll|i will|shall i|let me).{0,40}\b(photos?|floor plans?|brochures?|virtual tours?|videos?)\b/i.test(replies), 'offered photos, plans or brochures we do not have');
  need(!/Rooftop Penthouse/.test(cards), 'showed the sold penthouse as a card');
  need(!/Retail Showroom Building/.test(cards), 'showed the reserved showroom as a card');
  for (const card of r.cards.filter((c) => /Heritage Residential Bungalow/.test(c))) {
    need(/Price on Request \(POR\)/.test(card) && !/₹/.test(card), 'Alwarpet bungalow card shows a price or lacks POR');
  }
  need(!/telegram:\d+|test:\d+/.test(everything), 'leaked a customer id');
  need(!/\btap (a|the|on a|on the) (card|property|listing)\b/i.test(replies), 'told the customer to tap a card');
  need(!/\b(has|have|with) (some )?(photos?|images?|pictures?)\b/i.test(replies) || /no photos|don't have|do not have|not yet/i.test(replies), 'claimed photos exist when none do');
  need(!/I am having trouble accessing live property records/.test(replies), 'fell back to the failure message');
  need(!/\b(visit|viewing)\b[^.]{0,40}\b(booked|scheduled|confirmed)\b|\b(booked|scheduled|confirmed)\b[^.]{0,30}\b(visit|viewing)\b/i.test(replies), 'said a visit was booked, scheduled or confirmed');

  need(!/lead stage|updating (the |your )?(lead|record)|stage to (negotiating|interested)/i.test(replies), 'talked about its own bookkeeping');
  if (/\b(tap|press|click)\b[^.]*\bconfirm\b/i.test(replies)) {
    need(r.out.some((m) => m.buttons.some((b) => b.startsWith('action:visit'))), 'mentioned a Confirm button that was never sent');
  }

  const start = r.lead.stage;
  const end = r.row.lead_stage;
  if (end !== 'not_interested' && start !== 'not_interested') {
    need(RANK[end] >= RANK[start], `stage went backwards (${start} to ${end})`);
  }
  need(end !== 'site_visit_ready' || start === 'site_visit_ready', 'the model made a hot lead');

  for (const reply of r.replies) {
    nice((reply.match(/\?/g) ?? []).length <= 1, `asked more than one question: "${reply.slice(0, 60)}"`);
    nice(reply.split(/\s+/).length <= 90, 'a reply ran over 90 words');
  }

  // ---- rules for particular leads ----
  const specific = {
    '001': () => {
      need(hasCard(/Sky Mansion/), 'did not show the Anna Nagar 4BHK');
      need(!/(what|what's|what is) your budget|how much.*budget/i.test(replies), 're-asked the saved budget');
    },
    '002': () => {
      need(hasCard(/High-Rise 2BHK/), 'did not show Navalur');
      need(hasCard(/Under construction/), 'did not label it under construction');
    },
    '003': () => need(hasCard(/Compact 1BHK/), 'did not show the Tambaram 1BHK'),
    '004': () => {
      need(/team|sales/i.test(replies), 'did not hand pricing to the sales team');
      need(!/\d+\s?%/.test(replies), 'quoted a discount');
      need(end === 'negotiating', 'stage should stay negotiating');
    },
    '005': () => {
      need(r.sales.length === 0, 'alerted the sales desk without a button tap');
      need(end === 'site_visit_ready', 'stage should stay site_visit_ready');
    },
    '006': () => need(hasCard(/Cloud Kitchen/), 'did not find the Perungudi cloud kitchen'),
    '007': () => {
      need(r.cards.length === 0, 'pushed listings at someone who opted out');
      need(end === 'not_interested', 'stage should stay not_interested');
    },
    '008': () => {
      need(r.tools.some((t) => t.name === 'request_site_visit') || r.out.some((m) => m.buttons.some((b) => b.startsWith('action:visit'))), 'did not offer a visit confirm button');
      need(end === 'site_visit_ready', 'stage should stay site_visit_ready');
    },
    '009': () => need(/team|sales/i.test(replies), 'did not hand pricing to the sales team'),
    '011': () => {
      need(searches.length > 0, 'never searched');
      const s = searches[0] ?? {};
      need(/omr/i.test(s.location ?? ''), 'location was not OMR');
      need(s.bedrooms === 3 || s.minBedrooms === 3 || /3\s*bhk/i.test(s.query ?? ''), 'bedrooms were not 3');
      need(inr(s.maxBudget) === 15000000, 'budget was not 1.5 crore');
      need(hasCard(/Close option/) && hasCard(/Navalur/), 'did not recommend Navalur as a close option');
      need(!/Matches your requirements/.test(cards), 'called a close option a match');
    },
    '012': () => need(hasCard(/Sky Mansion/) && hasCard(/Close option/), 'did not recommend the Anna Nagar 4BHK as a close option'),
    '013': () => need(hasCard(/Compact 1BHK/) && hasCard(/Close option/), 'did not recommend the Tambaram 1BHK'),
    '014': () => {
      const s = searches[0] ?? {};
      need(s.category === 'residential', 'category was not residential');
      need(/triplicane/i.test(s.location ?? ''), 'location was not Triplicane');
      need(inr(s.maxBudget) === 20000000, 'budget was not 2 crore');
      need(hasCard(/Close option/), 'did not offer a close option');
      need(!hasCard(/Matches your requirements/), 'called a close option a match');
    },
    '015': () => {
      need(/team|sales/i.test(replies), 'did not hand pricing to the sales team');
      need(!/(yes|sure|agreed|deal).{0,40}(50 ?lakh|₹50)/i.test(replies), 'agreed to a lower price');
    },
    '016': () => need(/sold|unavailable|not available/i.test(replies), 'did not say the penthouse is unavailable'),
    '017': () => need(hasCard(/Sky Mansion/) && hasCard(/Close option/), 'did not recommend the Anna Nagar 4BHK'),
    '018': () => {
      need(hasCard(/Retail Shop/), 'did not recommend the Mylapore shop');
      nice(/reserved|not available|unavailable/i.test(replies), 'did not mention the showroom is reserved');
    },
    '019': () => need(hasCard(/Boutique Hotel/), 'did not recommend the Guindy hotel'),
    '020': () => {
      need(hasCard(/Cloud Kitchen/), 'did not offer the Perungudi cloud kitchen');
      need(!hasCard(/Office Floor Plate/), 'showed the ₹24.5 Cr office against a ₹5 Cr budget');
    },
    '021': () => need(r.cards.length >= 1, 'showed nothing for "I need a house"'),
    '022': () => {
      need(r.cards.length >= 1 || /\?/.test(replies), 'neither showed options nor asked what kind');
      need(!hasCard(/Sky Mansion/), 'showed a property over the budget');
    },
    '026': () => {
      need(!r.tools.some((t) => t.input?.maxBudget || t.input?.minBudget), 'guessed the unit of "80"');
      need(/lakh/i.test(replies) && /crore/i.test(replies), 'did not ask lakh or crore');
    },
    '028': () => {
      need(!/\+?\d{10,}/.test(replies), 'printed a phone number');
      need(!r.row.phone, 'saved a phone number');
    },
    '030': () => need(hasCard(/High-Rise 2BHK/), 'did not find Navalur near Tidel Park'),
    '032': () => need(searches.some((s) => inr(s.maxBudget) === 15000000) || /1\.5\s*(cr|crore)/i.test(replies), 'did not read 1.5C as 1.5 crore'),
    '033': () => need(r.tools.some((t) => inr(t.input?.minBudget) === 15000000 && inr(t.input?.maxBudget) === 20000000), 'did not read "150L to 2 crore" as 1.5 to 2 crore'),
    '035': () => need(hasCard(/Villa Plot/), 'did not show the Medavakkam plot'),
    '039': () => {
      need(/sold|unavailable|not available/i.test(replies), 'did not say the penthouse is unavailable');
      need(!hasCard(/Penthouse/), 'listed the sold penthouse');
    },
    '040': () => need(!hasCard(/High-Rise 2BHK/), 'offered an under-construction home to someone who excluded them'),
    '041': () => {
      need(!r.tools.some((t) => t.input?.minBudget && t.input?.maxBudget && inr(t.input.minBudget) > inr(t.input.maxBudget)), 'searched with an inverted range');
      need(/\?/.test(replies), 'did not ask which way round');
    },
    '043': () => {
      need(!/which area|what area|where are you looking|which location/i.test(replies), 're-asked the saved area');
      need(searches.length > 0, 'never searched');
    },
    '044': () => {
      const saved = r.tools.some((t) => (t.input?.preferredLocations ?? []).some((l) => /ecr/i.test(l)));
      const searched = searches.some((s) => /ecr/i.test(s.location ?? ''));
      need(saved || searched, 'did not move the area to ECR');
    },
    '045': () => {
      need(/no longer available/i.test(replies), 'did not flag the sold property in /saved');
      need(hasCard(/Sky Mansion/), 'did not list the available saved property');
    },
    '046': () => need(!hasCard(/High-Rise 2BHK/), 'ignored the saved deal-breaker'),
    '047': () => {
      need(/sale|sell|buy/i.test(replies), 'did not say we only sell');
      need(/rent/i.test(replies), 'did not address the rental request');
    },
    '048': () => {
      need(/price on request|POR|cannot estimate|can't estimate|sales team|not shown/i.test(replies), 'did not say it is price on request or hand pricing to the team');
      need(!/₹|\b\d+\s?(cr|crore|lakh)/i.test(replies), 'mentioned an amount for a price-on-request property');
    },
    '049': () => {
      need(/team|sales/i.test(replies), 'did not hand pricing to the sales team');
      need(!/\d+\s?%/.test(replies) || /can't|cannot|unable/i.test(replies), 'quoted a discount');
    },
    '050': () => {
      need(!/[஀-௿]/.test(replies), 'replied in Tamil script');
      const s = searches[0] ?? {};
      need(/anna nagar/i.test(s.location ?? ''), 'did not search Anna Nagar');
      need(s.bedrooms === 3 || s.minBedrooms === 3 || /3\s*bhk/i.test(s.query ?? ''), 'bedrooms were not 3');
      need(inr(s.maxBudget) === 20000000, 'budget was not 2 crore');
    }
  };
  specific[id]?.();

  return { fail, warn };
}
