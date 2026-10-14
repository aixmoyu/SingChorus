/**
 * Cloud package version, declared as a literal because the Workers runtime
 * has no fs access to read package.json. A node-group test pins this
 * constant against package.json to prevent drift.
 */
export const CLOUD_VERSION = '0.1.0';
