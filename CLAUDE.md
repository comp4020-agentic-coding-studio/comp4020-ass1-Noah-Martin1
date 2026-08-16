# CLAUDE.md

# COMP4020 Prototype

This project is Assignment 1 for COMP4020 Agentic Coding Studio.

The website is an interactive educational visualisation of how an internet request can travel from a user's location to a server somewhere else in the world.

The prototype is marked live in Chrome against the deployed URL at:

- Desktop: `1920×1080`
- Mobile: `390×844`

Both viewports count fully. The website must therefore be designed and tested deliberately for both sizes.

---

# Project

## Purpose

The website should help users who do not understand computer networks develop an intuitive understanding of how an internet request travels through different types of infrastructure.

The central experience is an interactive 3D globe. The user chooses where a request originates and where it is going, and the website then visually guides them through the journey of that request.

The experience should answer questions such as:

- Where does my internet request start?
- How does it leave my local area?
- What infrastructure does it travel through?
- What is a 5G tower doing?
- What are fibre-optic cables?
- What are servers and data centres?
- What happens when a request uses satellites?
- How can a request travel between continents?
- What does a traceroute actually show?
- Why might different requests take different routes?

The website is primarily an **educational visualisation**, rather than a networking diagnostic tool.

Routes shown by the prototype may be fictionalised, but they should be based on plausible infrastructure and real-world network behaviour. Do not present fictional routes as exact real-time packet routes.

---

# Core Interaction - the website MUST follow this flow:


load website, globe centered, starlink enabled, -> visually we see the globe slowly spinning with milky way and stars behind it. The satellites are orbittingat 10x their real speed. We see a prompt box asking us to select a loaction to send internet request. we hover our cursor over the the earth, in locations where starlink is avaliable (to send request from) there is a small green circle under the cursor to indicate where youre going to select the first location. Next to the cursor and green circle will be the location you are hovering over. Now, this location might not be connected to the internt via fiber cabling. In this case, and when starlink is not selected, we assume its connected via 5g towers. for example if we select "white cliffs NSW Australia" we visualise a radio waves coming from the nearest 5g tower, and the signla propergating throughh this to the nearest network core (via fiber optic).

If the circle is red a prompt near your cursor will say “sorry! no connection here”. After selecting the send from location and starlink is selected, make all the satellites not orbiting over the send location dissapear, and the ones that orbit over the loaction, have their orbit line appear in a faint way, pulsing to show their orbit path. 

The destination process is a different selection process, destination should be one of the major data-centers located around the world. For this selection process, I want the data centers to be visble, in a new colour and a bit larger than the cell towers - to make it obvious where it is. This means that if the "servers" toggle is off, the data centers are temporarly shown for this selection process. Now, i want the cursor to snap to the closest data center highlighting the data center that the cursor is over and providing its loacation. this shoudl be implemented without limiting the users ability to grab and spin the globe. so the snap radius mustnt be too large. These data centers should be connected to the "servers" slider that toggles their visibility. 

these events will be controlled through the scroll, on the main page.

If starlink is selected, and the traceroute is going through starlink, i want the traceroute to be a animated interactive path showing its direction and signal. First i want the satelities to slow down. The animation order should follow the "Scroll-Based Storytelling" order starting with the device as number 1. then to their real speed and the camera to zoom in on the signal going from earth to the satellite, showing it from a horizontal view, visualising the vertical travel to space. Then it zooms out and the webiste shows the signal moving to other satelites, connecting them (these are actual satelleits the websites use before orbiting the earth - so if it needs to unhide them for this then it needs to do that. the satellites will be travelling very slow for this so its clear whats happening) then it goes through the next nodes (starlink base station etc etc). as it goes through each node provide facts for how it works. Once the traceroute reaches its destination, zoom completely out for the route to be in view.

if starlink isnt selected, i want the camera to zoom into the first traceroute jumps, The animation order should follow the "Scroll-Based Storytelling" order starting with the device as number 1, then  if the second one is cell tower, it zooms into the request loaction, providing informatoin about hwo the cell tower moves the packet request. The user scrolling will control the progress of the packet moving to the next node and so on until it reaches the destination server.

