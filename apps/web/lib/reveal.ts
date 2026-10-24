/**
 * Scrolls `scroller` (a list with its own scroll) just enough to show `el`. Unlike
 * Element.scrollIntoView this does not move the browser's sequential focus starting point, so the
 * first Tab on a page still reaches the skip link (WCAG 2.4.1, 2.4.3).
 */
export function revealIn(scroller: HTMLElement | null, el: HTMLElement | null, margin = 16) {
  if (!scroller || !el) return;
  const box = scroller.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.bottom > box.bottom) scroller.scrollTop += r.bottom - box.bottom + margin;
  else if (r.top < box.top) scroller.scrollTop -= box.top - r.top + margin;
}

/** Scrolls `scroller` sideways so `el` sits in its middle (a sections control on a phone), like revealIn. */
export function centreIn(scroller: HTMLElement | null, el: HTMLElement | null) {
  if (!scroller || !el || scroller.scrollWidth <= scroller.clientWidth) return;
  const box = scroller.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  scroller.scrollLeft += r.left + r.width / 2 - (box.left + box.width / 2);
}
