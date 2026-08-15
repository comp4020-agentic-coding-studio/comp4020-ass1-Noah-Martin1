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
measuring instead of eyeballing — and, more specifically, toward measuring
before optimising. When the globe dropped to 7fps with all 10,753 satellites on
screen, the satellites were the obvious suspect and cutting them down was the
obvious fix. Measuring took ten minutes and showed the opposite: turning the
satellites off changed nothing, while shrinking the window quadrupled the frame
rate. The cost was the bloom pass, not the objects. Had I trusted the obvious
reading I would have thrown away the exact thing the visualisation is *for* —
the density of a real constellation — to fix a problem it wasn't causing.

The same lesson showed up quietly in layout, where screenshots that "looked
fine" hid a globe box that wasn't square and a `<select>` overflowing its
container; both only surfaced once I read the real numbers out of the DOM. I
want to be the kind of developer who treats "this looks right" as a hypothesis
rather than a result, because looking right is precisely the condition under
which the wrong fix is most tempting.