Either way via starlink or not, Once the traceroute for the packet send is in view, animate the response treace route wuth a different colour - make it a blue traceroute rather than green, in one higher view make it animated to show its path.



---

# Traceroute Modes

There are two primary modes.

## Starlink OFF

When Starlink is disabled, the request should be visualised using conventional terrestrial/mobile internet infrastructure.

The conceptual path is:

`User → 5G tower → fibre/network infrastructure → destination network → server`

This does not need to represent every physical router. The purpose is to communicate the major stages of the journey.
it needs to show: the tower, the nearest network core -> destination network -> server

### Origin selection

The user should be able to select a location on the globe.

The prototype may assume that most populated areas have mobile coverage.

Areas that are extremely remote, uninhabited, ocean, Antarctica, or otherwise unsuitable for the simplified 5G model should be unavailable or visually greyed out.

Avoid implying that every point on Earth genuinely has 5G coverage.

### 5G

If the selected origin is not directly associated with a major city, assume the request first reaches a nearby 5G tower.

5G towers may use:

- Real tower locations where suitable public data is available.
- A simplified distribution of towers across populated regions when exact data is unavailable.

The visualisation should prioritise clarity over geographic precision.

The wireless portion of the route should be visually distinct from fibre.

For example:

`device → ))) → 5G tower → fibre`

The radio-wave animation should make it immediately understandable that this section of the journey is wireless.

### Fibre

Fibre-optic infrastructure should form the main long-distance terrestrial and undersea network.

The visualisation should use simple glowing lines rather than trying to display every individual cable.

Where possible, use realistic major cable routes and network connections.

The route should favour major network hubs and server locations rather than appearing to connect arbitrary points directly.

---

# Starlink ON

When Starlink is enabled, the experience should introduce satellites as another layer of the network.

The conceptual path is:

`User → Starlink satellite → satellite(s) → Starlink ground station → terrestrial network → server`

The visualisation should communicate that a Starlink request can move through multiple satellites before reaching a ground station.

It should not imply that every Starlink request follows exactly the same route.

## Satellite display

The globe should display Starlink satellites as small points surrounding Earth.

Satellite positions do not need to be live.

Use publicly available orbital information where practical, but prioritise a visually believable distribution of satellites.

The satellites should:

- Be distributed around Earth rather than clustered.
- Have different orbital positions.
- Move independently rather than appearing perfectly synchronised.
- Orbit at approximately `10×` real-time speed for the visualisation.

The purpose of the accelerated motion is to make orbital movement visible to the user.

## Satellite selection

When the user selects an origin location, the visualisation should simplify the satellite layer so that only satellites relevant to that location remain prominent.

The selected location should determine which satellites are considered visible/usable in the simplified model.

The remaining satellites should continue moving at the accelerated rate.

## Starlink ground stations

When a Starlink route is being visualised, relevant Starlink ground stations should become visible.

The route should communicate:

`origin → satellite → satellite → ground station → terrestrial network`

Do not draw arbitrary satellite-to-satellite connections simply for visual effect. Connections should represent the conceptual path being explained.

---

# Random Route

The user should be able to choose a random route.

A random route should select:

- A plausible origin.
- A plausible destination.
- Appropriate infrastructure for that route.

When Starlink is disabled, the random route should use the conventional network model.

When Starlink is enabled, the random route should include an appropriate satellite-based section.

Random routes should remain understandable and geographically plausible.

Do not randomly select locations that make the visualisation impossible to explain.

---

# Scroll-Based Storytelling

The traceroute should progress as the user scrolls.

Scrolling is not simply page navigation. It is part of the visualisation.

Each major scroll stage should:

1. Move/highlight the route to the next node.
2. Visually emphasise the relevant infrastructure.
3. Explain what is happening.
4. Provide a useful networking fact.
5. Maintain the user's understanding of where the request currently is.

For example:

### Stage 1 — Your device

Explain that the request begins on the user's device.

### Stage 2 — Wireless connection

Explain that the device communicates with a nearby cellular tower using radio.

