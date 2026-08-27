/**
 * @fileoverview Utility for formatted console logging.
 * Keeps output consistent and readable for the CLI user.
 */

export const Logger = {
  success: (msg) => console.log(`\x1b[32m✅ SUCCESS:\x1b[0m ${msg}`),
  error: (msg) => console.error(`\x1b[31m❌ ERROR:\x1b[0m ${msg}`),
  info: (msg) => console.log(`\x1b[34mℹ️ INFO:\x1b[0m ${msg}`),
  warn: (msg) => console.warn(`\x1b[33m⚠️ WARNING:\x1b[0m ${msg}`),
  
  // Custom format for tables or headers
  header: (msg) => {
    console.log(`\n\x1b[1m\x1b[36m=== ${msg.toUpperCase()} ===\x1b[0m`);
  },
  
  divider: () => console.log('-'.repeat(50))
};
