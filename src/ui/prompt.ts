/**
 * The prompt box that tells the user what the globe wants from them next.
 *
 * The flow is a sequence -- choose an origin, choose a destination, then read
 * the journey -- and nothing else on screen says which step you are on. This
 * is that signpost, so the interaction never depends on the user guessing.
 */

export interface Prompt {
  el: HTMLElement;
  show(title: string, detail?: string): void;
  hide(): void;
}

export function createPrompt(): Prompt {
  const el = document.createElement("div");
  el.className = "prompt";
  el.hidden = true;
  // Announced politely: it changes in response to the user's own actions, so
  // it should not interrupt whatever a screen reader is already saying.
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");

  const title = document.createElement("p");
  title.className = "prompt-title";

  const detail = document.createElement("p");
  detail.className = "prompt-detail";

  el.append(title, detail);

  function show(nextTitle: string, nextDetail = ""): void {
    title.textContent = nextTitle;
    detail.textContent = nextDetail;
    detail.hidden = nextDetail.length === 0;
    el.hidden = false;
  }

  function hide(): void {
    el.hidden = true;
  }

  return { el, show, hide };
}
