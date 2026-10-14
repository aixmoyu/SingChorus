/**
 * Core package version, declared as a literal because src/ cannot import
 * package.json (tsconfig includes/excludes and bundling keep them separate).
 * A test pins this constant against package.json to prevent drift.
 */
export const CORE_VERSION = '0.1.1';
