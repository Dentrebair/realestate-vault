// Everything the bot says without asking the model. Plain text unless noted.

export const MAX_MESSAGE_CHARS = 1000;
export const RATE_LIMIT_PER_HOUR = 20;

export const FALLBACK =
  'I am having trouble accessing live property records right now. Our property desk has been notified and will assist you shortly.';

export const OFF_TOPIC =
  'I can help with Chennai property: flats, villas, plots, shops, offices, hotels and more. Tell me what you are looking for.';

export const RATE_LIMITED = 'You are sending messages quickly. Please wait a little and try again.';

export const TOO_LONG = `That message is too long for me. Please keep it under ${MAX_MESSAGE_CHARS} characters.`;

export const NON_TEXT = 'I can read text messages for now. Please type what you are looking for.';

export const HELP =
  'Tell me what you are looking for, for example "3BHK in OMR under 1.5 crore" or "shop in Mylapore".\n\n' +
  '/saved shows your shortlist\n/reset starts everything again from the beginning\n\n' +
  'Listings are indicative and subject to verification by our team.';

export const RESET_DONE = 'Done. I have cleared our conversation and we are starting fresh. Your saved preferences and shortlist are kept.';

export const NO_SAVED = 'You have not shortlisted anything yet. Tap ⭐ Shortlist on a property to keep it here.';

export const STALE_PROPERTY = 'That property is no longer available.';

export function welcome(name) {
  const greeting = name ? `Hi ${name}!` : 'Hi!';
  return (
    `${greeting} I am the property assistant for Chennai real estate.\n\n` +
    'Tell me what you are looking for, for example "3BHK in OMR under 1.5 crore", or pick a category below.\n\n' +
    'Listings are indicative and subject to verification by our team.'
  );
}

export function visitRecorded(title, businessHours) {
  return (
    `✅ Site visit request noted for ${title}.\n` +
    `Our team will confirm a time shortly (${businessHours}).`
  );
}

export const VISIT_ALREADY = 'You have already asked to visit this property. Our team will confirm a time shortly.';

export const SHARE_NUMBER_PROMPT =
  'If you would like our team to call you, tap the button to share your number. This is optional.';

export const PHONE_THANKS = 'Thank you. Our team will use this number only to arrange your visit.';

export const PHOTOS_GENERAL =
  'Some of our listings have photos. On those cards you will see ◀ ▶ buttons under the picture to flip through them. ' +
  'Tell me what you are looking for and I will show you what we have.';

// What we really have for the properties just shown. Written by code from the database, never by the model.
export function photosAnswer(items) {
  const lines = items.map(({ title, count }) =>
    count > 0
      ? `• ${title}: ${count} photo${count === 1 ? '' : 's'}${count > 1 ? '. Use the ◀ ▶ buttons under its card to flip through them.' : ' on its card.'}`
      : `• ${title}: no photos yet.`
  );
  const anyMissing = items.some((i) => i.count === 0);
  const tail = anyMissing ? '\n\nThe best way to see a property without photos is a site visit. Tap Book Site Visit on its card.' : '';
  return `${lines.join('\n')}${tail}`;
}
