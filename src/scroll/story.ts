import type { Route } from "../data/types";
import { setStageIndex, subscribe } from "../state";

const INFRA_LABEL: Record<string, string> = {
  wireless: "Wireless (radio)",
  "fibre-terrestrial": "Fibre — terrestrial",
  "fibre-submarine": "Fibre — undersea cable",
  "satellite-uplink": "Satellite uplink",
  "satellite-link": "Inter-satellite link",
  "ground-link": "Satellite ground link",
};

export interface StoryPanel {
  el: HTMLElement;
}

/**
 * Which stage the panel is currently "on", from scroll geometry alone.
 *
 * Pure and exported so the geometry can be checked at both viewport shapes
 * without a layout engine — the desktop/mobile difference below is a real bug
 * this once shipped, not a hypothetical.
 *
 * The reading line sweeps from the top of the panel to the bottom as the user
 * scrolls, rather than sitting permanently at the centre. A fixed centre line
 * is only correct when the content is much taller than the panel: on a desktop
 * sidebar around 1000px tall, stage 1's centre sits near 100px while the centre
 * line starts at 500px, which lands on stage 2 — so the journey opened on stage
 * 2 with stage 1 greyed out, having never been active. Mobile escaped it purely
 * because a ~300px panel puts the centre line at 150px, still nearest stage 1.
 *
 * Anchoring the line to scroll progress makes both ends exact: at the top it is
 * the top of the panel, at the bottom it is the bottom, and it passes through
 * the centre in between. It stays monotonic in `scrollTop`, which is what the
 * scroll-position approach exists to guarantee.
 */
export function pickStageIndex(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  stageCentres: readonly number[],
): number {
  if (stageCentres.length === 0) return 0;
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  const progress = maxScroll > 0 ? Math.min(1, Math.max(0, scrollTop / maxScroll)) : 0;
  const target = scrollTop + clientHeight * progress;

  let bestIndex = 0;
  let bestDistance = Infinity;
  stageCentres.forEach((centre, index) => {
    const distance = Math.abs(centre - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

export function createStoryPanel(): StoryPanel {
  const el = document.createElement("div");
  el.className = "story";
  el.setAttribute("aria-label", "Journey of the request");

  const empty = document.createElement("div");
  empty.className = "story-empty";
  empty.innerHTML =
    "<p>Pick a starting point and a destination — tap the globe, or use the <strong>From</strong> / <strong>To</strong> menus — to see how a request actually gets there.</p>";
  el.append(empty);

  const list = document.createElement("div");
  list.className = "story-stages";
  el.append(list);

  let lastRoute: Route | null = null;

  function buildStages(route: Route): void {
    list.innerHTML = "";

    route.steps.forEach((step, index) => {
      const section = document.createElement("section");
      section.className = "stage";
      section.dataset.index = String(index);
      section.tabIndex = 0;

      const eyebrow = document.createElement("p");
      eyebrow.className = "stage-eyebrow";
      eyebrow.textContent = `Stage ${index + 1} of ${route.steps.length}${
        step.infra ? ` · ${INFRA_LABEL[step.infra]}` : ""
      }`;

      const title = document.createElement("h2");
      title.textContent = step.title;

      const explanation = document.createElement("p");
      explanation.className = "stage-explanation";
      explanation.textContent = step.explanation;

      const fact = document.createElement("p");
      fact.className = "stage-fact";
      fact.innerHTML = `<strong>Know this:</strong> ${step.fact}`;

      /*
       * The timing line. Estimates, so they are labelled as estimates
       * everywhere they appear — see data/latency.ts. The last stage carries
       * the total and the round trip, because the round trip is the number a
       * reader will recognise: it is what ping reports.
       */
      const timing = document.createElement("p");
      timing.className = "stage-timing";
      const last = index === route.steps.length - 1;
      if (index === 0) {
        timing.textContent = "The clock starts here.";
      } else if (last) {
        timing.innerHTML =
          `<strong>+${step.latencyMs} ms</strong> · about <strong>${step.elapsedMs} ms</strong> one way, ` +
          `so roughly <strong>${step.elapsedMs * 2} ms</strong> there and back — that round trip is what a ping measures.`;
      } else {
        timing.innerHTML = `<strong>+${step.latencyMs} ms</strong> · about ${step.elapsedMs} ms so far`;
      }

      section.append(eyebrow, title, explanation, fact, timing);
      section.addEventListener("click", () => {
        section.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      list.append(section);
    });

    // A rebuild (e.g. toggling Starlink) replaces the list in place without
    // otherwise touching scroll position, so a sidebar already scrolled partway
    // into the old route would open mid-way into the new one — stage 2 visible
    // before stage 1 has ever been seen. Every fresh route starts at the top.
    el.scrollTop = 0;
    updateActiveStage();
  }

  function atBottom(): boolean {
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 12;
  }

  /**
   * Measures the stages and reports which one is active (see `pickStageIndex`
   * for how the choice is made).
   *
   * This used to be an IntersectionObserver comparing intersection ratios
   * across whichever entries happened to cross a threshold in a given batch.
   * On a fast scroll (including the globe-forwarded wheel deltas, which can
   * arrive in large steps) several stages cross their thresholds within the
   * same callback, and the entry with the largest ratio is not necessarily
   * the one the scroll passed through first — so the reported stage could
   * jump backward (2, then 1, then 3) instead of advancing in order. Reading
   * geometry directly off `scrollTop` instead is a plain lookup: stages are
   * stacked top-to-bottom, so "nearest to the centre" only ever moves
   * monotonically as the user scrolls, regardless of how far a single event
   * jumps.
   */
  function updateActiveStage(): void {
    if (!lastRoute) return;
    // At the bottom several stages can be nearest-to-centre at once (the last
    // one's gap runs off the end of the scrollable area), so being at the end
    // is treated as unambiguous — it has to win, or the journey never
    // formally completes.
    if (atBottom()) {
      setStageIndex(lastRoute.steps.length);
      return;
    }
    const centres: number[] = [];
    for (const child of list.children) {
      const section = child as HTMLElement;
      centres.push(section.offsetTop + section.offsetHeight / 2);
    }
    const bestIndex = pickStageIndex(el.scrollTop, el.clientHeight, el.scrollHeight, centres);
    setStageIndex(bestIndex + 1);
  }

  el.addEventListener("scroll", updateActiveStage);
  // A resize (rotating a phone, DevTools docking) moves every section's
  // offset without firing a scroll event, so the active stage would otherwise
  // go stale until the next scroll.
  window.addEventListener("resize", updateActiveStage);

  subscribe((s) => {
    if (s.route !== lastRoute) {
      lastRoute = s.route;
      empty.hidden = Boolean(s.route);
      list.hidden = !s.route;
      if (s.route) buildStages(s.route);
    }

    if (!s.route) return;
    const active = list.children[Math.max(0, s.stageIndex - 1)] as HTMLElement | undefined;
    for (const child of list.children) child.classList.toggle("stage-active", child === active);
  });

  list.hidden = true;

  return { el };
}
