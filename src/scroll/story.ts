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

  let observer: IntersectionObserver | null = null;
  let lastRoute: Route | null = null;

  function buildStages(route: Route): void {
    list.innerHTML = "";
    observer?.disconnect();

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

    observer = new IntersectionObserver(
      (entries) => {
        // At the bottom several stages are fully visible at once, so whichever
        // wins on ratio is arbitrary. Being at the end is unambiguous, and it
        // has to win, or the journey never formally completes.
        if (atBottom()) {
          setStageIndex(route.steps.length);
          return;
        }
        let best: { index: number; ratio: number } | null = null;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = Number((entry.target as HTMLElement).dataset.index);
          if (!best || entry.intersectionRatio > best.ratio) best = { index, ratio: entry.intersectionRatio };
        }
        if (best) setStageIndex(best.index + 1);
      },
      { root: el, threshold: [0.25, 0.5, 0.75], rootMargin: "-10% 0px -10% 0px" },
    );
    for (const section of list.children) observer.observe(section);
  }

  function atBottom(): boolean {
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 12;
  }

  // The observer only fires when an intersection actually changes, which a
  // final few pixels of scrolling may not do -- so watch the scroll too.
  el.addEventListener("scroll", () => {
    if (lastRoute && atBottom()) setStageIndex(lastRoute.steps.length);
  });

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
