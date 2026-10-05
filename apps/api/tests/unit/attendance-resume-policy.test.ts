import { describe, expect, it } from 'vitest';
import { validateResumeTarget } from '../../src/modules/attendance/resume-policy.js';

const ready = { hasActiveSession: true, hasCompatibleCursor: true, hasPublishedAutomation: true, hasMenuNode: true };
describe('explicit resume target policy', () => {
  it('rejects continuing a legacy conversation without manufacturing a cursor', () => {
    expect(() => validateResumeTarget({ ...ready, target: { kind: 'CONTINUE' }, hasActiveSession: false }))
      .toThrow('ATTENDANCE_RESUME_CURSOR_UNAVAILABLE');
    expect(() => validateResumeTarget({ ...ready, target: { kind: 'CONTINUE' }, hasCompatibleCursor: false }))
      .toThrow('ATTENDANCE_RESUME_CURSOR_UNAVAILABLE');
  });
  it('requires a real menu in the pinned published version', () => {
    expect(() => validateResumeTarget({ ...ready, target: { kind: 'MENU', nodeId: 'missing' }, hasMenuNode: false }))
      .toThrow('ATTENDANCE_RESUME_MENU_UNAVAILABLE');
    expect(() => validateResumeTarget({ ...ready, target: { kind: 'MENU', nodeId: 'menu' }, hasActiveSession: false }))
      .toThrow('ATTENDANCE_RESUME_NEW_SESSION_REQUIRED');
  });
  it('requires a published automation before reserving a new session', () => {
    expect(() => validateResumeTarget({ ...ready, target: { kind: 'NEW_SESSION' }, hasPublishedAutomation: false }))
      .toThrow('AUTOMATION_NOT_PUBLISHED');
    expect(() => validateResumeTarget({ ...ready, target: { kind: 'NEW_SESSION' }, hasActiveSession: false })).not.toThrow();
    expect(() => validateResumeTarget({ ...ready, target: { kind: 'CONTINUE' } })).not.toThrow();
  });
});
