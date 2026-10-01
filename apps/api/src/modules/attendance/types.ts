import type { Ownership } from '@jrc/contracts';
export type { AttendanceScope, AttendanceState, AttendanceSession, Ownership } from '@jrc/contracts';

export interface ClaimOwnerInput {
  executor: Ownership['executor']; automationId: string | null; version: number | null; expectedRevision: number;
}
export class AttendanceError extends Error {
  constructor(readonly code: string, readonly statusCode: 403 | 404 | 409 | 422) { super(code); }
}
