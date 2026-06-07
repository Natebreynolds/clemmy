import { forwardRef, useId, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

const fieldClass =
  'w-full rounded-md border border-border bg-canvas px-3 text-body text-fg outline-none transition-colors ' +
  'focus:border-primary placeholder:text-faint disabled:opacity-50';

export function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1.5 block text-label text-fg">{label}</label>
      {children(id)}
      {hint && <p className="mt-1 text-caption text-muted">{hint}</p>}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(fieldClass, 'h-11', className)} {...props} />,
);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn(fieldClass, 'min-h-[88px] py-2.5 resize-y', className)} {...props} />,
);
Textarea.displayName = 'Textarea';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select ref={ref} className={cn(fieldClass, 'h-11 cursor-pointer', className)} {...props}>{children}</select>
  ),
);
Select.displayName = 'Select';
