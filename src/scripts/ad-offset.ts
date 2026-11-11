// Floating ad formats (social bar, in-page push, vignette cards) are
// injected by the ad networks as fixed overlays across the top of the
// viewport. They cover the site header and the top of the content instead
// of pushing the page down.
//
// Version 1 measured fixed elements by geometry alone. That failed both
// ways on real ads: bars wrapped inside full-height overlay containers
// were missed, and empty leftover containers (after a bar is closed, or
// before it fills) were measured as if an ad were showing, leaving a
// blank gap. This version instead probes what is actually covering the
// top of the screen with elementFromPoint, and only counts a cover that
// really contains an ad (an image, a frame, a video, a shadow root, or a
// painted background). When a real stack of bars covers the top, the
// page is padded down below it; a full-screen overlay (the vignette) is
// never padded for. While bars are showing, the site header also stops
// being sticky — the owner wants the heading to scroll up and away with
// the page instead of hanging stuck below the ads; it returns to sticky
// when the bars are gone.

const PROBE_BOTTOM = 320; // bars never legitimately exceed this depth
const STEP = 10;
const START_TOLERANCE = 24; // the stack must begin this close to the top
const GAP_TOLERANCE = 40; // seams allowed between stacked bars
let current = -1;
let scheduled = false;

function isOurs(element: Element | null): boolean {
  if (!element) return true;
  if (element === document.body || element === document.documentElement) return true;
  return Boolean(element.closest('header, main, footer, .ad-sticky'));
}

/** The highest element below <body> that contains the probed element. */
function overlayRoot(element: Element): Element {
  let node: Element = element;
  while (node.parentElement && node.parentElement !== document.body) node = node.parentElement;
  return node;
}

/** True when the overlay really renders an ad, not an empty shell. */
function showsAd(root: Element): boolean {
  if ((root as HTMLElement).shadowRoot) return true;
  for (const media of Array.from(root.querySelectorAll('iframe, img, video, canvas'))) {
    const rect = media.getBoundingClientRect();
    if (rect.width > 4 && rect.height > 4) return true;
  }
  const painted = (element: Element) => {
    const bg = getComputedStyle(element).backgroundColor;
    if (!bg || bg === 'transparent') return false;
    return !(bg.startsWith('rgba(') && /,\s*0\)$/.test(bg));
  };
  if (painted(root)) return true;
  for (const child of Array.from(root.querySelectorAll('*')).slice(0, 40)) {
    if (painted(child)) return true;
  }
  return false;
}

function coveredAt(y: number): boolean {
  const xs = [0.3, 0.7].map(fraction => Math.round(window.innerWidth * fraction));
  for (const x of xs) {
    const hit = document.elementFromPoint(x, y);
    if (!hit || isOurs(hit)) continue;
    if (showsAd(overlayRoot(hit))) return true;
  }
  return false;
}

function coveredDepth(): number {
  let lastCovered = -1;
  for (let y = 6; y <= PROBE_BOTTOM; y += STEP) {
    if (coveredAt(y)) {
      if (lastCovered < 0 && y > START_TOLERANCE) return 0; // not a top stack
      lastCovered = y;
    } else if (lastCovered >= 0 && y - lastCovered > GAP_TOLERANCE) {
      break;
    }
  }
  if (lastCovered < 0) return 0;
  if (lastCovered >= PROBE_BOTTOM - STEP) return 0; // full-screen overlay
  // Refine the coarse step boundary to the exact bottom edge of the stack.
  let low = lastCovered;
  let high = lastCovered + STEP;
  while (high - low > 2) {
    const mid = Math.round((low + high) / 2);
    if (coveredAt(mid)) low = mid; else high = mid;
  }
  return low + 1;
}

function apply() {
  scheduled = false;
  const next = coveredDepth();
  if (current >= 0 && Math.abs(next - current) <= 2) return;
  current = next;
  document.body.style.paddingTop = next > 0 ? `${next}px` : '';
  const header = document.querySelector<HTMLElement>('.site-header');
  if (header) {
    // While ads cover the top, unstick the header so it scrolls up and
    // away with the page; restore the original sticky header afterwards.
    header.style.position = next > 0 ? 'static' : '';
    header.style.top = '';
  }
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
