export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 500,
    public details?: Record<string, unknown>,
  ) { super(message) }
}

export const ERRORS = {
  CFG_NOT_FOUND:    { code: 'CFG_NOT_FOUND',    message: 'Configuration not found',    status: 404 },
  CFG_DUPLICATE:    { code: 'CFG_DUPLICATE',    message: 'Configuration already exists', status: 409 },
  CFG_NAME_REQUIRED: { code: 'CFG_NAME_REQUIRED', message: 'Name is required',          status: 422 },
  CFG_TAG_IMMUTABLE: { code: 'CFG_TAG_IMMUTABLE', message: 'Tag cannot be changed after creation', status: 400 },
  CFG_PORT_CONFLICT: { code: 'CFG_PORT_CONFLICT', message: 'Port already in use by another config on this machine', status: 409 },
  CFG_NONE_ENABLED: { code: 'CFG_NONE_ENABLED',  message: 'No enabled configs to deploy', status: 400 },
  DEPLOY_FAILED:    { code: 'DEPLOY_FAILED',     message: 'Deployment failed',           status: 500 },
  CLOUD_UNREACHABLE:  { code: 'CLOUD_UNREACHABLE',   message: 'Cloud service unreachable',  status: 503 },
  CLOUD_GENERATE_FAILED: { code: 'CLOUD_GENERATE_FAILED', message: 'Config generation failed', status: 502 },
  INVALID_FINGERPRINT: { code: 'INVALID_FINGERPRINT', message: 'Fingerprint must be 8-128 chars of letters, digits, "_" or "-"', status: 422 },
} as const;
