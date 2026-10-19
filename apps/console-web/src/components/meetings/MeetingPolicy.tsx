import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Field';
import { Switch } from '@/components/ui/Switch';
import {
  adoptMeetingPolicy, getMeetingPolicy, meetingPolicyChanged, meetingPolicyModelChoices,
  meetingPolicyRequestError, saveMeetingPolicy, selectedMeetingPolicyModel,
  type MeetingPolicyEditor, type MeetingPolicyStage,
} from '@/lib/meeting-policy';

const REQUEST_TIMEOUT_MS = 15_000;

/** Saved defaults only. Per-meeting capture, context and research permissions remain separate. */
export function MeetingPolicy() {
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState<MeetingPolicyEditor | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [needsRead, setNeedsRead] = useState(false);
  const [reviewCurrent, setReviewCurrent] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const alive = useRef(true);
  const reader = useRef<AbortController | null>(null);
  const writer = useRef<AbortController | null>(null);
  const readEpoch = useRef(0);
  const editorRef = useRef(editor);
  editorRef.current = editor;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      readEpoch.current += 1;
      reader.current?.abort();
      writer.current?.abort();
    };
  }, []);

  async function readSaved(keepDraft = false) {
    reader.current?.abort();
    const controller = new AbortController();
    reader.current = controller;
    const epoch = ++readEpoch.current;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    setReading(true);
    setReadError(null);
    try {
      const policy = await getMeetingPolicy(controller.signal);
      if (!alive.current || epoch !== readEpoch.current) return;
      setEditor((previous) => adoptMeetingPolicy(policy, previous, keepDraft));
      setNeedsRead(false);
    } catch (error) {
      if (!alive.current || epoch !== readEpoch.current) return;
      setReadError(meetingPolicyRequestError(error));
    } finally {
      clearTimeout(timeout);
      if (alive.current && epoch === readEpoch.current) {
        reader.current = null;
        setReading(false);
      }
    }
  }

  function toggle(event: SyntheticEvent<HTMLDetailsElement>) {
    const expanded = event.currentTarget.open;
    setOpen(expanded);
    if (expanded && !reader.current && (!editorRef.current || needsRead)) void readSaved(!!editorRef.current);
    if (!expanded && reading) {
      readEpoch.current += 1;
      reader.current?.abort();
      reader.current = null;
      setReading(false);
    }
  }

  async function save() {
    const displayed = editorRef.current;
    if (!displayed || writer.current || reading || needsRead || !meetingPolicyChanged(displayed)) return;
    const controller = new AbortController();
    writer.current = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    setSaving(true);
    setSavedNotice(false);
    setSaveError(null);
    try {
      const policy = await saveMeetingPolicy(displayed, controller.signal);
      if (!alive.current) return;
      setEditor(adoptMeetingPolicy(policy));
      setReviewCurrent(false);
      setNeedsRead(false);
      setSavedNotice(true);
    } catch (error) {
      if (!alive.current) return;
      setSaveError(meetingPolicyRequestError(error, true));
      setNeedsRead(true);
      setReviewCurrent(true);
      // Read only. A fresh click is required for any subsequent mutation.
      await readSaved(true);
    } finally {
      clearTimeout(timeout);
      writer.current = null;
      if (alive.current) setSaving(false);
    }
  }

  const disabled = saving || reading || needsRead;
  function chooseModel(stage: MeetingPolicyStage, id: string) {
    setSavedNotice(false);
    setEditor((previous) => previous ? { ...previous, draft: { ...previous.draft,
      [stage === 'live' ? 'during' : 'after']: { modelId: id || null } } } : previous);
  }

  return <details className="group/meeting-policy mb-6 min-w-0" onToggle={toggle}>
    <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-small font-semibold text-fg">
      <ChevronRight size={16} aria-hidden className="shrink-0 transition-transform group-open/meeting-policy:rotate-90 motion-reduce:transition-none" />
      How Clem helps with meetings
    </summary>
    {open && <div className="min-w-0 max-w-3xl pt-3">
      <p className="mb-5 max-w-prose text-small text-muted">Choose the help you want around a meeting. These preferences are saved across restarts.</p>
      {reading && <p className="mb-4 text-small text-muted" role="status">Reading your saved settings…</p>}
      {readError && <div className="mb-4 space-y-2" role="alert">
        <p className="max-w-prose text-small text-warning">{readError}</p>
        <Button size="sm" variant="secondary" disabled={reading || saving} onClick={() => void readSaved(!!editor)}>Read saved settings again</Button>
      </div>}
      {editor && <>
        {reviewCurrent && !reading && !readError && <div className="mb-5 rounded-lg bg-subtle p-4 text-small" role="status">
          <p className="font-semibold text-fg">Current saved settings</p>
          <ul className="mt-2 space-y-1 text-muted">
            <li>Preparation suggestions: {editor.saved.before.calendarPrepSuggestions ? 'on' : 'off'}</li>
            <li className="break-words">During: {selectedMeetingPolicyModel(editor.saved, 'live', editor.saved.during.modelId).label}</li>
            <li className="break-words">After: {selectedMeetingPolicyModel(editor.saved, 'after', editor.saved.after.modelId).label}</li>
          </ul>
          <p className="mt-2 text-muted">Your choices below are kept. Compare them with these settings before saving again.</p>
        </div>}
        <fieldset disabled={disabled} className="min-w-0 space-y-6 disabled:opacity-70">
          <section aria-labelledby="meeting-policy-before">
            <h3 id="meeting-policy-before" className="mb-2 text-h3 text-fg">Before the meeting</h3>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-small text-fg">Suggest preparation for upcoming meetings</p>
                <p className="mt-1 max-w-prose text-small text-muted">When a connected calendar shows an upcoming meeting, Clem can suggest preparing for it. This doesn’t start recording or change your calendar.</p>
                {editor.saved.preparation && <p className="mt-2 max-w-prose text-caption text-muted">{editor.saved.preparation.message}
                  {editor.saved.preparation.state === 'calendar_needed' && <> <Link to="/connect" className="font-medium text-primary underline underline-offset-4">Connect a calendar</Link></>}
                  {editor.saved.preparation.state === 'watch_off' && <> <Link to="/watching" className="font-medium text-primary underline underline-offset-4">Review calendar watch</Link></>}
                  {editor.saved.preparation.state === 'suggestions_off' && <> <Link to="/heartbeats" className="font-medium text-primary underline underline-offset-4">Review suggestions</Link></>}
                </p>}
              </div>
              <Switch checked={editor.draft.before.calendarPrepSuggestions} disabled={disabled} label="Suggest preparation for upcoming meetings"
                onChange={(checked) => { setSavedNotice(false); setEditor((previous) => previous ? { ...previous,
                  draft: { ...previous.draft, before: { calendarPrepSuggestions: checked } } } : previous); }} />
            </div>
          </section>
          <section aria-labelledby="meeting-policy-during">
            <h3 id="meeting-policy-during" className="mb-2 text-h3 text-fg">During the meeting</h3>
            <p className="mb-3 max-w-prose text-small text-muted">A quick model can notice questions in the live transcript. Recording and live transcript settings stay separate. You still choose whether to allow private lookups for each meeting.</p>
            <ModelChoice stage="live" editor={editor} disabled={disabled} onChange={(id) => chooseModel('live', id)} />
          </section>
          <section aria-labelledby="meeting-policy-after">
            <h3 id="meeting-policy-after" className="mb-2 text-h3 text-fg">After the meeting</h3>
            <p className="mb-3 max-w-prose text-small text-muted">Choose the model that prepares the summary and action items. Your existing automatic-summary setting still decides whether that happens automatically. This doesn’t send messages or complete tasks for you.</p>
            <p className="mb-3 max-w-prose text-small text-muted">Relevant live questions and saved findings can carry into the summary, with the final transcript as the reference.</p>
            <ModelChoice stage="after" editor={editor} disabled={disabled} onChange={(id) => chooseModel('after', id)} />
          </section>
        </fieldset>
        {saveError && <p className="mt-5 max-w-prose text-small text-warning" role="alert">{saveError}</p>}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={disabled || !meetingPolicyChanged(editor)} onClick={() => void save()}>{saving ? 'Saving…' : 'Save meeting preferences'}</Button>
          {savedNotice && <p className="text-small text-muted" role="status">Meeting preferences saved.</p>}
          {reviewCurrent && !needsRead && !reading && !readError && !meetingPolicyChanged(editor)
            && <p className="text-small text-muted">Your choices already match the saved settings.</p>}
        </div>
      </>}
    </div>}
  </details>;
}

