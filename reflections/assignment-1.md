# Assignment 1 reflection

**The breakthrough that moved the work forward** was deciding what Starlink
should actually replace. My first instinct was the simple version: a toggle
that swaps the whole route for an all-satellite path. That would have been
easy to build and easy to demo, but it isn't how Starlink works — it's a
last-mile technology, not a replacement for the entire internet backbone. Once
I modelled it that way instead (device → satellite → ground station, then back
onto the same fibre, exchanges, and undersea cables a normal request uses), the
rest of the prototype's educational framing fell into place: the story panel
could honestly say "this part is different, this part isn't," which is the
actual point of the assignment. The harder, more accurate model turned out to
be less work than I expected, because it reused almost all of the terrestrial
route-building logic instead of duplicating it for a satellite-only path.

**What this changed about who I want to be as a developer** is a bias toward
measuring instead of eyeballing. Twice in this project a screenshot looked
fine at first glance while the underlying layout was wrong — a non-square globe
using half its available space, and a `<select>` silently overflowing on
mobile — and both only surfaced once I scripted the browser to actually read
`clientWidth`/`clientHeight` and compare them. I want to carry that habit
forward: a check that measures a real number is worth more than a check that
asks "does this look right," because "looks right" is exactly the case where a
subtle layout bug hides.
