"use client";

import { useId, useState } from "react";
import { ArrowRight, Check, FileText, Mic } from "lucide-react";
import styles from "./JourneyDemos.module.css";

interface DemoTabsProps {
  id: string;
  label: string;
  options: readonly string[];
  value: number;
  onChange: (value: number) => void;
}

function DemoTabs({ id, label, options, value, onChange }: DemoTabsProps) {
  return (
    <div className={styles.tabs} role="tablist" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={option}
          id={`${id}-tab-${index}`}
          type="button"
          role="tab"
          aria-selected={value === index}
          aria-controls={`${id}-panel`}
          tabIndex={value === index ? 0 : -1}
          onClick={() => onChange(index)}
          onKeyDown={(event) => {
            let next: number;
            if (event.key === "ArrowRight") next = (index + 1) % options.length;
            else if (event.key === "ArrowLeft") next = (index - 1 + options.length) % options.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = options.length - 1;
            else return;
            event.preventDefault();
            onChange(next);
            const target = event.currentTarget.parentElement?.children[next];
            if (target instanceof HTMLButtonElement) target.focus();
          }}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

const waveform = [10, 19, 14, 29, 23, 37, 28, 16, 12, 22, 32, 39, 27, 17, 25, 34, 21, 12, 18, 30, 39, 28, 15, 22, 33, 25, 17, 11, 20, 29, 36, 23, 13, 19, 26, 14];
const recordingViews = ["Transcript", "Summary", "Actions"] as const;

export function RecordingDemo() {
  const id = useId();
  const [view, setView] = useState(0);

  return (
    <div className={styles.demo} data-recording-view={recordingViews[view].toLowerCase()}>
      <div className={styles.heading}>
        <h3><Mic size={18} aria-hidden="true" /> Launch sync</h3>
        <div className={styles.recordingTime}>
          <div className={styles.waveform} aria-hidden="true">
            {waveform.slice(0, 16).map((height, index) => <span key={index} style={{ height: height * 0.6 }} />)}
          </div>
          <span className={styles.duration}>12:00</span>
        </div>
      </div>
      <DemoTabs id={id} label="Explore the recording example" options={recordingViews} value={view} onChange={setView} />
      <div className={styles.recordingPanel} id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${view}`} tabIndex={0}>
        {view === 0 && (
          <div className={styles.transcript}>
            <p><span>08:42 · Maya</span>“Let’s move the launch to Thursday. I’ll update the brief.”</p>
            <p><span>09:06 · Eli</span>“I’ll check the source links before Wednesday’s review.”</p>
          </div>
        )}
        {view === 1 && (
          <div className={styles.summary}>
            <p>The team moved the launch to Thursday, with a source review on Wednesday.</p>
            <p><strong>Decision</strong> Update the launch brief before the review.</p>
          </div>
        )}
        {view === 2 && (
          <ul className={styles.actionList}>
            <li><span>Update the launch brief</span><span>Maya · before review</span></li>
            <li><span>Check the source links</span><span>Eli · Wednesday</span></li>
          </ul>
        )}
      </div>
      <p className={styles.caption}>Illustrative transcript and analysis. Action items are not automatically executed.</p>
    </div>
  );
}

const launchItems = [
  { id: "sources", title: "Review the source links", owner: "Eli", due: "Wednesday", done: false, source: "Launch sync · 09:06", quote: "I’ll check the source links before Wednesday’s review." },
  { id: "brief", title: "Update the launch brief", owner: "Maya", due: "Before review", done: false, source: "Launch sync · 08:42", quote: "Let’s move the launch to Thursday. I’ll update the brief." },
  { id: "date", title: "Agree on the launch date", owner: "Team", due: "Thursday", done: true, source: "Launch sync · 08:42", quote: "Let’s move the launch to Thursday." },
];

const workflowTriggers = [
  { label: "On demand", start: "Your request", outcome: "Run when you ask", description: "Use the saved steps when you need a fresh launch brief." },
  { label: "On a schedule", start: "Scheduled check-in", outcome: "Reuse on a schedule", description: "A configured schedule starts the same saved work." },
  { label: "On an event", start: "Connected event", outcome: "Start from a connected event", description: "A configured trigger starts the work when a relevant event arrives." },
] as const;

export function SpaceDemo() {
  const id = useId();
  const [view, setView] = useState(0);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [preview, setPreview] = useState<string | null>(null);
  const [trigger, setTrigger] = useState(0);
  const visibleItems = launchItems.filter((item) => filter === "all" || !item.done);
  const selectedItem = launchItems.find((item) => item.id === preview);
  const workflow = workflowTriggers[trigger];

  return (
    <div className={styles.demo} data-space-view={view === 0 ? "space" : "workflow"} data-space-filter={filter}>
      <div className={styles.heading}>
        <h3><FileText size={18} aria-hidden="true" /> Launch room</h3>
        <span className={styles.exampleLabel}>Example data</span>
      </div>
      <DemoTabs id={id} label="Explore Spaces and workflows" options={["Space", "Workflow"]} value={view} onChange={setView} />
      <div id={`${id}-panel`} className={styles.spacePanel} role="tabpanel" aria-labelledby={`${id}-tab-${view}`} tabIndex={0}>
        {view === 0 ? (
          <>
            <div className={styles.boardToolbar}>
              <span>{visibleItems.length} items</span>
              <div className={styles.filter} role="group" aria-label="Filter the example launch board">
                {(["open", "all"] as const).map((option) => (
                  <button key={option} type="button" aria-pressed={filter === option} onClick={() => { setFilter(option); setPreview(null); }}>
                    {option === "open" ? "Open" : "All"}
                  </button>
                ))}
              </div>
            </div>
            <ul className={styles.board}>
              {visibleItems.filter((item) => !selectedItem || item.id === selectedItem.id).map((item) => (
                <li key={item.id}>
                  <span className={styles.itemText}><span>{item.done && <Check size={15} aria-hidden="true" />}{item.title}</span><span>{item.owner} · {item.done ? "Done" : item.due}</span></span>
                  <button type="button" className={styles.previewButton} aria-label={preview === item.id ? "Close source preview" : `Preview ${item.title.toLowerCase()}`} aria-expanded={preview === item.id} aria-controls={`${id}-source`} onClick={() => setPreview(preview === item.id ? null : item.id)}>{preview === item.id ? "Close" : "Preview"}</button>
                </li>
              ))}
            </ul>
            <div id={`${id}-source`} className={styles.source} hidden={!selectedItem}>
              {selectedItem && <><strong>{selectedItem.source}</strong><p>“{selectedItem.quote}”</p></>}
            </div>
          </>
        ) : (
          <div className={styles.workflow} data-workflow-trigger={trigger}>
            <div className={styles.triggers} role="group" aria-label="Example workflow trigger">
              {workflowTriggers.map((option, index) => <button key={option.label} type="button" aria-pressed={trigger === index} onClick={() => setTrigger(index)}>{option.label}</button>)}
            </div>
            <p className={styles.trace}><span>{workflow.start}</span><ArrowRight size={15} aria-hidden="true" /><span>Gather sources</span><ArrowRight size={15} aria-hidden="true" /><span>Review brief</span></p>
            <h4>{workflow.outcome}</h4>
            <p>{workflow.description}</p>
            <p className={styles.workflowNote}>Work can pause when it needs your answer or approval.</p>
          </div>
        )}
      </div>
      <p className={styles.caption}>Illustrative workspace. These controls only change the example.</p>
    </div>
  );
}
