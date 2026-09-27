/** One drawn glyph per memory job, so a timeline row and a job card that
 *  talk about the same job look alike. */
import type { LucideIcon } from 'lucide-react';
import {
  Brain, Download, Fingerprint, GraduationCap, Leaf, MessageSquareText, Scale, ScrollText, Search, ShieldCheck, Waypoints,
} from 'lucide-react';
import type { MemoryJobId } from '@/lib/memory-work';

export const JOB_ICON: Record<MemoryJobId, LucideIcon> = {
  learn: MessageSquareText,
  reconcile: Scale,
  patterns: Waypoints,
  skills: GraduationCap,
  identity: Fingerprint,
  import: Download,
  standing: ScrollText,
  verify: ShieldCheck,
  index: Search,
  tidy: Leaf,
};

/** The glyph for a job id as the daemon sent it. The console is swapped apart
 *  from the daemon, so a newer daemon can name a job this build has never
 *  heard of; that row gets a plain memory glyph instead of taking the whole
 *  Memory screen down. */
export function jobIcon(job: string): LucideIcon {
  return Object.prototype.hasOwnProperty.call(JOB_ICON, job) ? JOB_ICON[job as MemoryJobId] : Brain;
}
