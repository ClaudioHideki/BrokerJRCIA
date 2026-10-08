import { useId } from 'react';
import { ScheduleNodeConfigSchema } from '@jrc/contracts';

const days = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';

export function ScheduleEditor({ data, onChange, editable }: {
  data: Record<string, unknown>; onChange(data: Record<string, unknown>): void; editable: boolean;
}) {
  const prefix = useId();
  const weekly: unknown[] = Array.isArray(data.weekly) ? data.weekly : [];
  const exceptions: unknown[] = Array.isArray(data.exceptions) ? data.exceptions : [];
  const parsed = ScheduleNodeConfigSchema.safeParse(data);
  const issues = parsed.success ? [] : parsed.error.issues;
  const messages = (path: string) => issues.filter(issue => issue.path.join('.') === path).map(issue => issue.message);
  const errorId = (path: string) => `${prefix}-${path}`;
  const fieldProps = (path: string) => ({ 'aria-invalid': messages(path).length > 0,
    'aria-describedby': messages(path).length ? errorId(path) : undefined });
  const error = (path: string) => messages(path).length > 0
    ? <p role="alert" id={errorId(path)}>{messages(path).join(' ')}</p> : null;
  const patch = (value: Record<string, unknown>) => { if (editable) onChange({ ...data, ...value }); };
  const patchWeekly = (index: number, value: Record<string, unknown>) =>
    patch({ weekly: weekly.map((interval, at) => at === index ? { ...object(interval), ...value } : interval) });
  const patchException = (index: number, value: Record<string, unknown>) =>
    patch({ exceptions: exceptions.map((exception, at) => at === index ? { ...object(exception), ...value } : exception) });
  const clockFields = (interval: Record<string, unknown>, path: string, label: string, update: (value: Record<string, unknown>) => void) => <>
    <label>Início {label}<input aria-label={`Início ${label}`} value={text(interval.start)} maxLength={5} placeholder="08:00"
      inputMode="numeric" {...fieldProps(`${path}.start`)} onChange={event => update({ start: event.target.value })} /></label>
    {error(`${path}.start`)}
    <label>Fim {label}<input aria-label={`Fim ${label}`} value={text(interval.end)} maxLength={5} placeholder="18:00"
      inputMode="numeric" {...fieldProps(`${path}.end`)} onChange={event => update({ end: event.target.value })} /></label>
    {error(`${path}.end`)}
  </>;

  return <fieldset disabled={!editable} className="automation-schedule-editor">
    <legend>Horários de atendimento</legend>
    <label>Fuso horário<input value={text(data.timezone)} maxLength={200} placeholder="America/Sao_Paulo"
      {...fieldProps('timezone')} onChange={event => patch({ timezone: event.target.value })} /></label>
    {error('timezone')}
    <p>Use HH:mm. O fim pode ser 24:00. Para continuar após meia-noite, adicione um intervalo no dia seguinte.</p>
    <h4>Semana</h4>{error('weekly')}
    {weekly.map((raw, index) => {
      const interval = object(raw), path = `weekly.${index}`;
      const day = typeof interval.day === 'number' && Number.isInteger(interval.day) && interval.day >= 0 && interval.day <= 6 ? String(interval.day) : '';
      return <fieldset key={index} aria-label={`Intervalo semanal ${index + 1}`}>
        <legend>Intervalo {index + 1}</legend>{error(path)}
        <label>Dia<select aria-label={`Dia do intervalo ${index + 1}`} value={day} {...fieldProps(`${path}.day`)}
          onChange={event => patchWeekly(index, { day: Number(event.target.value) })}>
          <option value="" disabled>Selecione um dia</option>
          {days.map((name, value) => <option key={name} value={value}>{name}</option>)}
        </select></label>{error(`${path}.day`)}
        {clockFields(interval, path, `do intervalo ${index + 1}`, value => patchWeekly(index, value))}
        <button type="button" disabled={weekly.length <= 1} aria-label={`Remover intervalo ${index + 1}`}
          onClick={() => patch({ weekly: weekly.filter((_, at) => at !== index) })}>Remover intervalo</button>
      </fieldset>;
    })}
    <button type="button" disabled={weekly.length >= 28} onClick={() => patch({ weekly: [...weekly, { day: 1, start: '08:00', end: '18:00' }] })}>Adicionar intervalo semanal</button>
    <h4>Exceções por data</h4>{error('exceptions')}
    <p>Uma exceção substitui os horários da semana naquela data. Sem intervalos, o dia fica fechado.</p>
    {exceptions.map((raw, index) => {
      const exception = object(raw), intervals: unknown[] = Array.isArray(exception.intervals) ? exception.intervals : [];
      const path = `exceptions.${index}`;
      return <fieldset key={index} aria-label={`Exceção ${index + 1}`}>
        <legend>Exceção {index + 1}</legend>{error(path)}
        <label>Data<input aria-label={`Data da exceção ${index + 1}`} value={text(exception.date)} maxLength={10} placeholder="AAAA-MM-DD"
          {...fieldProps(`${path}.date`)} onChange={event => patchException(index, { date: event.target.value })} /></label>
        {error(`${path}.date`)}{error(`${path}.intervals`)}
        {Array.isArray(exception.intervals) && intervals.length === 0 && <p>Fechado nesta data.</p>}
        {intervals.map((rawInterval, at) => <fieldset key={at} aria-label={`Horário da exceção ${index + 1}, intervalo ${at + 1}`}>
          <legend>Horário {at + 1}</legend>{error(`${path}.intervals.${at}`)}
          {clockFields(object(rawInterval), `${path}.intervals.${at}`, `da exceção ${index + 1}, intervalo ${at + 1}`,
            value => patchException(index, { intervals: intervals.map((current, position) => position === at ? { ...object(current), ...value } : current) }))}
          <button type="button" aria-label={`Remover horário da exceção ${index + 1}, intervalo ${at + 1}`}
            onClick={() => patchException(index, { intervals: intervals.filter((_, position) => position !== at) })}>Remover horário</button>
        </fieldset>)}
        <button type="button" aria-label={`Adicionar horário da exceção ${index + 1}`} disabled={intervals.length >= 4}
          onClick={() => patchException(index, { intervals: [...intervals, { start: '08:00', end: '18:00' }] })}>Adicionar horário</button>
        <button type="button" aria-label={`Remover exceção ${index + 1}`}
          onClick={() => patch({ exceptions: exceptions.filter((_, at) => at !== index) })}>Remover exceção</button>
      </fieldset>;
    })}
    <button type="button" disabled={exceptions.length >= 366} onClick={() => patch({ exceptions: [...exceptions, { date: '', intervals: [] }] })}>Adicionar exceção</button>
  </fieldset>;
}
