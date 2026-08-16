import { describe, expect, it } from "vitest";
import { pickStageIndex } from "../src/scroll/story";

/**
 * Stage centres for a route of `count` stages, as they lay out in a panel:
 * a stage box of `stageHeight`, separated by `gap`.
 */
function centres(count: number, stageHeight: number, gap: number): number[] {
  return Array.from({ length: count }, (_, i) => i * (stageHeight + gap) + stageHeight / 2);
}

// Roughly what the sidebar produces at 1920x1080: a ~1000px tall panel, stage
// boxes around 200px, and an 18vh gap between them.
const DESKTOP = { clientHeight: 1000, stages: centres(7, 200, 194) };
// And at 390x844: a much shorter panel with a 10vh gap.
const MOBILE = { clientHeight: 300, stages: centres(7, 200, 84) };

function scrollHeightFor(stages: number[], stageHeight = 200): number {
  return stages[stages.length - 1] + stageHeight / 2;
}

describe("story stage selection", () => {
  /*
   * The regression. A fixed centre reading line put the desktop panel's line at
   * 500px while stage 1's centre sat at 100px and stage 2's at 494px, so a
   * freshly built route opened on stage 2 with stage 1 greyed out and never
   * shown. Mobile happened to be fine, which is what made it look like a
   * desktop-only bug rather than a geometry one.
   */
  it("starts on the first stage at the top of the panel, on desktop", () => {
    expect(pickStageIndex(0, DESKTOP.clientHeight, scrollHeightFor(DESKTOP.stages), DESKTOP.stages)).toBe(0);
  });

  it("starts on the first stage on mobile too", () => {
    expect(pickStageIndex(0, MOBILE.clientHeight, scrollHeightFor(MOBILE.stages), MOBILE.stages)).toBe(0);
  });

  it("ends on the last stage at the bottom", () => {
    for (const { clientHeight, stages } of [DESKTOP, MOBILE]) {
      const scrollHeight = scrollHeightFor(stages);
      const bottom = scrollHeight - clientHeight;
      expect(pickStageIndex(bottom, clientHeight, scrollHeight, stages)).toBe(stages.length - 1);
    }
  });

  it("never steps backward as the user scrolls down", () => {
    for (const { clientHeight, stages } of [DESKTOP, MOBILE]) {
      const scrollHeight = scrollHeightFor(stages);
      const maxScroll = scrollHeight - clientHeight;
      let previous = -1;
      for (let scrollTop = 0; scrollTop <= maxScroll; scrollTop += 7) {
        const index = pickStageIndex(scrollTop, clientHeight, scrollHeight, stages);
        expect(index).toBeGreaterThanOrEqual(previous);
        previous = index;
      }
    }
  });

  it("reaches every stage on the way down", () => {
    for (const { clientHeight, stages } of [DESKTOP, MOBILE]) {
      const scrollHeight = scrollHeightFor(stages);
      const maxScroll = scrollHeight - clientHeight;
      const seen = new Set<number>();
      for (let scrollTop = 0; scrollTop <= maxScroll; scrollTop += 3) {
        seen.add(pickStageIndex(scrollTop, clientHeight, scrollHeight, stages));
      }
      expect(seen.size).toBe(stages.length);
    }
  });

  it("holds on the only stage when a route is too short to scroll", () => {
    // scrollHeight <= clientHeight, so there is no scroll range at all.
    expect(pickStageIndex(0, 1000, 900, [100])).toBe(0);
  });
});