### Stage 3 — Fibre network

Explain that long-distance internet traffic is predominantly carried through fibre-optic infrastructure.

### Stage 4 — Network hubs

Explain that traffic passes through interconnected networks and routing infrastructure.

### Stage 5 — Undersea cable

If the route crosses an ocean, explain that continents are connected by submarine fibre-optic cables.

### Stage 6 — Server/data centre

Explain that the request eventually reaches the network hosting the requested service.

The exact stages should change depending on the route.

---

# Educational Content

Educational information is a core feature, not decoration.

Every major route step should teach the user something.

Information should be:

- Accurate.
- Concise.
- Easy for a non-technical user to understand.
- Directly connected to what is currently happening on the globe.

Avoid large blocks of networking terminology without explanation.

When technical terminology is necessary, explain it in plain language.

Important concepts that may be introduced include:

- IP addresses.
- Packets.
- Routers.
- Routing.
- Autonomous systems.
- ISP networks.
- 5G.
- Radio access networks.
- Fibre optics.
- Submarine cables.
- Internet exchange points.
- Data centres.
- Servers.
- Latency.
- Ping.
- Traceroute.
- Satellites.
- Starlink ground stations.
- Inter-satellite links.

The educational content should progressively become more technical rather than overwhelming the user immediately.

---

# Visual Direction

The overall visual language should be:

**Modern vector + technical + spatial + atmospheric.**

The design should feel like an interactive network map rather than a conventional corporate website.

The site loads straight into the globe — there is no landing hero or scroll-to-reveal step. On the globe itself, an unmissable prompt next to it — not the origin/destination dropdowns — is the primary way a first-time user is invited to act ("Choose where to send from", "Now pick the destination data centre", "Scroll to follow the request."); the dropdowns are kept only as a keyboard/screen-reader fallback behind a disclosure. The Starlink switch ("Use Starlink?") and the ground-stations switch live together in one grouped box, as two separate toggles. See "Prompt-primary selection" and "The globe is a second scrollbar for the journey" under Implementation Decisions for how these are built.

## Globe

The globe is the primary visual element.

It should:

- Be dark blue.
- Have light-coloured continents.
- Have subtle glowing outlines.
- Remain visually dominant.
- Feel clean and vector-like.
- Have enough contrast that network paths remain visible.

The globe should be centred prominently when the site starts.

Avoid filling the globe with excessive labels and infrastructure immediately.

## Background

The background should represent space.

Use:

- Dark space.
- Stars.
- A subtle Milky Way/nebula treatment where appropriate.
- A sun.
- A moon.

The background should remain secondary to the globe.

Stars should move subtly as the globe rotates to reinforce the sense that the Earth exists in space.

Do not make the background so bright or detailed that it competes with the network visualisation.

## Idle animation

When the user is not interacting:

- The Earth may rotate slowly.
- Stars should move subtly.
- Satellites should continue orbiting.
- Animations should remain calm.

Do not create constant aggressive movement.

---

# Infrastructure Visual Language

Different infrastructure types should be visually distinguishable.

Use consistent visual conventions throughout the application.

## Fibre-optic cables

Represent with:

- Thin glowing lines.
- Clear geographic paths.
- Subtle animation when active.

Fibre should normally be visible at low intensity.

## 5G towers

Represent with:

- Small tower markers.
- A subtle glow.
- Radio-wave animation when the request reaches a tower.

5G towers should not cover the entire globe with thousands of markers.

## Starlink satellites

Represent with:

- Small bright dots.
- Motion around Earth.
- Greater prominence when Starlink mode is active.

## Starlink ground stations

Represent with:

- Distinct markers from normal servers.
- A visible connection to the active satellite route.

## Major servers

Represent major server/data-centre locations with glowing city/network markers.

Major locations should be visible but not overpowering.

## Cities

Major cities should appear as subtle sparkling/glowing points.

They should help users understand geography without turning the globe into a wall of labels.

---

# Infrastructure Controls

The interface should provide sliders/toggles that control infrastructure highlighting.

Users should be able to highlight:

