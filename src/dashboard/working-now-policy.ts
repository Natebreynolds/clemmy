/**
 * The one number two surfaces share.
 *
 * A run that has stopped and is waiting on a person is "working now" for a
 * while: the owner may be about to answer. Past this window it is not work in
 * flight, it is an ask. Working Now lets it go (the header chip, Activity's
 * "Happening now" and Home stop counting it) and the work-review heartbeat
 * raises it once, grouped per workflow, in Needs you. Live 09-26: the phone's
 * chip read "32 stalled" over runs parked between 3 and 32 days earlier.
 */
export const STALLED_WORK_REAP_MS = 2 * 60 * 60 * 1000;
