export interface SidebarToggle {
  /** True while the sidebar is collapsed to its rail. */
  isCollapsed(): boolean;
  setCollapsed(collapsed: boolean): void;
}

/**
 * Collapses the control sidebar down to its rail.
 *
 * The button is appended into `.sidebar-rail` -- a strip that is part of the
 * sidebar's own flex layout rather than absolutely positioned against its edge.
 * That is deliberate: the earlier version hung the button off the edge with a
 * negative offset, so it was clipped by the host's overflow, scrolled away with
 * the panel on short viewports, and sat half under the neighbouring column. A
 * control that is inside the layout cannot be cut off by any of those.
 *
 * This is pure UI chrome -- it never touches app state, so nothing about route
 * building or the camera depends on whether the sidebar happens to be open.
 */
export function initSidebarToggle(hostId: string, label: string): SidebarToggle | null {
  const host = document.getElementById(hostId);
  const rail = host?.querySelector(".sidebar-rail");
  if (!host || !rail) return null;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "sidebar-toggle";

  const glyph = document.createElement("span");
  glyph.className = "sidebar-toggle-glyph";
  glyph.setAttribute("aria-hidden", "true");
  // Kept as text rather than an icon: it inherits the interface's own
  // monospace display face, so it reads as part of the chrome.
  glyph.textContent = "«";

  const text = document.createElement("span");
  text.className = "sidebar-toggle-text";

  button.append(glyph, text);

  function sync(collapsed: boolean): void {
    button.setAttribute("aria-expanded", String(!collapsed));
    // The accessible name states the action, and the visible text says the same
    // thing, so the state is never carried by the arrow's direction alone.
    const action = collapsed ? "Expand" : "Collapse";
    button.setAttribute("aria-label", `${action} ${label}`);
    button.title = `${action} ${label}`;
    text.textContent = action === "Expand" ? "Menu" : "Hide";
    glyph.textContent = collapsed ? "»" : "«";
  }

  function setCollapsed(collapsed: boolean): void {
    host!.classList.toggle("is-collapsed", collapsed);
    sync(collapsed);
  }

  button.addEventListener("click", () => setCollapsed(!host.classList.contains("is-collapsed")));

  rail.prepend(button);
  sync(false);

  return {
    isCollapsed: () => host.classList.contains("is-collapsed"),
    setCollapsed,
  };
}
