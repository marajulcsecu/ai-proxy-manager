/**
 * @fileoverview Reads the package version once, for display in the CLI and
 * dashboard. Kept separate so nothing imports package.json at module scope.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PACKAGE_JSON = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

let cached = null;

/**
 * @returns {string} semver string, or '0.0.0' when package.json is unreadable
 */
export function readPackageVersion() {
  if (cached) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version || '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
