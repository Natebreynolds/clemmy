import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { DogMark } from '@/components/DogMark';
import { Button } from '@/components/ui/Button';
import { OnboardingModels } from '@/components/onboarding/OnboardingModels';
import { OnboardingJev, OnboardingVoice } from '@/components/onboarding/OnboardingExtras';
import { clemmy } from '@/lib/clemmy';
import { usePoll } from '@/lib/poll';
import { getSettings, getJevStatus } from '@/lib/settings';
import { getCredentials } from '@/lib/connect';
import { selectedOnboardingBrain } from '@/lib/onboarding-models';
import { finishOnboarding } from '@/lib/onboarding-finish';
import { onboardingCompletionNavigation } from '@/lib/onboarding-entry';
import './onboarding.css';

const steps = ['Connect', 'Work checks', 'Voice', 'Ready'] as const;
const titles = ['Meet your new assistant.', 'An extra check on the work.', 'Talk with Clem.', 'Let’s do something useful.'];
const descriptions = [
  'Connect one account you already use. Then tell Clem what you need — she brings the memory, tools, and follow-through.',
  'Give Clem an extra way to check her work with Jev.',
  'Live voice is a nice extra. Your keyboard is already invited.',
  'Start small. You can connect your apps, folders, and projects as you need them.',
];

