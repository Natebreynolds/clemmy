/** One drawn glyph per memory job, so a timeline row and a job card that
 *  talk about the same job look alike. */
import type { LucideIcon } from 'lucide-react';
import {
  Download, Fingerprint, GraduationCap, Leaf, MessageSquareText, Scale, ScrollText, Search, ShieldCheck, Waypoints,
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
