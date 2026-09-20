/**
 * What this turn actually touched, under the reply that claims it.
 *
 * The harness has always published `evidenceRefs` on its typed terminal —
 * receipts for external writes that settled, artifacts produced, sources read,
 * memories used — and until 2026-09-19 no client read the field, so "done"
 * rested entirely on the prose above it. This is the ledger row that replaces
 * that trust: counts the harness proved, and an open affordance for the refs
 * that carry somewhere to go.
 *
 * It renders nothing when the terminal proved nothing. A legacy turn is not a
 * turn with zero evidence, and must not be drawn as one.
 */
import { useState } from 'react';
import { FileText, Send, BookOpen, Brain, Wrench } from 'lucide-react';
import { evidenceChips, openableEvidence, type EvidenceChip, type TerminalFacts } from '@clem/chat-engine';
import { localPathFromUri, openFile } from '@/lib/files';

const ICON: Record<EvidenceChip['kind'], typeof FileText> = {
  external_receipt: Send,
  artifact: FileText,
  memory: Brain,
  source: BookOpen,
  tool_result: Wrench,
};

export function TurnEvidenceLine({ terminal }: { terminal?: TerminalFacts }) {
  const [problem, setProblem] = useState('');
  const chips = evidenceChips(terminal?.evidenceRefs);
  if (chips.length === 0) return null;

  const reveal = (uri: string) => {
    setProblem('');
    void openFile(uri).then((result) => { if (!result.ok) setProblem(result.reason); });
  };

  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1" aria-label="What this turn touched">
        {chips.map((chip) => {
          const Icon = ICON[chip.kind];
          // Only a ref that resolves to a local path can actually be opened;
          // everything else stays an honest count.
          const target = openableEvidence(chip.refs).find((ref) => localPathFromUri(ref.uri));
          const body = (
            <>
              <Icon className="h-3 w-3 shrink-0" strokeWidth={2.25} aria-hidden />
              {chip.label}
            </>
          );
          return target ? (
            <button
              key={chip.kind}
              type="button"
              onClick={() => reveal(target.uri)}
              title={`Open ${target.id}`}
              className="inline-flex items-center gap-1 rounded-sm bg-subtle px-1.5 py-0.5 text-caption font-medium text-fg transition-colors hover:bg-subtle-hover hover:text-primary"
            >
              {body}
            </button>
          ) : (
            <span key={chip.kind} className="inline-flex items-center gap-1 text-caption font-medium text-faint">
              {body}
            </span>
          );
        })}
      </div>
      {problem && <p className="mt-1 text-caption text-warning" role="status">{problem}</p>}
    </div>
  );
}
