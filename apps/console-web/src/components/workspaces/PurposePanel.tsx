/**
 * The Workspace operating contract, readable and safely editable. The contract
 * is advisory — it defines what must stay true, not how Clem works — so the
 * editor explains consequences in user language, surfaces every limit
 * explicitly (no silent truncation, no silent no-ops), and shows the server's
 * own error text when a save is refused.
 */
import { useState } from 'react';
import { Pencil, ShieldCheck, Target } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import { patchSpace, type SpaceRecord } from '@/lib/spaces';
import { validateContractDraft, OBJECTIVE_MAX_CHARS } from '@/lib/contract-edit';

export function PurposePanel({ space, onSaved }: { space: SpaceRecord; onSaved: () => void }) {
  const contract = space.contract;
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState('');
  const [criteriaText, setCriteriaText] = useState('');
  const [invariantsText, setInvariantsText] = useState('');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  const startEdit = () => {
    setObjective(contract?.objective ?? '');
    setCriteriaText((contract?.successCriteria ?? []).join('\n'));
    setInvariantsText((contract?.invariants ?? []).join('\n'));
    setErrors([]);
    setWarnings([]);
    setEditing(true);
  };

  const save = async () => {
    const validation = validateContractDraft({
      objective,
      criteriaText,
      invariantsText,
      hadContract: Boolean(contract),
    });
    setWarnings(validation.warnings);
    if (!validation.ok || !validation.patch) {
      setErrors(validation.errors);
      return;
    }
    setSaving(true);
    setErrors([]);
    try {
      await patchSpace(space.id, validation.patch);
      setEditing(false);
      onSaved();
    } catch (err) {
      // Surface the server's own refusal (e.g. "a contract needs an objective")
      // instead of a generic failure.
      const message = err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'The change could not be saved.';
      setErrors([message]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-small font-semibold text-fg">
          <Target className="h-3.5 w-3.5" aria-hidden /> Purpose
        </p>
        {!editing && (
          <Button variant="ghost" size="sm" onClick={startEdit} aria-label={contract ? 'Edit purpose' : 'Add purpose'}>
            <Pencil className="h-3.5 w-3.5" aria-hidden /> {contract ? 'Edit' : 'Add'}
          </Button>
        )}
      </div>

      {!editing && contract && (
        <div className="space-y-2 text-small text-muted">
          <p className="text-fg">{contract.objective}</p>
          {contract.successCriteria.length > 0 && (
            <div>
              <p className="text-caption font-medium text-faint">Done when</p>
              <ul className="mt-1 list-disc space-y-1 pl-4">
                {contract.successCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}
              </ul>
            </div>
          )}
          {contract.invariants.length > 0 && (
            <div>
              <p className="flex items-center gap-1 text-caption font-medium text-faint">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Always preserve
              </p>
              <ul className="mt-1 list-disc space-y-1 pl-4">
                {contract.invariants.map((invariant) => <li key={invariant}>{invariant}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {!editing && !contract && (
        <p className="text-small text-muted">
          No purpose is pinned yet. Tell Clem what this workspace should accomplish and what must never drift — or add it here.
        </p>
      )}

      {editing && (
        <div className="space-y-3">
          <div>
            <label htmlFor="purpose-objective" className="text-caption font-medium text-faint">Purpose</label>
            <Textarea
              id="purpose-objective"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              rows={2}
              placeholder="What should this workspace accomplish?"
            />
            <p className={`mt-0.5 text-caption ${objective.trim().length > OBJECTIVE_MAX_CHARS ? 'text-danger' : 'text-faint'}`}>
              {objective.trim().length}/{OBJECTIVE_MAX_CHARS}
              {contract && !objective.trim() ? ' · blank keeps the current purpose' : ''}
            </p>
          </div>
          <div>
            <label htmlFor="purpose-criteria" className="text-caption font-medium text-faint">Done when (one per line)</label>
            <Textarea
              id="purpose-criteria"
              value={criteriaText}
              onChange={(e) => setCriteriaText(e.target.value)}
              rows={3}
              placeholder={'Every row cites a fresh source\nThe board loads with zero placeholders'}
            />
          </div>
          <div>
            <label htmlFor="purpose-invariants" className="text-caption font-medium text-faint">Always preserve (one per line)</label>
            <Textarea
              id="purpose-invariants"
              value={invariantsText}
              onChange={(e) => setInvariantsText(e.target.value)}
              rows={2}
              placeholder="Never write to an external system without approval"
            />
          </div>

          {errors.map((error) => (
            <p key={error} className="rounded-sm bg-danger-tint px-2 py-1 text-caption text-danger">{error}</p>
          ))}
          {warnings.map((warning) => (
            <p key={warning} className="rounded-sm bg-warning-tint px-2 py-1 text-caption text-warning">{warning}</p>
          ))}

          <p className="text-caption text-faint">
            This is Clem’s north star for the workspace — what must stay true, not how she works.
            Changing it never invalidates completed work; she applies it from the next turn on.
          </p>

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save purpose'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
