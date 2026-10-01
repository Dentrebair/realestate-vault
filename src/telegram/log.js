// One JSON line per event. Message text is never logged here.
export function log(event, fields = {}, level = 'info') {
  if (process.env.QUIET_LOGS) return;
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields });
  (level === 'error' ? console.error : console.log)(line);
}
