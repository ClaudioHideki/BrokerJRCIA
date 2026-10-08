import { describe, expect, it } from 'vitest';
import { isBusinessOpen } from '../../src/modules/automations/business-hours.js';
import type { ScheduleNodeConfig } from '../../../../packages/contracts/src/automation-schedule.js';

const config: ScheduleNodeConfig = { timezone: 'America/Sao_Paulo', weekly: [{ day: 1, start: '08:00', end: '18:00' }] };
const at = (value: string) => new Date(value);

describe('deterministic business hours', () => {
  it.each([
    ['2026-10-05T10:59:59.999Z', false],
    ['2026-10-05T11:00:00.000Z', true],
    ['2026-10-05T20:59:59.999Z', true],
    ['2026-10-05T21:00:00.000Z', false],
  ])('keeps start inclusive and end exclusive at %s', (instant, expected) => {
    expect(isBusinessOpen(config, at(instant))).toBe(expected);
  });

  it('maps Sunday to day zero and considers every interval of that day', () => {
    const sunday = { timezone: 'UTC', weekly: [{ day: 0, start: '08:00', end: '09:00' }, { day: 0, start: '15:00', end: '16:00' }] };
    expect(isBusinessOpen(sunday, at('2026-10-04T08:00:00Z'))).toBe(true);
    expect(isBusinessOpen(sunday, at('2026-10-04T12:00:00Z'))).toBe(false);
    expect(isBusinessOpen(sunday, at('2026-10-04T15:30:00Z'))).toBe(true);
    expect(isBusinessOpen(sunday, at('2026-10-05T08:00:00Z'))).toBe(false);
  });

  it('uses the local day when UTC has already crossed midnight', () => {
    const sunday = { timezone: 'America/Sao_Paulo', weekly: [{ day: 0, start: '22:00', end: '24:00' }] };
    expect(isBusinessOpen(sunday, at('2026-10-05T02:59:59Z'))).toBe(true);
    expect(isBusinessOpen(sunday, at('2026-10-05T03:00:00Z'))).toBe(false);
  });

  it('replaces weekly hours with a closed holiday or its own intervals', () => {
    const exception = { ...config, exceptions: [{ date: '2026-10-05', intervals: [] }] };
    expect(isBusinessOpen(exception, at('2026-10-05T15:00:00Z'))).toBe(false);
    const changedHours = { ...config, exceptions: [{ date: '2026-10-05', intervals: [{ start: '19:00', end: '20:00' }] }] };
    expect(isBusinessOpen(changedHours, at('2026-10-05T15:00:00Z'))).toBe(false);
    expect(isBusinessOpen(changedHours, at('2026-10-05T22:00:00Z'))).toBe(true);
    expect(isBusinessOpen(changedHours, at('2026-10-05T23:00:00Z'))).toBe(false);
  });

  it('matches exception date in the configured timezone rather than UTC', () => {
    const hours = { timezone: 'America/Sao_Paulo', weekly: [{ day: 0, start: '22:00', end: '24:00' }],
      exceptions: [{ date: '2026-10-04', intervals: [] }] };
    expect(isBusinessOpen(hours, at('2026-10-05T02:30:00Z'))).toBe(false);
  });

  it('applies a valid leap date even when weekly hours are closed', () => {
    const hours = { timezone: 'UTC', weekly: [{ day: 0, start: '08:00', end: '09:00' }],
      exceptions: [{ date: '2028-02-29', intervals: [{ start: '08:00', end: '09:00' }] }] };
    expect(isBusinessOpen(hours, at('2028-02-29T08:30:00Z'))).toBe(true);
  });

  it('evaluates the repeated local hour at both instants during DST fall-back', () => {
    const hours = { timezone: 'America/New_York', weekly: [{ day: 0, start: '01:00', end: '02:00' }] };
    expect(isBusinessOpen(hours, at('2026-11-01T05:30:00Z'))).toBe(true);
    expect(isBusinessOpen(hours, at('2026-11-01T06:30:00Z'))).toBe(true);
    expect(isBusinessOpen(hours, at('2026-11-01T07:00:00Z'))).toBe(false);
  });

  it('does not invent an opening during a nonexistent hour at DST spring-forward', () => {
    const hours = { timezone: 'America/New_York', weekly: [{ day: 0, start: '02:00', end: '03:00' }] };
    expect(isBusinessOpen(hours, at('2026-03-08T06:59:59Z'))).toBe(false);
    expect(isBusinessOpen(hours, at('2026-03-08T07:00:00Z'))).toBe(false);
  });

  it('does not mutate configuration while evaluating', () => {
    const before = structuredClone(config);
    isBusinessOpen(config, at('2026-10-05T15:00:00Z'));
    expect(config).toEqual(before);
  });

  it('rejects invalid clocks instead of silently closing or opening', () => {
    expect(() => isBusinessOpen(config, new Date('invalid'))).toThrow('AUTOMATION_SCHEDULE_CLOCK_INVALID');
    expect(() => isBusinessOpen(config, '2026-10-05T15:00:00Z' as unknown as Date)).toThrow('AUTOMATION_SCHEDULE_CLOCK_INVALID');
  });

  it('distinguishes malformed config from invalid timezone', () => {
    expect(() => isBusinessOpen({ ...config, weekly: [] }, at('2026-10-05T15:00:00Z'))).toThrow('AUTOMATION_SCHEDULE_CONFIG_INVALID');
    expect(() => isBusinessOpen({ ...config, timezone: 'Mars/Olympus' }, at('2026-10-05T15:00:00Z'))).toThrow('AUTOMATION_SCHEDULE_TIMEZONE_INVALID');
  });
});
