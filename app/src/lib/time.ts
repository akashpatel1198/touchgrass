// Relative time formatter for session timestamps. Just-now / Nm / Nh / Nd —
// nothing more granular than that, since sessions live on the order of
// minutes-to-hours and the phone glances at them, doesn't dwell.

export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const ms = Math.max(0, now - then);
  if (ms < 30_000) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  if (ms < 7 * 86_400_000) return `${Math.floor(ms / 86_400_000)}d ago`;
  return new Date(then).toLocaleDateString();
}
