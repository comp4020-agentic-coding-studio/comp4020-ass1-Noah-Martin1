# Process overview

A reading-guide to how the work came together.

## What I built

An interactive 3D globe that visualises what actually happens when your device
makes an internet request: pick a source and destination city, watch the
request travel hop-by-hop across real infrastructure types (device, 5G tower,
fibre backbone, undersea cable, internet exchange, server), and toggle Starlink
on to see the same trip take a different first hop — device to satellite to
ground station — before rejoining the ordinary terrestrial backbone for the
rest of the journey. A scroll-driven story panel narrates each stage with a
short explanation and a "know this" fact, and infrastructure-layer pills let
you highlight fibre cables, towers, ground stations, and servers on the globe
independently of whichever route is selected.

## The moments that mattered

1. **Prototyping the globe before committing to an architecture.** I didn't
   start from a route-model design — I started by getting a globe on screen
   and made it feel right to touch first: a wireframe globe with a dotted point
   cloud
   ([`90ed6c6`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Noah-Martin1/commit/90ed6c63a0982c5a5c875a269d840b8f1d35ae5f)),
   then drag-to-spin interaction
   ([`d9ebcd8`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Noah-Martin1/commit/d9ebcd899a72dd4b78c1950a3d6eaaf7cdd093de)),
   then a polish pass that cut the globe's own code by a third while keeping the
   same interaction
   ([`2adbff0`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Noah-Martin1/commit/2adbff0f4e3a811e20431231563804c77dd59858)).
   Only once the interaction felt right did I extract real land outlines and
   wire it into the site's navigation
   ([`a842bea`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Noah-Martin1/commit/a842bea27a08b1252a125a558d00f1f673776bea)).
   Building the feel first meant the later data/route work slotted onto
   something already known to be enjoyable to use, instead of discovering late
   that the interaction needed reworking around a rigid data model.

2. **Rewriting flat prototype files into a modular, testable `src/` tree.** By
   the end of the prototyping arc above, `globe.ts` was a single 650+ line file
   mixing rendering, camera control, and interaction. Rather than keep
   layering the route model, Starlink satellites, infrastructure rendering, and
   scroll-driven storytelling onto that one file, I split it into
   `src/globe/{scene,controls,geometry,picking,satellites,infrastructure}.ts`,
   `src/data/`, `src/scroll/story.ts`, and `src/state.ts`, and added
   `spec/assignment-1.test.ts` to unit-test the route-building logic
   independent of the renderer
   ([`6b61e09`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Noah-Martin1/commit/6b61e09)).
   I knew the split was worth it because the route-builder tests could then run
   in milliseconds under `vitest` with no browser or WebGL context needed at
   all — something impossible against the original single-file version.

3. **Choosing what Starlink actually replaces.** The obvious, simpler
   implementation would have made "Starlink on" swap the *entire* route for an
   all-satellite path. I decided against that: real Starlink only replaces the
   last mile (device → satellite → ground station); everything past the ground
   station still crosses the same fibre backbone, internet exchanges, and
   undersea cables a non-Starlink request would use
   ([`6b61e09`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Noah-Martin1/commit/6b61e09),
   `src/data/geo.ts`'s route builders). I checked this was actually happening,
   not just intended, by driving the running app with Playwright: toggling
   Starlink on a Nairobi → Hong Kong route produced stages 1–3 as
   device/uplink/inter-satellite-link, then stage 6 onward as ordinary
   undersea-cable and network-hub stages identical in kind to the non-Starlink
   path — confirming the model falls back correctly rather than guessing from a
   screenshot.

4. **Rebuilding against reference images, and letting the sky decide the
   architecture.** I was given two reference images — satellitemap.space's
   constellation view and a traceroute globe — and asked to match them. The
   obvious reading was "restyle the globe". The thing that actually mattered
   was subtler: the reference wants the stars to sweep when you drag. My
   implementation rotated the *globe* under a fixed camera, which leaves the
   sky nailed in place; it had a fudge factor multiplying star rotation to fake
   parallax. Matching the reference properly meant inverting it — fix the Earth
   in world space and orbit the *camera*
   ([`b882de0`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Noah-Martin1/commit/b882de0)).
   Once that was right the sun, moon and Milky Way needed no special handling
   at all: being in world space, they sweep for free. The faked parallax
   constant disappeared rather than being retuned, which is how I knew the new
   model was the correct one rather than just a different one.

5. **Measuring which thing was actually slow.** With all 10,753 satellites
   drawing, the page ran at 7fps and the obvious culprit was the satellites. I
   measured instead of optimising: satellites off gave 8fps, satellites on gave
   9fps, and shrinking the window to 640×400 gave 50fps. Frame rate tracked
   *pixel count*, not object count — so the constellation was nearly free and
   the bloom post-processing pass was the whole cost. That inverted the fix:
   instead of decimating the satellites (which would have destroyed the exact
   density the reference is about), I left all of them and made rendering
   quality adaptive, with the scene timing itself and stepping down on machines
   that can't afford bloom
   ([`b882de0`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Noah-Martin1/commit/b882de0)).
   That took a software-rasterised 1080p frame from 8fps to 26fps with the full
   catalogue still on screen. I'd also found the same lesson earlier in the
   layout: a screenshot that "looked fine" at 1920×1080 was hiding a globe box
   measuring 640×780 — not square, using under half its column — which only
   surfaced once I read `clientWidth`/`clientHeight` instead of trusting my
   eyes
   ([`6b61e09`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Noah-Martin1/commit/6b61e09)).

## Before you ship

`pnpm check:evidence` verifies your citations resolve to real commits, that the
current reflection entry is in `reflections/`, and that your `CLAUDE.md` is
there — before a marker ever opens the file. It checks that your map is
traceable, not that it is good: the marker judges whether your small,
deliberately chosen set of moments shows real judgement and reflection. A green
check is not a substitute for that curation.

Images are deliberately not checked, because whether one renders is visible the
moment you look. Open this file on GitHub and look at it before you ship.
