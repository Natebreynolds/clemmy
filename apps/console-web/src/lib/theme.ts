import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';
const KEY = 'clem-theme';

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export function readThemeChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch { /* ignore */ }
  return 'light'; // product decision: warm light by default
}

export function resolveIsDark(choice: ThemeChoice): boolean {
  return choice === 'dark' || (choice === 'system' && systemPrefersDark());
}

export function applyTheme(choice: ThemeChoice): void {
  document.documentElement.classList.toggle('dark', resolveIsDark(choice));
}

/** Theme hook: tri-state choice, persisted, follows the OS when 'system'. */
export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(readThemeChoice);

  useEffect(() => {
    applyTheme(choice);
    try { localStorage.setItem(KEY, choice); } catch { /* ignore */ }
  }, [choice]);

  useEffect(() => {
    if (choice !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [choice]);

  const cycle = useCallback(() => {
    setChoice((c) => (c === 'light' ? 'dark' : c === 'dark' ? 'system' : 'light'));
  }, []);

  return { choice, setChoice, cycle, isDark: resolveIsDark(choice) };
}