- Fibre-optic cables.
- 5G towers.
- Starlink ground stations.
- Major servers.

These controls should change visual emphasis rather than completely destroying the underlying map.

For example:

- Off = infrastructure remains subtle.
- On = infrastructure becomes brighter/more prominent.

The Starlink mode itself should use a clear on/off control.

**Superseded:** this section originally required Starlink to be OFF by default. The later
"Core Interaction — the website MUST follow this flow" section requires the page to load with
Starlink **enabled** and the constellation already orbiting, and that is what the build does.

The original concern still stands and is answered differently: the default view is kept calm by
isolating the constellation once an origin is chosen, and by leaving every infrastructure layer at
low emphasis until its toggle is switched on — not by hiding the satellites at load.

---

# Interaction Design

The interface should always make the current state understandable.

The user should know:

1. Which mode they are using.
2. Where the request starts.
3. Where it is going.
4. What infrastructure is currently being used.
5. What stage of the journey they are viewing.
6. What they have just learned.

Avoid hidden interactions that require the user to guess what to do.

Selection states should be obvious.

When selecting a location:

- The selected location should glow.
- The globe should remain oriented around the selection where appropriate.
- Invalid areas should be visually unavailable.
- The interface should provide clear feedback.

---

# Mobile

The mobile viewport is `390×844` and must be treated as a first-class layout.

Do not simply shrink the desktop design.

On mobile:

- The globe remains the primary element.
- Controls should be compact.
- Text should remain readable.
- Interactive controls must be easy to tap.
- Scroll-driven storytelling must still work.
- UI panels should not cover the globe unnecessarily.
- Satellite visualisation must remain performant and understandable.

Avoid hover-only interactions.

Anything essential must work with touch.

---

# Accessibility

Accessibility is part of the prototype quality.

Do not communicate information only through colour.

Interactive elements should have:

- Accessible names.
- Keyboard support where appropriate.
- Visible focus states.
- Sufficient contrast.
- Clear selected/unselected states.

Animations should respect `prefers-reduced-motion`.

The visualisation can be highly animated, but users should have a reduced-motion experience that remains understandable.

---

# Technical Principles

## Prefer real data where it improves authenticity

Use public datasets where they provide meaningful value, especially for:

- Starlink orbital information.
- Major cities.
- Major server/data-centre locations.
- Submarine cable routes.
- Starlink ground stations.

However, do not allow data acquisition to dominate the project.

When accurate data is unavailable, use a clearly simplified model.

The goal is an educational visualisation, not a complete replica of the global internet.

## Avoid fake precision

Do not display extremely precise-looking information when the underlying data is fictional or simplified.

For example, if a fibre route is an approximation, the interface should not imply that the displayed line represents the exact physical path of a specific packet.

Similarly, fictional traceroutes should not be presented as live packet captures.

## Performance

The globe and animation should remain responsive.

Be careful with:

- Large numbers of DOM elements.
- Excessive SVG paths.
- Continuous expensive calculations.
- High-resolution textures.
- Hundreds/thousands of independently animated elements.

Prefer efficient rendering techniques where appropriate.

If using WebGL/Three.js or another 3D rendering system, keep rendering architecture organised and avoid unnecessary per-frame work.

---

# Code Organisation

Keep the code organised around clear responsibilities.

Prefer separating:

- Globe rendering.
- Camera/interaction controls.
- Route data.
- Geographic data.
- Satellite simulation.
- Infrastructure rendering.
- Scroll progression.
- Educational content.
- UI controls.
- Application state.

Do not put the entire visualisation into one giant component/file.

Route data should be represented as structured data rather than hard-coded directly into rendering logic where practical.

For example, a route step should conceptually contain:

- Node type.
- Geographic location.
- Infrastructure type.
- Display title.
- Explanation.
- Educational fact.
- Visual behaviour.

This makes the educational narrative easier to expand.

---

# Accuracy Guidelines

The following distinctions are important.

### Traceroute

Traceroute identifies network hops by sending packets with increasing TTL values and observing responses from intermediate network devices.

It does **not** provide a complete physical map of the internet.

