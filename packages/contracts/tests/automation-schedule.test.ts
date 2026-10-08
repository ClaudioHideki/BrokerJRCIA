import { describe, expect, it } from 'vitest';
import { ScheduleNodeConfigSchema } from '../src/automation-schedule.js';

const valid = { timezone: 'America/Sao_Paulo', weekly: [{ day: 1, start: '08:00', end: '18:00' }] };
const issues = (input: unknown) => {
  const parsed = ScheduleNodeConfigSchema.safeParse(input);
  expect(parsed.success).toBe(false);
  return parsed.success ? [] : parsed.error.issues.map(issue => issue.path.join('.'));
};

describe('schedule node contract', () => {
  it('accepts weekly intervals, leap day exceptions and closed holidays', () => {
    expect(ScheduleNodeConfigSchema.safeParse({ ...valid,
      exceptions: [{ date: '2028-02-29', intervals: [{ start: '10:00', end: '24:00' }] },
        { date: '2026-12-25', intervals: [] }] }).success).toBe(true);
  });

  it.each(['', 'Mars/Olympus', '+03:00', ' America/Sao_Paulo'])('rejects invalid IANA timezone %s at its field', timezone => {
    expect(issues({ ...valid, timezone })).toContain('timezone');
  });

  it.each([
    { day: -1, start: '08:00', end: '18:00', field: 'day' },
    { day: 7, start: '08:00', end: '18:00', field: 'day' },
    { day: 1.5, start: '08:00', end: '18:00', field: 'day' },
    { day: 1, start: '8:00', end: '18:00', field: 'start' },
    { day: 1, start: '24:00', end: '24:00', field: 'start' },
    { day: 1, start: '08:60', end: '18:00', field: 'start' },
    { day: 1, start: '08:00', end: '24:01', field: 'end' },
    { day: 1, start: '18:00', end: '08:00', field: 'end' },
    { day: 1, start: '08:00', end: '08:00', field: 'end' },
  ])('rejects invalid interval $start–$end/day $day', ({ field, ...interval }) => {
    expect(issues({ ...valid, weekly: [interval] })).toContain(`weekly.0.${field}`);
  });

  it('requires one weekly interval and limits the weekly and exception collections', () => {
    expect(issues({ ...valid, weekly: [] })).toContain('weekly');
    expect(issues({ ...valid, weekly: Array.from({ length: 29 }, () => valid.weekly[0]) })).toContain('weekly');
    expect(issues({ ...valid, exceptions: Array.from({ length: 367 }, () => ({ date: '2026-12-25', intervals: [] })) })).toContain('exceptions');
    expect(issues({ ...valid, exceptions: [{ date: '2026-12-25', intervals: Array.from({ length: 5 }, () => ({ start: '08:00', end: '09:00' })) }] })).toContain('exceptions.0.intervals');
  });

  it.each(['2026-02-29', '2100-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-1-01'])('rejects invalid calendar date %s', date => {
    expect(issues({ ...valid, exceptions: [{ date, intervals: [] }] })).toContain('exceptions.0.date');
  });

  it('accepts the leap year rule for a century divisible by 400', () => {
    expect(ScheduleNodeConfigSchema.safeParse({ ...valid, exceptions: [{ date: '2000-02-29', intervals: [] }] }).success).toBe(true);
  });

  it('rejects duplicate exception dates at the second date field', () => {
    expect(issues({ ...valid, exceptions: [{ date: '2026-12-25', intervals: [] },
      { date: '2026-12-25', intervals: [{ start: '10:00', end: '11:00' }] }] })).toContain('exceptions.1.date');
  });

  it('validates exception interval boundaries with the same rules', () => {
    expect(issues({ ...valid, exceptions: [{ date: '2026-12-25', intervals: [{ start: '22:00', end: '02:00' }] }] })).toContain('exceptions.0.intervals.0.end');
  });
});
