// Hover text under a small icon (scan shield, review badge, kind icon) is placed by CSS next to the icon.
// Near a panel's edge it would be cut off, so before it shows it's shifted sideways to fit inside the
// nearest box that clips (the side panel), keeping a small margin.

const MARGIN = 8;

function clippingBox(element: HTMLElement): DOMRect {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX !== "visible" || style.overflow !== "visible") return node.getBoundingClientRect();
  }
  return new DOMRect(0, 0, document.documentElement.clientWidth, window.innerHeight);
}

/** How far to move a box sideways so it fits between `left` and `right` (the left edge wins if it can't). */
export function tipShift(tip: { left: number; right: number }, bounds: { left: number; right: number }, margin = MARGIN): number {
  const right = bounds.right - margin, left = bounds.left + margin;
  let shift = tip.right > right ? right - tip.right : 0;
  if (tip.left + shift < left) shift = left - tip.left;
  return Math.round(shift);
}

/** Moves the button's hover text to fit inside the panel; call as it's about to show. */
export function fitTip(button: HTMLElement) {
  const tip = button.querySelector<HTMLElement>(".ua-scan-tip-text, .ua-kind-tip-text");
  if (!tip) return;
  tip.style.removeProperty("translate");
  const box = clippingBox(button);
  const viewport = { left: 0, right: document.documentElement.clientWidth };
  const shift = tipShift(tip.getBoundingClientRect(),
    { left: Math.max(box.left, viewport.left), right: Math.min(box.right, viewport.right) });
  if (shift) tip.style.translate = `${shift}px 0`;
}
