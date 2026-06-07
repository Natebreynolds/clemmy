import { useState } from 'react';
import { Clock } from 'lucide-react';
import { Select, Input } from '@/components/ui/Field';
import { humanizeCron, parseCron, buildCron, timezoneOptions, detectedTimezone, type ScheduleModel, type ScheduleMode } from '@/lib/cron';
import { cn } from '@/lib/cn';

const MODE_LABELS: { value: ScheduleMode; label: string }[] = [
  { value: 'manual', label: 'Only when I start it' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Every weekday (Mon–Fri)' },
  { value: 'weekends', label: 'Every weekend' },
  { value: 'days', label: 'Specific days' },
  { value: 'hourly', label: 'Every hour (within a window)' },
];

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function hourLabel(h: number): string {
  const am = h < 12;
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${am ? 'AM' : 'PM'}`;
}

/** Friendly schedule picker. Reads/writes a cron string but never shows
 *  one (except the explicit Custom escape hatch). */
export function ScheduleEditor({ value, onChange, timezone, onTimezoneChange }: {
  value: string; onChange: (cron: string) => void;
  timezone?: string; onTimezoneChange?: (tz: string) => void;
}) {
  const [model, setModel] = useState<ScheduleModel>(() => parseCron(value));

  const set = (partial: Partial<ScheduleModel>) => {
    const next = { ...model, ...partial };
    setModel(next);
    onChange(buildCron(next));
  };

  const toggleDay = (d: number) => {
    const has = model.days.includes(d);
    set({ days: has ? model.days.filter((x) => x !== d) : [...model.days, d] });
  };

  const cron = buildCron(model);
  const modes = model.mode === 'custom' ? [...MODE_LABELS, { value: 'custom' as ScheduleMode, label: 'Custom (advanced)' }] : MODE_LABELS;

  return (
    <div className="rounded-md border border-border bg-canvas p-4">
      <label className="mb-1.5 block text-label text-fg">Runs</label>
      <Select value={model.mode} onChange={(e) => set({ mode: e.target.value as ScheduleMode })} aria-label="How often it runs">
        {modes.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </Select>

      {(model.mode === 'daily' || model.mode === 'weekdays' || model.mode === 'weekends' || model.mode === 'days') && (
        <div className="mt-3">
          {model.mode === 'days' && (
            <div className="mb-3">
              <span className="mb-1.5 block text-label text-fg">On these days</span>
              <div className="flex gap-1.5">
                {DAY_LETTERS.map((letter, d) => (
                  <button key={d} type="button" onClick={() => toggleDay(d)} aria-label={DAY_FULL[d]} aria-pressed={model.days.includes(d)}
                    className={cn('h-9 w-9 rounded-full text-small font-semibold transition-colors cursor-pointer',
                      model.days.includes(d) ? 'bg-primary text-primary-fg' : 'bg-subtle text-muted hover:bg-hover')}>
                    {letter}
                  </button>
                ))}
              </div>
            </div>
          )}
          <label className="mb-1.5 block text-label text-fg">At</label>
          <Input type="time" value={model.time} onChange={(e) => set({ time: e.target.value })} className="w-40" aria-label="Time" />
        </div>
      )}

      {model.mode === 'hourly' && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1.5 block text-label text-fg">From</label>
            <Select value={model.startHour} onChange={(e) => set({ startHour: Number(e.target.value) })} className="w-28" aria-label="Start hour">
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </Select>
          </div>
          <div>
            <label className="mb-1.5 block text-label text-fg">To</label>
            <Select value={model.endHour} onChange={(e) => set({ endHour: Number(e.target.value) })} className="w-28" aria-label="End hour">
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </Select>
          </div>
        </div>
      )}

      {model.mode === 'custom' && (
        <div className="mt-3">
          <label className="mb-1.5 block text-label text-fg">Custom schedule (cron)</label>
          <Input value={model.raw} onChange={(e) => set({ raw: e.target.value })} className="font-mono" aria-label="Cron expression" placeholder="e.g. 0 9 * * 1-5" />
        </div>
      )}

      {model.mode !== 'manual' && onTimezoneChange && (
        <div className="mt-3">
          <label className="mb-1.5 block text-label text-fg">Time zone</label>
          <Select value={timezone || detectedTimezone()} onChange={(e) => onTimezoneChange(e.target.value)} className="w-full max-w-xs" aria-label="Time zone">
            {timezoneOptions().map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
          </Select>
          <p className="mt-1 text-caption text-faint">So "{model.mode === 'hourly' ? 'the window' : 'the time'}" means your local time, not the server's.</p>
        </div>
      )}

      <div className="mt-3 flex items-center gap-1.5 text-small text-primary">
        <Clock className="h-4 w-4" aria-hidden />
        <span>{model.mode === 'manual' ? 'Runs only when you start it' : humanizeCron(cron, timezone)}</span>
      </div>
    </div>
  );
}
