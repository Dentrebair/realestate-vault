// Lead stage rules. One place decides who may move a Lead to which stage.
//
//   initiated -> interested -> negotiating -> site_visit_ready -> closed
//   not_interested is the exit from any stage.
//
// Actors:
//   system  code reacting to a Lead's activity (first usable requirement, shortlist tap)
//   model   the AI, through the lead-memory tool
//   api     the HTTP lead-memory route (same limits as the model)
//   button  a Lead tapping an inline button
//   board   a person using the lead board (may correct any stage)
//   restart the Lead sent /reset to start over (back to initiated, from any stage; recorded in the history)

export const STAGES = [
  'initiated',
  'interested',
  'negotiating',
  'site_visit_ready',
  'closed',
  'not_interested'
];

const ORDER = {
  initiated: 0,
  interested: 1,
  negotiating: 2,
  site_visit_ready: 3,
  closed: 4
};

const MODEL_TARGETS = ['interested', 'negotiating', 'not_interested'];

const ALLOWED_TARGETS = {
  system: ['interested', 'negotiating'],
  model: MODEL_TARGETS,
  api: MODEL_TARGETS,
  button: ['interested', 'site_visit_ready', 'not_interested'],
  board: STAGES,
  restart: ['initiated']
};

export function canTransition(from, to, actor) {
  if (!STAGES.includes(to)) return deny(`unknown stage "${to}"`);
  if (from === to) return { ok: false, noop: true, reason: `already ${to}` };

  const targets = ALLOWED_TARGETS[actor];
  if (!targets) return deny(`unknown actor "${actor}"`);
  if (!targets.includes(to)) return deny(`${actor} cannot set ${to}`);

  if (actor === 'board' || actor === 'restart') return { ok: true };
  if (to === 'not_interested') return { ok: true };
  if (from === 'not_interested') {
    return to === 'interested' ? { ok: true } : deny('a lead who opted out can only return to interested');
  }
  if (ORDER[to] > ORDER[from]) return { ok: true };

  return deny('stages only move forward');
}

function deny(reason) {
  return { ok: false, reason };
}
