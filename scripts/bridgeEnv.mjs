/**
 * What the launcher (scripts/start.mjs) adds to the bridge's environment, and
 * nothing else: the switches are the bridge's alone, never the face's and
 * never the user's whole environment.
 *
 *   --writes           JARVIS_ALLOW_WRITES=1     shell, files, devices
 *   --calendar-writes  JARVIS_CALENDAR_WRITES=1  Google Calendar only
 *
 * Separate on purpose: the calendar can be written to without opening the
 * shell to the model, and the shell does not open the calendar (see
 * bridge/googleCalendar.mjs). Each write still waits for its spoken word.
 *
 * @param {string[]} argv  the launcher's arguments
 * @param {Record<string, string | undefined>} env  the launcher's environment
 * @returns {Record<string, string>}
 */
export function bridgeEnvFor(argv, env) {
  const out = {}
  if (argv.includes('--writes')) out.JARVIS_ALLOW_WRITES = '1'
  if (argv.includes('--calendar-writes')) out.JARVIS_CALENDAR_WRITES = '1'
  // See start.mjs: the face's port, trusted by the bridge.
  if (env.PORT) out.JARVIS_ALLOWED_ORIGINS = `http://localhost:${env.PORT},http://127.0.0.1:${env.PORT}`
  return out
}
