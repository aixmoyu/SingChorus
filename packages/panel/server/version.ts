import { createRequire } from 'node:module'

/**
 * Panel package version, read from package.json at runtime via createRequire.
 * This works both in the monorepo (tsx dev) and in the published tarball
 * (dist-server sits next to package.json, which "files" always includes).
 * Cached at module load — the version cannot change within a process.
 */
const require = createRequire(import.meta.url)

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const PANEL_VERSION: string = require('../package.json').version
