import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme, type ThemeChoice } from '@/lib/theme';
import { Button } from './ui/Button';

const NEXT_LABEL: Record<ThemeChoice, string> = {
  light: 'Switch to dark theme',
  dark: 'Switch to system theme',
  system: 'Switch to light theme',
};

export function ThemeToggle() {
  const { choice, cycle } = useTheme();
  const Icon = choice === 'light' ? Sun : choice === 'dark' ? Moon : Monitor;
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycle}
      aria-label={NEXT_LABEL[choice]}
      title={`Theme: ${choice}`}
    >
      <Icon className="h-5 w-5" aria-hidden />
    </Button>
  );
}