The website should therefore describe the visualised route as a simplified physical/network interpretation.

### Fibre

Fibre-optic cables carry enormous quantities of internet traffic over long distances using light.

They are the primary infrastructure for long-distance terrestrial and submarine internet connectivity.

### 5G

5G is a radio access technology connecting devices to cellular networks.

After the wireless connection, traffic generally enters the operator's wired network.

### Starlink

Starlink uses low-Earth-orbit satellites to provide connectivity.

Depending on the network configuration and available infrastructure, traffic may use satellite-to-satellite links and ground stations.

Do not imply that every Starlink connection follows the exact same path.

---

# Development Workflow

- Keep the dev server running with `pnpm dev`.
- Inspect the rendered page frequently.
- Test both `1920×1080` and `390×844`.
- Use browser tooling when available.
- The rendered page is the source of truth.
- Do not assume something looks correct because the code appears correct.
- Before pushing, run `pnpm check`.
- Fix the actual cause of failed checks rather than suppressing the check.
- Commit frequently in small logical changes.
- Never commit a known broken state.

When changing the visualisation, check:

1. Desktop layout.
2. Mobile layout.
3. Globe interaction.
4. Scroll progression.
5. Animation performance.
6. Accessibility.
7. Build.
8. Tests.

---

# Design Rules for the Agent

When implementing new features:

### Do

- Preserve the central globe as the visual focus.
- Prefer subtle visual hierarchy.
- Use animation to explain network behaviour.
- Make interactions discoverable.
- Keep educational content connected to the current visual state.
- Make desktop and mobile layouts intentionally different where necessary.
- Use realistic geographic relationships.
- Reuse established visual conventions.
- Keep the interface visually clean.

### Do not

- Turn the website into a generic dashboard.
- Cover the globe with excessive panels.
- Add unnecessary cards everywhere.
- Use random decorative animations without purpose.
- Add hundreds of labels that obscure geography.
- Present fictional network routes as live factual traceroutes.
- Claim data is real-time when it is not.
- Make Starlink the default visual state.
- Sacrifice mobile usability for desktop aesthetics.
- Add a feature merely because it is technically interesting if it makes the educational experience harder to understand.

---

# Prototype Priorities

When trade-offs are necessary, prioritise in this order:

1. The globe and core interaction work.
2. The route can be selected and visualised.
3. Scroll-driven storytelling works.
4. The educational explanations are clear.
5. The visual hierarchy is strong.
6. Desktop and mobile both work.
7. Infrastructure visualisations are believable.
8. Starlink mode works.
9. Additional realism/data is added.
10. Decorative polish.

A smaller, coherent and understandable visualisation is better than a technically ambitious but confusing prototype.

Check that the modelling doesnt break - check that when the website is opened and closed - switch tabs and returned to - doesn't change the webistes visuals.

---

# COMP4020 Process Requirements

## How to work in here

- Keep the dev server running (`pnpm dev`) so you see changes as you make them.
- Before you push, run `pnpm check`.
- Use `pnpm dlx linkinator ./dist --silent` after a fresh `pnpm build` when checking links locally.
- Open the rendered page in a browser when visual behaviour matters.
- Treat the rendered page as the source of truth.
- When a check fails, read its output before changing anything.
- Never commit a red state.

## The checks

CI runs:

- typecheck
- build
- deploy/online
- spec
- lint
- tests
- evidence
- links
- secrets

`pnpm check` is the main local verification command.

Do not weaken, remove, or bypass checks simply to make the project pass.

---

# Your Process Is Part of the Mark

Commit as you go.

Use small, meaningful commits that show how the project developed.

Maintain:

- `PROCESS.md`
- `reflections/`
- `CLAUDE.md`

The process history is part of the assessment.

`PROCESS.md` should act as a reading guide to how the work came together rather than an essay.

The reflection should explain:

- The breakthrough that moved the work forward.
- What the work changed about the developer you want to become.

Do not fabricate process evidence after the fact.

---

# Implementation Decisions

These are settled. Do not rediscover or quietly reverse them.

## Where the rendering lives

