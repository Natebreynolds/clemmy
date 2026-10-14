import { useRef, useState } from 'preact/hooks';
import { TerminalContinueGate } from '@clem/chat-engine';

/** Mount with the terminal message's key. Eligibility and the latest idle
 * reply target remain the parent's responsibility; this only latches a send. */
export function TerminalContinueButton({ onContinue }: { onContinue: () => Promise<void> }) {
  const gate = useRef(new TerminalContinueGate());
  const [phase, setPhase] = useState(gate.current.phase);
  const [error, setError] = useState(false);
  const request = () => {
    if (gate.current.phase !== 'idle') return;
    setError(false);
    const pending = gate.current.run(onContinue);
    setPhase(gate.current.phase);
    void pending.then(
      () => setPhase(gate.current.phase),
      () => { setPhase(gate.current.phase); setError(true); },
    );
  };
  return (
    <div class="answer-choices">
      <button type="button" class="answer-choice" disabled={phase !== 'idle'} aria-busy={phase === 'sending'} onClick={request}>
        {phase === 'sending' ? 'Continuing…' : phase === 'sent' ? 'Continue requested' : 'Continue'}
      </button>
      {error && <p class="error" role="alert">The request didn’t send. Choose Continue to try again.</p>}
    </div>
  );
}
