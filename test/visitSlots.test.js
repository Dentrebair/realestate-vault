import assert from 'node:assert/strict';
import test from 'node:test';
import { describeUpcoming, prettyWhen, slotFits, upcomingDays, validateAvailability, windowsOn } from '../src/visitSlots.js';

// Thursday 8 Oct 2026, 11:00 in India.
const NOW = new Date('2026-10-08T05:30:00Z');
const opts = { now: NOW, timeZone: 'Asia/Kolkata' };
const SATURDAYS = [{ days: [6], from: '10:00', to: '13:00' }];

test('a weekly window applies on its days only, and a dated window on that date only', () => {
  assert.deepEqual(windowsOn(SATURDAYS, '2026-10-10'), [{ from: '10:00', to: '13:00' }]);
  assert.deepEqual(windowsOn(SATURDAYS, '2026-10-11'), []);
  assert.deepEqual(windowsOn([{ date: '2026-10-12', from: '15:00', to: '17:00' }], '2026-10-12'), [{ from: '15:00', to: '17:00' }]);
});

test('a time fits inside a window, not at its end, not outside, and not in the past', () => {
  assert.equal(slotFits(SATURDAYS, '2026-10-10', '10:00', opts), true);
  assert.equal(slotFits(SATURDAYS, '2026-10-10', '12:59', opts), true);
  assert.equal(slotFits(SATURDAYS, '2026-10-10', '13:00', opts), false);
  assert.equal(slotFits(SATURDAYS, '2026-10-10', '09:30', opts), false);
  assert.equal(slotFits(SATURDAYS, '2026-10-11', '11:00', opts), false);
  assert.equal(slotFits(SATURDAYS, '2026-10-03', '11:00', opts), false, 'a Saturday that has gone');
  assert.equal(slotFits([{ days: [4], from: '09:00', to: '17:00' }], '2026-10-08', '10:00', opts), false, 'earlier today');
  assert.equal(slotFits([{ days: [4], from: '09:00', to: '17:00' }], '2026-10-08', '15:00', opts), true, 'later today');
  assert.equal(slotFits(SATURDAYS, 'garbage', '11:00', opts), false);
});

test('the options offered start from today and skip a window that has ended', () => {
  const rules = [{ days: [4], from: '09:00', to: '10:30' }, { days: [6], from: '10:00', to: '13:00' }];
  const days = upcomingDays(rules, { ...opts, limit: 2 });
  assert.deepEqual(days.map((d) => d.date), ['2026-10-10', '2026-10-15'], 'today 9 to 10:30 is over at 11:00, so next Thursday is offered');
  assert.deepEqual(describeUpcoming(SATURDAYS, { ...opts, limit: 1 }), ['Sat 10 Oct: 10 am to 1 pm']);
});

test('dates are written the way customers read them', () => {
  assert.equal(prettyWhen('2026-10-10', '15:30'), 'Sat 10 Oct, 3:30 pm');
  assert.equal(prettyWhen('2026-10-10', null), 'Sat 10 Oct');
});

test('what the board sends is checked and cleaned', () => {
  assert.equal(validateAvailability({ mode: 'maybe' }).error !== undefined, true);
  assert.equal(validateAvailability({ mode: 'open', rules: [] }).error !== undefined, true, 'open needs a window');
  assert.equal(validateAvailability({ mode: 'open', rules: [{ days: [6], from: '13:00', to: '10:00' }] }).error !== undefined, true, 'end before start');
  assert.equal(validateAvailability({ mode: 'open', rules: [{ days: [], from: '10:00', to: '11:00' }] }).error !== undefined, true, 'no days');
  assert.equal(validateAvailability({ mode: 'open', rules: [{ date: '2026-13-45', from: '10:00', to: '11:00' }] }).error !== undefined, true, 'bad date');
  assert.equal(validateAvailability({ mode: 'open', rules: Array(21).fill({ days: [1], from: '10:00', to: '11:00' }) }).error !== undefined, true, 'too many');

  const ok = validateAvailability({ mode: 'open', rules: [{ days: ['6', 6, 9, 1], from: '10:00', to: '13:00', extra: 'x' }], note: `  ${'n'.repeat(300)}  ` });
  assert.deepEqual(ok.value.rules, [{ days: [1, 6], from: '10:00', to: '13:00' }]);
  assert.equal(ok.value.note.length, 200);
  assert.deepEqual(validateAvailability({ mode: 'closed', rules: [{ days: [1] }], note: '' }).value, { mode: 'closed', rules: [], note: null });
});