Active rendering is `src/globe2/`. The earlier `src/globe/` is the superseded prototype, kept because the process history is marked; only `src/globe/geometry.ts` is still shared (and it is covered by the spec tests). Do not add features to `src/globe/`.

## The camera orbits; the Earth does not spin

The Earth is fixed in world space and the camera orbits it (`src/globe2/orbit-controls.ts`). This is not a stylistic choice:

- The stars, Milky Way, sun and moon live in world space, so orbiting the camera sweeps them past naturally, which is the behaviour the reference (satellitemap.space) has.
- Rotating the globe group instead leaves the sky nailed in place and forces a faked star-parallax hack, which is what the first implementation did.

So: never rotate the globe group to represent user input, and never parent sky objects to the camera.

## Framing is layout-driven, not canvas-driven

The canvas is fixed and fills the window so space runs edge to edge. The planet is centred on `#globe-focus`, an invisible CSS layout box, read each resize and applied through `camera.setViewOffset` (an off-axis frustum shift, so nothing skews).

This is why the layout works at any resolution instead of only `1920×1080` and `390×844`. Those two sizes are what gets *marked*; they are not the only sizes that must work. Never size the renderer to a fixed box or hard-code either viewport.

## Data is vendored, never fetched from third parties at runtime

`public/data/` holds snapshots produced by the `scripts/fetch-*.ts` scripts (CelesTrak GP catalogue; Natural Earth land, populated places and named places; TeleGeography submarine cables; SpaceX availability; OpenCelliD towers). Always load them through `dataUrl()` in `src/data/generated/datasets.ts` — `base` is `"./"` for GitHub Pages, so an absolute `/data/...` fetch works locally and 404s once deployed.

### Cell towers: a raster, deliberately

`scripts/fetch-towers.ts` reads the World Bank's rasterised OpenCelliD snapshot (30 arc-second global grid, CC BY 4.0). Do not go looking for the OpenCelliD point dump instead — it is tens of millions of rows behind an account token, and could be neither shipped nor drawn. At 1 km a populated cell *is* a tower location to the precision this visualisation can honestly claim.

Two things about that file will bite anyone who touches the script:

- **Its strips are not in row order.** Row 0 begins 629 MB into a 933 MB file and 284 rows are stored back near the front. Read `StripOffsets`; assuming the pixels are one contiguous block after the header silently puts London, Paris and Sydney on empty ocean.
- **The selection is stratified, not top-N.** One marker per 0.25° block that has any tower at all. Ranking globally by density keeps city centres and deletes the countryside — which is the exact case the 5G story exists to explain.

### Submarine cables: branches join mid-span, not just end-to-end

`src/data/cable-paths.ts` walks a system's branches to draw a submarine leg along the cable that really carries it. Every TeleGeography feature is a MultiLineString whose branches must be chained, and **the join is usually not at a branch's endpoint** — a country drop or a trunk continuation T's off the middle of another run.

Chaining end-to-end only (the first implementation) rejected whole systems that plainly connected both hubs, and `between()` then returned null and the leg silently fell back to a great circle. Cape Town → London drew a straight line across the African continent; Los Angeles → Panama and Marseille → Dubai failed the same way. So junctions are built by matching each branch *end* against the nearest *vertex* of every other branch, and the walk is a Dijkstra over those junction "ports".

`spec/cable-paths.test.ts` asserts every submarine `HUB_EDGE` resolves to a real path. **A null from `between()` is invisible in the UI** — it just quietly draws an arc — so that test is the only thing standing between a regression and a line through the middle of a continent. Keep it passing rather than relaxing it.

### Data centres: OpenStreetMap, and why not PeeringDB

`scripts/fetch-datacentres.ts` reads OSM's `telecom=data_center` via Overpass (ODbL, 4,469 sites).

**Do not switch this to PeeringDB.** It is the better registry and it was evaluated and rejected: its AUP reserves all rights, forbids passing data "on in bulk to any other person or organization unless approved", and lists demographic mapping and commercial applications as excluded purposes. Vendoring its facilities into a public repo and deploying them is exactly the bulk redistribution that policy prohibits. Check the licence before vendoring any dataset — being the best data source is not the same as being a usable one.

