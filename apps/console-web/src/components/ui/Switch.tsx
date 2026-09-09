import { cn } from '@/lib/cn';

/**
 * Minimal accessible toggle.
 *
 * The knob used to be `bg-white shadow-sm`: the drop shadow WAS the affordance
 * that separated the disc from the track. With elevation moved to a hairline,
 * the disc separates on its own 1px ring instead — which also fixes the case
 * the shadow never handled, an off-state white disc on a pale track, where the
 * only thing distinguishing them was a 6%-alpha smudge.
 *
 * It had no focus indicator at all: a `<button role="switch">` inherits the
 * base :focus-visible outline, but this one carries a `rounded-full` and sat
 * inside rows that clip, so the ring is declared here explicitly.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border',
        'transition-colors duration-fast cursor-pointer disabled:opacity-50',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        checked ? 'border-primary bg-primary' : 'border-border-strong bg-subtle',
      )}
    >
      <span
        className={cn(
          'inline-block h-[18px] w-[18px] transform rounded-full bg-surface ring-1 ring-border-strong',
          'transition-transform duration-fast motion-reduce:transition-none',
          checked ? 'translate-x-[19px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
