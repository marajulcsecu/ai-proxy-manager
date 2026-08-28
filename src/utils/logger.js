/**
 * @fileoverview Console output helpers.
 *
 * Colour is disabled when stdout is not a TTY (or NO_COLOR is set) so the
 * daemon log file does not fill up with escape sequences.
 */

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);

/** True when running detached, where a timestamp per line is worth the noise. */
const stamped = process.env.AI_PROXY_DAEMONIZED === '1';
const prefix = () => (stamped ? `${new Date().toISOString()} ` : '');

export const Logger = {
  success: msg => console.log(`${prefix()}${paint(32, '✔')} ${msg}`),
  error: msg => console.error(`${prefix()}${paint(31, '✖')} ${msg}`),
  info: msg => console.log(`${prefix()}${paint(34, 'ℹ')} ${msg}`),
  warn: msg => console.warn(`${prefix()}${paint(33, '▲')} ${msg}`),
  plain: msg => console.log(`${prefix()}${msg}`),

  /** Section heading. */
  header: msg => console.log(`\n${paint(1, paint(36, `── ${msg} ──`))}`),

  /** Dim secondary text. */
  dim: msg => console.log(`${prefix()}${paint(90, msg)}`),

  /** Emphasised inline value, for embedding in other messages. */
  value: text => paint(1, text),

  divider: () => console.log(paint(90, '─'.repeat(56)))
};
