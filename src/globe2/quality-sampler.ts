/**
 * Decides when sustained slowness justifies dropping a rendering tier.
 *
 * Split out of scene.ts so it can be tested without a WebGL context, because
 * getting this wrong is not a subtle visual regression: the tier it picks
 * controls the pixel ratio and whether the bloom composer runs at all, so one
 * bad downgrade makes the globe look low-resolution and blown-out until the
 * page is reloaded.
 */
export interface QualitySampler {
  /**
   * Feeds one frame's real (unclamped) duration in milliseconds.
   * Returns true when the renderer should step down a tier.
   */
  sample(dtMs: number): boolean;
  /** Discards the in-flight window, e.g. after a backgrounded tab. */
  reset(): void;
}

/**
 * Longest frame that still counts as evidence about the GPU. A genuinely
 * struggling machine renders at 30-80ms; past this it is a stall rather than a
 * frame rate -- a backgrounded tab (browsers throttle requestAnimationFrame to
 * roughly 1fps, so every sample arrives near 1000ms), a garbage collection
 * pause, or a large dataset being uploaded.
 */
export const MAX_CREDIBLE_FRAME_MS = 250;

/** Sustained average above this (~36fps) is what a downgrade responds to. */
export const SLOW_FRAME_MS = 28;

/*
 * Judged over a window of wall time, not a frame count: at 10fps a 90-frame
 * window would take nine seconds to notice a problem. The minimum count still
 * stops a single hitch from triggering a downgrade on its own.
 */
const WINDOW_MS = 1500;
const MIN_SAMPLES = 10;

export function createQualitySampler(): QualitySampler {
  let total = 0;
  let count = 0;

  function reset(): void {
    total = 0;
    count = 0;
  }

  return {
    reset,
    sample(dtMs: number): boolean {
      if (dtMs > MAX_CREDIBLE_FRAME_MS) {
        // Discard the whole window, not just this sample: the frames on either
        // side of a stall are unrepresentative too.
        reset();
        return false;
      }

      total += dtMs;
      count++;
      if (total < WINDOW_MS || count < MIN_SAMPLES) return false;

      const average = total / count;
      reset();
      return average > SLOW_FRAME_MS;
    },
  };
}