export function Onboarding() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelDirty, setModelDirty] = useState(false);
  const [discardModels, setDiscardModels] = useState(0);
  const [jevBusy, setJevBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const finishLatch = useRef(false);
  const settings = usePoll(['settings'], getSettings, 5_000);
  const jev = usePoll(['jev'], getJevStatus, 0);
  const credentials = usePoll(['credentials'], getCredentials, 0);
  const selected = settings.error ? null : selectedOnboardingBrain(settings.data);
  const busy = modelBusy || jevBusy || voiceBusy || finishing;
  const bridge = clemmy();
  const oldShell = bridge !== null && !bridge.onboardingComplete;
  const onModelBusy = useCallback((value: boolean) => setModelBusy(value), []);
  const onModelDirty = useCallback((value: boolean) => setModelDirty(value), []);
  const onJevBusy = useCallback((value: boolean) => setJevBusy(value), []);
  const onVoiceBusy = useCallback((value: boolean) => setVoiceBusy(value), []);
  useEffect(() => { if (step > 0) heading.current?.focus(); }, [step]);
  const changeStep = (next: number) => { if (!busy && (!modelDirty || next === 0)) { setError(null); setStep(next); window.scrollTo(0, 0); } };
  const finish = async (explore: boolean) => {
    if (busy || modelDirty || finishLatch.current) return;
    finishLatch.current = true; setFinishing(true); setError(null);
    try {
      await finishOnboarding(explore, { isDesktop: bridge !== null, readSettings: getSettings,
        complete: bridge?.onboardingComplete });
      const destination = onboardingCompletionNavigation(explore);
      navigate(destination.pathname, { replace: true, state: destination.state });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not finish setup. Your connections are saved. Please try again.');
    } finally { finishLatch.current = false; setFinishing(false); }
  };

  return <div className="clem-setup">
    <header className="clem-setup-header"><a href="#setup-main" className="clem-setup-brand"><DogMark size={40} /><span>Clementine</span></a><span className="text-small text-muted">Make yourself at home.</span></header>
    <div className="clem-setup-layout">
      <nav className="clem-setup-progress" aria-label="Setup progress"><ol>{steps.map((label, index) => <li key={label}>
        <button type="button" aria-current={step === index ? 'step' : undefined} disabled={busy || index > step || modelDirty && index !== 0} onClick={() => changeStep(index)}>
          <span className="clem-setup-step-mark" aria-hidden>{index < step ? <Check size={15} /> : index + 1}</span><span>{label}{index === 1 || index === 2 ? <small>Optional</small> : null}</span>
        </button>
      </li>)}</ol><p>One connection gets you started. Everything else can wait until you need it.</p></nav>
      <main id="setup-main" className="clem-setup-main">
        <div className="clem-setup-intro"><h1 ref={heading} tabIndex={-1}>{titles[step]}</h1><p>{descriptions[step]}</p></div>
        <div hidden={step !== 0}><OnboardingModels onBusyChange={onModelBusy} onDirtyChange={onModelDirty} discardRequest={discardModels} /></div>
        <div hidden={step !== 1}><OnboardingJev onBusyChange={onJevBusy} /></div>
        <div hidden={step !== 2}><OnboardingVoice onBusyChange={onVoiceBusy} /></div>
        <div hidden={step !== 3} className="clem-setup-ready">
          <dl>
            <div><dt>Main model</dt><dd>{settings.isLoading ? 'Checking…' : settings.error ? 'Could not check · return to Connect' : selected?.label ?? 'Not connected yet'}</dd></div>
            <div><dt>Backup models</dt><dd>{settings.error ? 'Could not check' : `${settings.data?.modelRoles?.brainBackups?.modelIds.length ?? 0} selected`}</dd></div>
            <div><dt>Jev checks</dt><dd>{jev.isLoading ? 'Checking…' : jev.error ? 'Could not check' : !jev.data?.configured ? 'Not connected · add later' : jev.data.warning ? 'Key saved · availability not confirmed' : jev.data.enabled ? 'Key saved · enabled' : 'Key saved · paused'}</dd></div>
            <div><dt>Live voice</dt><dd>{credentials.isLoading ? 'Checking…' : credentials.error ? 'Could not check' : credentials.data?.auth?.openaiApiKeyPresent ? 'Key saved · no voice test run' : 'Not connected · add later'}</dd></div>
          </dl>
          <p className="text-small text-muted">These are your saved settings. Your first chat request will try the main model; no main-model request or live voice test has run during setup.</p>
          <div className="clem-setup-first-task"><h2>Something to try first</h2><p>“Help me plan my week. Ask what matters, then help me choose a first step.”</p></div>
          {!selected && <p className="text-body text-muted">Feel free to look around. Clem needs a main model before she can work on a request.</p>}
        </div>
        {error && <p role="alert" className="clem-setup-error">{error}</p>}
        {modelBusy && <p role="status" className="mt-6 text-small text-muted">A connection or model save is in progress. Your choices will stay here while it finishes.</p>}
        {modelDirty && <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-muted" role="status">
          <p>Save your model changes above, or discard the unsaved choices before continuing. Saved connections stay connected.</p>
          <Button variant="link" size="sm" disabled={busy} onClick={() => setDiscardModels(value => value + 1)}>Discard unsaved choices</Button>
        </div>}
        <footer className="clem-setup-footer">
          <div>{step > 0 && <Button variant="ghost" disabled={busy} onClick={() => changeStep(step - 1)}><ArrowLeft size={16} aria-hidden />Back</Button>}</div>
          <div className="clem-setup-actions">
            {step === 0 ? <>
              <Button variant="ghost" disabled={busy || modelDirty} onClick={() => changeStep(1)}>Optional setup</Button>
              <Button variant={selected ? 'primary' : 'secondary'} disabled={busy || modelDirty || oldShell} onClick={() => void finish(!selected)}>
                {finishing ? 'Finishing…' : selected ? 'Start with Clem' : 'Continue without a model'}<ArrowRight size={16} aria-hidden />
              </Button>
            </> : step < 3 ? <>
              <Button disabled={busy} onClick={() => changeStep(step + 1)}>{step === 1 ? jev.data?.configured ? 'Next: voice' : 'Skip extra checks' : credentials.data?.auth?.openaiApiKeyPresent ? 'Continue' : 'Skip voice for now'}<ArrowRight size={16} aria-hidden /></Button>
            </> : <>
              {!selected && <Button variant="secondary" disabled={busy} onClick={() => changeStep(0)}>Connect a model</Button>}
              <Button disabled={busy || modelDirty || oldShell} onClick={() => void finish(!selected)}>{finishing ? 'Finishing…' : selected ? 'Meet me in chat' : 'Continue without a model'}<ArrowRight size={16} aria-hidden /></Button>
            </>}
          </div>
        </footer>
        {oldShell && <p className="text-small text-muted">This desktop version needs an update to save the new setup. <Button variant="link" disabled={busy || modelDirty} onClick={() => { if (!busy && !modelDirty) navigate('/chat'); }}>Return to Clem</Button></p>}
      </main>
    </div>
  </div>;
}
