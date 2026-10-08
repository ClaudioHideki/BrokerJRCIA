import { ScheduleNodeConfigSchema } from '@jrc/contracts';

const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const minuteOfDay = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** The injected instant is authoritative; neither server timezone nor wall clock participates. */
export function isBusinessOpen(config: unknown, now: Date): boolean {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('AUTOMATION_SCHEDULE_CLOCK_INVALID');
  const parsed = ScheduleNodeConfigSchema.safeParse(config);
  if (!parsed.success) {
    const timezoneInvalid = parsed.error.issues.some(issue => issue.path[0] === 'timezone');
    throw new Error(timezoneInvalid ? 'AUTOMATION_SCHEDULE_TIMEZONE_INVALID' : 'AUTOMATION_SCHEDULE_CONFIG_INVALID');
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: parsed.data.timezone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map(part => [part.type, part.value]));
  const date = `${parts.year!.padStart(4, '0')}-${parts.month}-${parts.day}`;
  const day = weekdays[parts.weekday!], minute = Number(parts.hour) * 60 + Number(parts.minute);
  const exception = parsed.data.exceptions?.find(item => item.date === date);
  const intervals = exception ? exception.intervals : parsed.data.weekly.filter(item => item.day === day);
  return intervals.some(interval => minute >= minuteOfDay(interval.start) && minute < minuteOfDay(interval.end));
}
