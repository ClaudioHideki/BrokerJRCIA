import { z } from 'zod';

const startClock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const endClock = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;
const intervalFields = {
  start: z.string().regex(startClock, 'Informe o início em HH:mm, de 00:00 a 23:59.'),
  end: z.string().regex(endClock, 'Informe o fim em HH:mm, até 24:00.'),
};
const checkInterval = (interval: { start: string; end: string }, context: z.RefinementCtx) => {
  if (startClock.test(interval.start) && endClock.test(interval.end) && interval.start >= interval.end) {
    context.addIssue({ code: 'custom', path: ['end'],
      message: 'O fim deve ser depois do início. Para atravessar meia-noite, configure outro intervalo no dia seguinte.' });
  }
};
const interval = z.object(intervalFields).superRefine(checkInterval);
const weeklyInterval = z.object({ day: z.number().int().min(0).max(6), ...intervalFields }).superRefine(checkInterval);

function isIanaTimezone(value: string): boolean {
  // Intl also accepts numeric offsets on newer runtimes; those are not IANA identifiers.
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true; }
  catch { return false; }
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

export const ScheduleNodeConfigSchema = z.object({
  timezone: z.string().max(200).refine(isIanaTimezone, 'Informe um fuso IANA válido, como America/Sao_Paulo.'),
  weekly: z.array(weeklyInterval).min(1, 'Adicione ao menos um intervalo semanal.').max(28, 'Use até 28 intervalos semanais.'),
  exceptions: z.array(z.object({
    date: z.string().refine(isCalendarDate, 'Informe uma data válida no formato AAAA-MM-DD.'),
    intervals: z.array(interval).max(4, 'Use até quatro intervalos por exceção.'),
  })).max(366, 'Use até 366 datas de exceção.').optional(),
}).superRefine((config, context) => {
  const seen = new Set<string>();
  for (const [index, exception] of (config.exceptions ?? []).entries()) {
    if (seen.has(exception.date)) context.addIssue({ code: 'custom', path: ['exceptions', index, 'date'],
      message: 'Esta data já tem uma exceção. Reúna os horários na mesma data.' });
    seen.add(exception.date);
  }
});
export type ScheduleNodeConfig = z.infer<typeof ScheduleNodeConfigSchema>;
