import { useEffect, useState, type ComponentType } from 'react';
import { CUSTOMIZE_HOME_EVENT } from '@/lib/customize-home';

/** Drag-and-drop appearance tools load only after the owner asks for them. */
export function CustomizeLauncher() {
  const [Panel, setPanel] = useState<ComponentType<{ initialOpen?: boolean }> | null>(null);
  const [requested, setRequested] = useState(false);
  const [failed, setFailed] = useState(false);
  const load = () => {
    setRequested(true); setFailed(false);
    void import('./CustomizePanel').then(module => setPanel(() => module.CustomizePanel)).catch(() => setFailed(true));
  };
  useEffect(() => {
    const open = () => { if (!Panel) load(); };
    window.addEventListener(CUSTOMIZE_HOME_EVENT, open);
    return () => window.removeEventListener(CUSTOMIZE_HOME_EVENT, open);
  }, [Panel]);
  if (Panel) return <Panel initialOpen />;
  if (!requested) return null;
  return <div role="status" className="fixed bottom-5 right-5 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-small text-fg">
    <span>{failed ? 'Appearance settings couldn’t be loaded.' : 'Opening appearance settings…'}</span>
    {failed ? <button type="button" onClick={load} className="shrink-0 font-semibold text-primary hover:underline">Retry</button> : null}
  </div>;
}
