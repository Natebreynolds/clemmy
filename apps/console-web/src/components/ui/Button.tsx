import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
type Size = 'sm' | 'md' | 'icon';

const base =
  'inline-flex items-center justify-center gap-2 rounded-md font-semibold transition-colors duration-fast ' +
  'disabled:pointer-events-none disabled:opacity-50 select-none whitespace-nowrap app-no-drag cursor-pointer';

const variants: Record<Variant, string> = {
  primary: 'bg-primary text-primary-fg hover:bg-primary-hover active:bg-primary-press',
  secondary: 'bg-surface text-fg border border-border hover:bg-hover hover:border-border-strong',
  ghost: 'text-muted hover:bg-hover hover:text-fg',
  danger: 'bg-danger text-white hover:opacity-90',
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
