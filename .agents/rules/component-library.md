# Web UI Components: Check the Owning Library First

Applies to React UI under `web/src/**`.

Before adding or changing a button, input, dialog, menu, form control, layout,
feedback state, or decorative block:

1. Read the matching installed Dune React Skill referenced by the root
   `AGENTS.md`.
2. Check the installed package's public exports and declaration files for the
   exact supported API.
3. Compose an existing component when it owns the required accessibility,
   interaction, state, or styling behavior.

Use:

- `@springbrand/site-block` for ordinary application controls, forms,
  dialogs, navigation, data display, and feedback;
- `@springbrand/gravel` for its supported visual blocks and responsive
  dialog composition;
- `@springbrand/hooks` for shared theme, media, reduced-motion, and scrolling
  behavior;
- `@springbrand/styles` for shared semantic tokens and CSS layers.

Feature-specific composition may remain in `web`. Do not create a local copy,
wrapper, fork, or parallel state path for a capability owned by a
`@springbrand/*` package. If a published package needs a new capability,
change it upstream, publish it, and upgrade the dependency; never edit
`node_modules`.

Use semantic HTML, accessible names, keyboard behavior, and visible focus
states. Use an anchor for navigation and a button for an action.
