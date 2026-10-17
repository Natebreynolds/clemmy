/** Read-only projection from retained heartbeat evidence. A recorded check
 * does not certify provider success or complete source coverage. */
export interface HeartbeatPresentation {
  state: 'off'|'quiet_hours'|'checking'|'scheduled'|'due'|'never'|'failed'|'partial'|'unknown';
  nextCheckAt?: string;
  lastCheck: { state:'never'|'recorded'|'partial'|'failed'|'unknown'; at?:string; readFailures?:number; successfulReads?:number };
}
export function heartbeatStateWords(p: HeartbeatPresentation | undefined): string {
  switch(p?.state) {
    case 'off': return 'Off';
    case 'quiet_hours': return 'Paused for quiet hours';
    case 'checking': return 'Checking now';
    case 'scheduled': return 'Scheduled';
    case 'due': return 'Due for a check';
    case 'never': return 'No check recorded yet';
    case 'failed': return 'Last check failed';
    case 'partial': return 'Some sources could not be checked';
    default: return 'Check status unavailable';
  }
}
export function heartbeatLastCheckWords(p: HeartbeatPresentation | undefined): string {
  switch(p?.lastCheck.state) {
    case 'recorded': return 'Last check recorded';
    case 'partial': return 'Last check incomplete';
    case 'failed': return 'Last check failed';
    case 'never': return 'No check recorded yet';
    default: return 'Last check unconfirmed';
  }
}
export function liveWorkSummary(memberships: readonly string[], unavailable = false): {label:string; attention:boolean} {
  if(unavailable) return {label:'Work status unavailable',attention:true};
  const needs = memberships.filter(m=>m==='needs_you').length;
  const stalled = memberships.filter(m=>m==='stalled').length;
  if(needs) return {label: `${needs} ${needs===1?'item needs':'items need'} you`,attention:true};
  if(stalled) return {label: `${stalled} ${stalled===1?'item needs':'items need'} attention`,attention:true};
  return {label:'Nothing running',attention:false};
}
