export class IntegrationError extends Error {
  constructor(readonly code: string, readonly status = 422) { super(code); }
}
