// Floating ad formats (social bar, in-page push) are injected by the ad
// networks as fixed bars across the top of the viewport. They overlay the
// site header and the top of the content instead of pushing the page down.
// This watcher measures any stack of such bars and pads the body by the
// same height, so the page slides below the ads; when a bar is closed the
// padding is removed again. It never touches in-flow ad slots.

const MAX_BAR_HEIGHT = 300;
const MAX_OFFSET = 400;
let current = -1;
let scheduled = false;

interface BarRect { top: number; bottom: number }

function collectBars(): BarRect[] {
  const bars: BarRect[] = [];
  const width = window.innerWidth;
  const visit = (node: Element, depth: number) => {
    // Our own page regions never contain a network bar; skipping them also
    // keeps the scan out of the large catalogue subtrees.
    if (node.matches('header, main, footer, .ad-sticky')) return;
    const style = getComputedStyle(node);
    if (style.position === 'fixed' && style.display !== 'none' && style.visibility !== 'hidden') {
      const rect = node.getBoundingClientRect();
      if (rect.height >= 30 && rect.height <= MAX_BAR_HEIGHT && rect.width >= width * 0.6 && rect.top >= -8) {
        bars.push({ top: rect.top, bottom: rect.bottom });
      }
    }
    if (depth < 3) for (const child of Array.from(node.children)) visit(child, depth + 1);
  };
  for (const child of Array.from(document.body.children)) visit(child, 0);
  return bars;
}

function measure(): number {
  // Only a chain of bars starting at the very top counts: a second bar
  // docked directly under the first extends the covered depth, while an
  // unrelated fixed element further down the viewport is ignored.
  let depth = 0;
  const bars = collectBars().sort((a, b) => a.top - b.top);
  for (const bar of bars) {
    if (bar.top <= depth + 12 && bar.bottom > depth) depth = bar.bottom;
  }
  return Math.min(MAX_OFFSET, Math.round(depth));
}

function apply() {
  scheduled = false;
  const next = measure();
  if (current >= 0 && Math.abs(next - current) <= 2) return;
  current = next;
  document.body.style.paddingTop = next > 0 ? `${next}px` : '';
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => setTimeout(apply, 30));
}

new MutationObserver(schedule).observe(document.body, {
  childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'],
});
window.addEventListener('resize', schedule);
window.setInterval(apply, 1500);
schedule();
