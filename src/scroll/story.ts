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

      section.append(eyebrow, title, explanation, fact);
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
   * Picks the stage nearest the vertical centre of the panel and reports it.
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
    const target = el.scrollTop + el.clientHeight / 2;
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (const child of list.children) {
      const section = child as HTMLElement;
      const center = section.offsetTop + section.offsetHeight / 2;
      const distance = Math.abs(center - target);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = Number(section.dataset.index);
      }
    }
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
