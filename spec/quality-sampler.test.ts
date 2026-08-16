import { describe, expect, it } from "vitest";
import { createQualitySampler, MAX_CREDIBLE_FRAME_MS } from "../src/globe2/quality-sampler";

/** Feeds `count` frames of `dtMs` and reports whether any asked for a downgrade. */
function feed(sampler: ReturnType<typeof createQualitySampler>, dtMs: number, count: number): boolean {
  let downgraded = false;
  for (let i = 0; i < count; i++) {
    if (sampler.sample(dtMs)) downgraded = true;
  }
  return downgraded;
}

describe("quality sampler", () => {
  it("leaves a comfortable machine alone", () => {
    // 60fps for ten seconds.
    expect(feed(createQualitySampler(), 16.7, 600)).toBe(false);
  });

  it("steps down when the machine is genuinely slow", () => {
    // ~20fps sustained, which is what the tiers exist to rescue.
    expect(feed(createQualitySampler(), 50, 200)).toBe(true);
  });

  /*
   * The regression this whole module exists for. A backgrounded tab has its
   * frame loop throttled to roughly 1fps, so every sample arrives near 1000ms.
   * Counting those as frame-rate evidence downgraded the renderer while nobody
   * was even looking, and the globe came back at half the pixel ratio with the
   * bloom composer bypassed -- visibly low-resolution and high-contrast, fixable
   * only by reloading.
   */
  it("ignores a backgrounded tab's throttled frames", () => {
    expect(feed(createQualitySampler(), 1000, 600)).toBe(false);
  });

  it("ignores a single long stall between healthy frames", () => {
    const sampler = createQualitySampler();
    feed(sampler, 16.7, 30);
    expect(sampler.sample(4000)).toBe(false); // e.g. a dataset landing
    expect(feed(sampler, 16.7, 600)).toBe(false);
  });

  it("still trusts frames just under the stall threshold", () => {
    // Guards the boundary from being loosened until real slowness is ignored.
    expect(feed(createQualitySampler(), MAX_CREDIBLE_FRAME_MS - 1, 200)).toBe(true);
  });

  it("discards the window it was building when reset", () => {
    const sampler = createQualitySampler();
    feed(sampler, 50, 9); // just short of the minimum sample count
    sampler.reset();
    expect(feed(sampler, 50, 9)).toBe(false);
  });
});
