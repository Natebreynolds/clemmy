import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, Mic } from 'lucide-react';
import { DogMark } from './DogMark';
import { Button } from './ui/Button';
import { RealtimeVoice, type VoiceStatus } from '@/lib/voice';
import { cn } from '@/lib/cn';

const HALO: Record<VoiceStatus, string> = {
  connecting: 'animate-breathe opacity-50',
  listening: 'animate-breathe opacity-70',
  thinking: 'animate-breathe opacity-40',
  speaking: 'opacity-90',
  error: 'opacity-30',
  idle: 'opacity-50',
};

export function VoiceOverlay() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<VoiceStatus>('connecting');
  const [label, setLabel] = useState('Connecting…');
  const [userText, setUserText] = useState('');
  const [assistantText, setAssistantText] = useState('');
  const [error, setError] = useState('');
  const voiceRef = useRef<RealtimeVoice | null>(null);

  const close = () => {
    voiceRef.current?.stop();
    voiceRef.current = null;
    setOpen(false);
  };

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('clem:open-voice', onOpen);
    return () => window.removeEventListener('clem:open-voice', onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(''); setUserText(''); setAssistantText(''); setStatus('connecting'); setLabel('Connecting…');
    const voice = new RealtimeVoice({
      onStatus: (s, l) => { setStatus(s); if (l) setLabel(l); },
      onUserText: setUserText,
      onAssistantText: setAssistantText,
    });
    voiceRef.current = voice;
    voice.start().catch((e: Error) => { setStatus('error'); setError(e.message || 'Voice unavailable.'); });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); voice.stop(); voiceRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[120] flex flex-col items-center justify-center bg-canvas/95 backdrop-blur-sm animate-fade-in">
      <button type="button" onClick={close} aria-label="Close voice" className="absolute right-5 top-5 cursor-pointer rounded-md p-2 text-muted hover:bg-hover hover:text-fg">
        <X className="h-6 w-6" aria-hidden />
      </button>

      <div className="relative mb-8 flex h-48 w-48 items-center justify-center">
        <div className={cn('absolute inset-0 rounded-full bg-primary/30 blur-2xl', HALO[status])} aria-hidden />
        <div className={cn('absolute inset-4 rounded-full border-2', status === 'error' ? 'border-danger/40' : 'border-primary/40', status === 'speaking' && 'animate-breathe')} aria-hidden />
        <div className="relative flex h-32 w-32 items-center justify-center rounded-full bg-surface shadow-warm-halo">
          <DogMark size={88} />
        </div>
      </div>

      <h2 className="text-h2 text-fg">{error ? 'Voice unavailable' : label}</h2>

      {error ? (
        <div className="mt-3 max-w-md text-center">
          <p className="text-body text-muted">{error}</p>
          <div className="mt-4 flex justify-center gap-2">
            <Link to="/connect"><Button variant="secondary" size="sm">Add your OpenAI key</Button></Link>
            <Button size="sm" onClick={close}>Close</Button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-6 min-h-16 max-w-lg px-6 text-center">
            {userText && <p className="text-small text-faint">“{userText}”</p>}
            {assistantText && <p className="mt-2 text-body-lg text-fg">{assistantText}</p>}
          </div>
          <Button variant="secondary" onClick={close} className="mt-6">
            <Mic className="h-4 w-4" aria-hidden /> Stop talking
          </Button>
        </>
      )}
    </div>
  );
}
