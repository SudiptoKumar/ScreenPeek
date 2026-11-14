export const rating = (score: number | null) => score === null || score <= 0 ? 'Unrated' : `★ ${score.toFixed(1)}`;
export const runtimeLabel = (min: number | null | undefined) => { if (!min || min <= 0) return null; const h = Math.floor(min / 60), m = min % 60; return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`; };
export function timeAgo(value: string, now = new Date()) {
  const days = Math.max(0, Math.floor((now.getTime() - Date.parse(value)) / 86_400_000));
  if (!Number.isFinite(days)) return '';
  return days === 0 ? 'Today' : days === 1 ? '1 day ago' : `${days} days ago`;
}
