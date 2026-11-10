export {};
interface VoteReply { counts?: Record<string, number>; duplicate?: boolean; error?: string; }
const parseReply = async (response: Response): Promise<VoteReply> => {
  const data: unknown = await response.json();
  return data && typeof data === 'object' && !Array.isArray(data) ? data as VoteReply : {};
};
const widget = document.querySelector<HTMLElement>('[data-verdict-widget]');
if (widget) {
  const id = Number(widget.dataset.titleId), type = widget.dataset.titleType;
  const key = `screenpeek:vote:${type}:${id}`;
  const buttons = widget.querySelectorAll<HTMLButtonElement>('button[data-choice]');
  const status = widget.querySelector<HTMLElement>('[data-vote-status]')!;
  const choices = ['must', 'good', 'average', 'skip'];
  const show = (counts: Record<string, number>) => {
    if (!choices.every(choice => Number.isSafeInteger(counts[choice]) && counts[choice] >= 0)) return;
    const total = choices.reduce((sum, choice) => sum + counts[choice], 0);
    widget.querySelector('[data-verdict-total]')!.textContent = `≈ ${total.toLocaleString()} votes`;
    buttons.forEach(button => {
      const choice = button.dataset.choice!, count = counts[choice], percent = total ? Math.round(count / total * 100) : 0;
      button.querySelector('strong')!.textContent = `${percent}%`;
      button.closest('.verdict-option')!.querySelector('small')!.textContent = `≈ ${count.toLocaleString()} votes`;
      (button.closest('.verdict-option')!.querySelector('.verdict-track span') as HTMLElement).style.width = `${percent}%`;
    });
  };
  try {
    const previous = localStorage.getItem(key);
    if (previous) status.textContent = 'You have voted on this browser. Community totals are approximate and may take a minute to update.';
    else {
      localStorage.setItem('screenpeek:vote-check', '1'); localStorage.removeItem('screenpeek:vote-check');
      buttons.forEach(button => { button.disabled = false; });
      status.textContent = 'One vote per title on this browser. Community totals are approximate.';
    }
    if (previous) void fetch(`/api/vote/?id=${id}&type=${type}`).then(response => response.ok ? parseReply(response) : null).then(data => { if (data?.counts) show(data.counts); }).catch(() => {});
    buttons.forEach(button => button.addEventListener('click', async () => {
      buttons.forEach(value => { value.disabled = true; }); status.textContent = 'Sending your vote…';
      try {
        if (localStorage.getItem(key)) return;
        const choice = button.dataset.choice!;
        const response = await fetch('/api/vote/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, type, choice }) });
        const result = await parseReply(response);
        if (response.ok || (response.status === 409 && result.duplicate)) {
          localStorage.setItem(key, response.ok ? choice : 'received');
          if (result.counts) show(result.counts);
          status.textContent = response.ok ? 'Vote received. Totals are approximate and may take a minute to update.' : 'A vote for this title was already received today. Try another title.';
        } else throw new Error(result.error || 'Voting is temporarily unavailable.');
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Voting is temporarily unavailable.';
        buttons.forEach(value => { value.disabled = false; });
      }
    }));
  } catch { status.textContent = 'Enable browser storage to vote. Community totals are approximate.'; }
}