function ModelChoice({ stage, editor, disabled, onChange }: {
  stage: MeetingPolicyStage; editor: MeetingPolicyEditor; disabled: boolean; onChange: (id: string) => void;
}) {
  const selectedId = stage === 'live' ? editor.draft.during.modelId : editor.draft.after.modelId;
  const inherited = editor.saved.defaults[stage];
  const selected = selectedMeetingPolicyModel(editor.saved, stage, selectedId);
  const id = `meeting-policy-${stage}-model`;
  return <div className="min-w-0">
    <label htmlFor={id} className="mb-1.5 block text-label text-fg">{stage === 'live' ? 'Live quick-check model' : 'Summary model'}</label>
    <Select id={id} value={selectedId ?? ''} disabled={disabled} onChange={(event) => onChange(event.target.value)}
      className="max-w-full min-w-0 text-small" aria-describedby={`${id}-selected ${id}-hint`}>
      <option value="">{stage === 'live' ? 'Use my quick-check model' : 'Use my main model'} — {inherited.label}</option>
      {meetingPolicyModelChoices(editor.saved, stage, selectedId).map((choice) => <option key={choice.id} value={choice.id} disabled={!choice.available}>
        {choice.label} · {choice.providerLabel}{choice.available ? '' : ' (unavailable)'}
      </option>)}
    </Select>
    <p id={`${id}-selected`} className="mt-2 max-w-prose break-words text-caption text-muted">Selected model: <span className="font-medium text-fg">{selected.label}</span></p>
    <p id={`${id}-hint`} className={`mt-2 max-w-prose break-words text-caption ${selected.available ? 'text-muted' : 'text-warning'}`}>
      {selected.available
        ? selectedId === null ? 'Follows your model settings when they change.' : 'Uses this connected model for this part of your meetings.'
        : selected.reason || 'This model is not currently available. Choose another connected model, or reconnect it in Settings.'}
      {!selected.available && <> <Link to="/settings#accounts" className="font-medium text-primary underline underline-offset-4">Model settings</Link></>}
    </p>
  </div>;
}
