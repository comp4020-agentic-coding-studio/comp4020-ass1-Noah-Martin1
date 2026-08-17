
# Process overview

## What I built

An interactive 3D globe that visualises what happens when a device makes an internet request. Users select an origin and destination, then scroll through a visual traceroute across infrastructure such as 5G towers, fibre, undersea cables, servers and, optionally, Starlink satellites. The globe remains the central visual while each stage provides an explanation of what is happening.

## The moments that mattered

### 1. Globe Creation

My first major decision was establishing the visual character of the globe. I initially experimented with Claude's ability to interpret aesthetic descriptions, specifying the colour palette, continent shading, overall style in `CLAUDE.md` ([`6b61e09`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Noah-Martin1/commit/6b61e09dc6ac28200c99cd56fcebb6bed15df447)). I was using this baseline description in `CLAUDE.md` with prompts to change particular elements from the last iteration.

**The obvious thing:**  
Keep refining the written description and prompting Claude until the globe looked right.

**What I did instead:**  
I realised that describing a visual target through increasingly detailed prose was inefficient. I found visual references that already captured the character I wanted and gave them directly to Claude, changing the instruction from interpreting my description to recreating the qualities of the references ([`0f22b7c`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Noah-Martin1/commit/0f22b7cb371cd054957730d5d406025c683d5479); [`b882de0`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Noah-Martin1/commit/b882de0)).

**How I knew it was right:**  
The result was immediately much closer to the target, requiring only minor adjustments. I found that references communicated relationships between colour, contrast, glow and proportions more effectively than I could describe them.

### 2. Using context to dictate prompts

As the prototype became more complex, I had to decide what information should persist between Claude sessions and what only mattered for the current iteration.

**The obvious thing:**  
Put everything into `CLAUDE.md`, or repeatedly put the entire project context into each prompt.

**What I did instead:**  
Knowing that AI is virtually stateless, I treated the two as different types of context (or states). `CLAUDE.md` became the persistent project state: rules and behaviours that should remain true. Prompts became temporary state: what I had just observed and what currently needed fixing. 

For example, I gave Claude a prompt describing two current bugs: fibre routes not following the displayed cable network and the desktop traceroute beginning at stage 2 rather than stage 1. These were temporary implementation problems, so I left them in the prompt rather than turning them into permanent rules. The fixes landed in [`ffd2e44`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Noah-Martin1/commit/ffd2e440530d2f6d07962b7fe305be13927872dc) and [`a7a710a`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Noah-Martin1/commit/a7a710aa44a6519e1d7a02d504c65a4402b983c5).

**How I knew it was right:**  
Permanent requirements, such as vendoring data rather than fetching it at runtime, belonged in `CLAUDE.md` ([`b39440a`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Noah-Martin1/commit/b39440ad4bf1662c03b311f585356fe9f9553969)). This distinction prevented temporary bug reports from accumulating as permanent instructions.

### 3. Build on only what you need in `CLAUDE.md`

I initially wanted to extensively plan the entire website before development: visuals, UI flow, network stages, educational information and data.

**The obvious thing:**  
Write a comprehensive `CLAUDE.md` specifying every part of the finished website.

**What I did instead:**  
I started with a skeleton ([`6b61e09`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Noah-Martin1/commit/6b61e09dc6ac28200c99cd56fcebb6bed15df447)) containing the main principles and added detail only when Claude demonstrated that it could not infer something reliably. The clearest example was the UI flow. I wanted a continuous visual narrative centred around the globe, but Claude did not consistently interpret this from the skeleton. I therefore expanded the `Core Interaction` section with the precise origin, destination, scrolling, camera and traceroute sequence ([`4517dfb`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Noah-Martin1/commit/4517dfb18f378f2af93ee6de1ac982b7d26551f5)).

I deliberately did not prescribe every network-stage description because Claude was already producing relevant interfaces and educational information from the higher-level specification.

**How I knew it was right:**  
I added detail where it changed Claude's behaviour, rather than adding information simply because it could be described. This made `CLAUDE.md` a progressively strengthened harness rather than a document I had to fully predict before beginning.

## Before you ship

`pnpm check:evidence` verifies your citations resolve to real commits, that the
current reflection entry is in `reflections/`, and that your `CLAUDE.md` is
there — before a marker ever opens the file. It checks that your map is
traceable, not that it is good: the marker judges whether your small,
deliberately chosen set of moments shows real judgement and reflection. A green
check is not a substitute for that curation.

Images are deliberately not checked, because whether one renders is visible the
moment you look. Open this file on GitHub and look at it before you ship.
