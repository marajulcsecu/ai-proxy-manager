/**
 * @fileoverview Error types that map cleanly onto CLI exit codes.
 */

/** Bad arguments or a request that cannot be satisfied — exits with code 1. */
export class UsageError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'UsageError';
    this.hint = hint;
  }
}