Tier comes from how many mapped sites share an operator, so it describes operator size and makes no claim about an individual building.

Overpass notes: it answers 406 to `fetch()`'s default `text/plain` body (send the query as a form field), and rate-limits hard, so the script tries several mirrors and takes `--from <file>` for a response already on disk.

## The origin is a point, not a city

`state.origin` is a `RouteOrigin` — an arbitrary lat/lon plus a resolved label. It is **not** a city id, and must never be snapped to the nearest modelled city: doing so moves a request from White Cliffs to Sydney and destroys the reason the wireless hop exists. The destination does snap, because a data centre genuinely is in a specific place.

The tower lookup is injected into `state` via `setTowerLookup()` rather than imported by the route builder, so `buildRoute` stays a pure function of its inputs and a route can still be built — without the radio hop — before the 2 MB tower file has arrived.

## Marker layers must discard the far hemisphere

Every marker layer uses additive blending, which ignores the depth buffer, so points on the back of the globe shine straight through it. `MARKER_VERTEX` computes a `vFacing` term and the fragment shader discards on it. This is invisible with a few dozen markers and a bright halo around the limb with ninety thousand — do not remove it when adding a layer.

## Orbits: Kepler + J2, and say so

`src/globe2/orbits.ts` propagates the whole catalogue with Keplerian motion plus the J2 secular terms, not full SGP4. It is accurate for a fresh snapshot of near-circular LEO and cheap enough to run across ~10,700 satellites every frame.

The `#data-note` element states the satellite count, the snapshot date, that the model is simplified, and that motion is at 10× speed. **If the propagation, data source or speed changes, that disclosure changes with it.** Never let the UI imply a live feed or an exact ephemeris.

## Performance: the cost is fill-rate, not object count

Measured, not assumed: drawing all ~10,700 satellites costs roughly nothing (one draw call, a few flops each), while frame rate tracks pixel count. The expensive thing is the bloom pass.

So the scene times itself and steps quality down (`notifyFrame` in `src/globe2/scene.ts`); `?quality=high` or `?quality=low` pins a tier, which is how to take reproducible screenshots on a machine whose GPU differs from the viewer's. Before optimising anything here, measure which of the two it is — headless Chromium runs on SwiftShader and is not representative of real hardware.

### Only credible frames may downgrade a tier

The decision lives in `src/globe2/quality-sampler.ts`, extracted from the scene so it can be tested without a WebGL context — `spec/quality-sampler.test.ts` covers it.

This caused the long-standing "the globe goes low-resolution and blown-out after switching tabs, and only a reload fixes it" bug. Browsers throttle `requestAnimationFrame` to roughly 1fps in a background tab, the loop was feeding the real unclamped delta to the sampler, and ~1000ms frames read as a sustained 1fps — so twenty seconds in another tab silently stepped High → Medium → Low. At `Low` the pixel ratio halves *and* `render()` bypasses the composer, and those two together are exactly the reported symptom.

So: frames longer than `MAX_CREDIBLE_FRAME_MS` (250ms) are a stall, not a frame rate, and discard the window instead of contributing to it. `main.ts` also re-bases `lastTime` and calls `resetFrameSampling()` on `visibilitychange`. **A downgrade must only ever come from frames the GPU actually rendered.** If you add another source of long frames, make sure it cannot reach the sampler.

Context loss is handled too (`webglcontextlost`/`webglcontextrestored` in `scene.ts`): the lost event must call `preventDefault()` or the browser never restores, `render()` no-ops while lost, and `resize()` rebuilds the composer's targets on restore. Recover in place — never reload the page to paper over a rendering fault.

## Prompt-primary selection

The on-globe prompt (`#prompt-host`, `src/ui/prompt.ts`) is the primary selection mechanic; the origin/destination `<select>` elements in `src/ui/panel.ts` are kept only for keyboard/screen-reader users and sit behind a collapsed `<details>` disclosure. Don't remove the selects outright — that would regress the Accessibility section above — and don't promote them back above the prompt.

