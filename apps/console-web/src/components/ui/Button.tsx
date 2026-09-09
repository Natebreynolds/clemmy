import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
type Size = 'sm' | 'md' | 'icon';

const base =
  'inline-flex items-center justify-center gap-2 rounded-md font-semibold ' +
  'transition-[background-color,border-color,color] duration-fast ' +
  // The one press, from the token layer: a 0.97 nudge, not a squash. It is a
  // transform, so reduced-motion drops it while the colour change survives.
  'active:scale-press motion-reduce:active:scale-100 ' +
  'disabled:pointer-events-none disabled:opacity-50 select-none whitespace-nowrap app-no-drag cursor-pointer';

const variants: Record<Variant, string> = {
  primary: 'bg-primary text-primary-fg hover:bg-primary-hover active:bg-primary-press',
  secondary: 'bg-surface text-fg border border-border hover:bg-hover hover:border-border-strong',
  ghost: 'text-muted hover:bg-hover hover:text-fg',
  /* Was `bg-danger text-white hover:opacity-90`. Two defects in nine words: a
   * literal label that measured 3.07:1 in dark mode, and a hover expressed as
   * opacity — which no contrast test can follow, and which made the label
   * worse at the moment of the click. Both states are tokens now, and
   * design-tokens.contrast.test.ts asserts this string as well as the ratios. */
  danger: 'bg-danger text-danger-fg hover:bg-danger-hover active:bg-danger-press',
  link: 'text-primary hover:underline underline-offset-4 px-0',
};

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-small',
  md: 'h-11 px-4 text-body',
  icon: 'h-10 w-10 p-0',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(base, variants[variant], sizes[size], className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
