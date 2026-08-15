const query = window.matchMedia("(prefers-reduced-motion: reduce)");

export const reducedMotion = {
  get value(): boolean {
    return query.matches;
  },
};
