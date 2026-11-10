export const rating = (score: number | null) => score === null ? 'Unrated' : `★ ${score.toFixed(1)}`;
export function timeAgo(value: string, now = new Date()) {
  const days = Math.max(0, Math.floor((now.getTime() - Date.parse(value)) / 86_400_000));
  if (!Number.isFinite(days)) return '';
  return days === 0 ? 'Today' : days === 1 ? '1 day ago' : `${days} days ago`;
}