Ground stations live in a `<fieldset class="mode-box">` alongside the Starlink switch, because the two toggles are conceptually related (ground stations only matter once Starlink is on) even though they stay independent switches. If a new mode-specific toggle is added later, it belongs in `mode-box`, not the layer pills.

## The left rail is the site's only navigation, and the collapse control lives inside it

`.sidebar-rail` (markup in `index.html` and `about.html`, styles in `styles.css`) holds the primary nav links and, on the globe page, the collapse button injected by `src/ui/sidebar-toggle.ts`. There is no top-right nav — it was removed, and a second navigation system must not be reintroduced somewhere else.

The collapse button is **inside the sidebar's flex layout**, in a strip that never scrolls. An earlier version floated it off the sidebar's right edge on a negative offset, and every viewport variation broke it a different way: clipped by the host's `overflow`, scrolled out of reach with the panel on short screens, or half-hidden under the neighbouring column. Anything that has to stay reachable at every viewport size belongs in the layout, not hanging off it — do not reach for absolute positioning to fix a control that is getting clipped.

Collapsing hides `.control-host-inner` only. The rail always survives, which is what guarantees there is always a way back.

### Mobile collapse means gone, not smaller

On mobile the collapsed sidebar goes `position: fixed` as a pill in the bottom-left corner, so its grid row drops to zero height and the space genuinely returns to the globe (`.ui:has(#control-host.is-collapsed)` retunes `grid-template-rows`). Collapsing it to a short band instead — which is what it did first — leaves the row still eating height and misses the point.

`applyPhase()` in `main.ts` stamps `document.body.dataset.phase` and, on narrow screens only, auto-collapses on entering `"journey"` and reopens on leaving it: during the traceroute the controls are spending height on choices already made. This runs only on phase change, so it never fights a deliberate collapse or expand by the user.

## The globe is a second scrollbar for the journey, once one is playing

`orbit-controls.ts`'s existing suspend/resume mechanism (camera director owns the camera during a scripted shot; grabbing the globe hands it back via `onUserTakeControl`) already covered "click the globe to drop into free orbit" and "click a sidebar step to resume the scripted shot." The only missing piece was scroll: `onWheel` now checks `isSuspended()` and, if true, forwards `deltaY` to `story.el.scrollTop` instead of zooming (`onWheelWhileSuspended` in `main.ts`) — reusing the sidebar's own scroll-position plumbing rather than duplicating stage-scrub logic against the wheel. This is inert outside the journey phase (never suspended there), so it changes nothing about origin/destination selection.

## Sidebar stage progression is driven by scroll position, not IntersectionObserver ratios

`story.ts`'s `updateActiveStage()` picks whichever stage's vertical centre is nearest the panel's centre, computed directly from `el.scrollTop` — not by comparing `IntersectionObserver` entries' intersection ratios. The ratio-based version had a real bug: `entries` only contains stages whose ratio just crossed one of the observed thresholds *in that callback*, and on a fast scroll (including the globe-forwarded wheel deltas, which can arrive in large steps) several stages cross thresholds in the same batch — so "whichever has the largest ratio" was not necessarily the one the scroll passed through first, and the sidebar (and the camera beat it drives) could visibly step backward (stage 2, then 1, then 3) instead of advancing in order.

Reading geometry off `scrollTop` instead is a plain lookup with no batching: stages are stacked top-to-bottom, so "nearest to the centre" only ever moves monotonically as `scrollTop` increases, regardless of how large a single scroll event is. `buildStages()` still resets `el.scrollTop = 0` and calls `updateActiveStage()` on every route rebuild (e.g. toggling Starlink), and a `window` resize listener recomputes it too, since a resize moves every stage's offset without firing a scroll event.

---

# This File Is Living Documentation

Update this `CLAUDE.md` when the project develops a recurring convention, constraint, architectural decision, or lesson that future agent work should know.

Do not allow this file to become a generic description of the website.

It should increasingly describe **how this specific project should be built** and the decisions that keep the implementation coherent.

When an implementation decision becomes important enough that the agent should not repeatedly rediscover it, document it here.