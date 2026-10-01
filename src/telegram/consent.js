// The privacy notice, and the gate that holds the conversation until a customer has agreed to it.
import { InlineKeyboard } from 'grammy';
import { describePeriod } from '../privacy.js';

export const needsConsent = (lead, config) => config.requireConsent === true && !lead.consentAt;

export function privacyNotice(config) {
  const who = config.businessName;
  const contact = config.privacyContact
    ? `To ask a question or make a request about your data, contact ${config.privacyContact}.`
    : 'To ask a question or make a request about your data, contact the team that shared this assistant with you.';

  return [
    `Privacy notice`,
    ``,
    `${who} uses this assistant to help you find property and to pass your requests to our sales team.`,
    ``,
    `What we keep: your Telegram name and username, what you tell us about what you want (budget, areas, type of property), the properties you shortlist, and your messages. We keep your phone number only if you choose to share it.`,
    ``,
    `Who sees it: our sales team, on a private staff page. When you ask for a site visit, an alert with your name, username and the property goes to our team's chat. We do not sell your data or share it with other companies. Your messages are processed by an AI service to write replies.`,
    ``,
    `How long: your messages are deleted after ${describePeriod(config.chatRetentionHours)}, and your profile after ${describePeriod(config.leadRetentionHours)} without contact.`,
    ``,
    `Your choices: /mydata shows what we hold about you. /forget deletes it all. Alerts already sent to our team's chat are not removed automatically, so ask our team to remove them too.`,
    ``,
    contact
  ].join('\n');
}

export function consentPrompt(config) {
  const text =
    `Before we start: ${config.businessName} keeps what you tell this assistant (your name and username, what you are looking for, properties you shortlist, and your messages) ` +
    `so our sales team can follow up. It is deleted after ${describePeriod(config.leadRetentionHours)} without contact, and you can delete it any time with /forget.\n\n` +
    `Tap "I agree" to continue, or read the full notice first.`;
  const keyboard = new InlineKeyboard().text('✅ I agree', 'action:consent:yes').row().text('📄 Read the privacy notice', 'action:privacy');
  return { text, keyboard };
}

export const FORGET_ASK =
  'This deletes your profile, your shortlist, your saved messages and anything you asked us that we could not answer. It cannot be undone. Delete everything?';

export const forgetKeyboard = () => new InlineKeyboard().text('🗑 Yes, delete everything', 'action:forget:yes').text('Cancel', 'action:forget:no');

export const FORGOTTEN =
  'Done. Everything we held about you has been deleted. If you message me again I will treat you as new and ask for your agreement first.';

export const FORGET_CANCELLED = 'Okay. Nothing was deleted.';

export const CONSENT_NEEDED = 'Please tap "I agree" first, or read the privacy notice.';
