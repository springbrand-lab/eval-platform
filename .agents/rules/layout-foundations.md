# Web Layout Foundations

Applies to layout code under `web/src/**`.

Read the installed `@springbrand/site-block`, `@springbrand/hooks`, and
`@springbrand/styles` Skills before changing shared layout behavior.

## Viewport and safe areas

- Prefer `dvh` utilities or `100dvh` for full-height mobile layouts rather
  than raw `100vh` alone.
- Fixed or sticky controls at a viewport edge must account for the relevant
  `env(safe-area-inset-*)`.
- Reuse package layout primitives when they already own the behavior.

## Scrolling

- Make the main scroll owner intentional. Avoid nested scrolling regions unless
  the interaction requires them.
- A scrollable flex or grid child must be able to shrink, typically with
  `min-h-0` or the equivalent.
- Nested scroll surfaces should contain overscroll when page scroll chaining or
  pull-to-refresh would be harmful.
- Do not hide overflow as a substitute for understanding which element should
  scroll.

## Responsive behavior

- Prefer Tailwind responsive utilities or CSS media queries for presentation.
- Use `@springbrand/hooks` only when behavior or rendered structure must
  change in JavaScript.
- Do not read `window.innerWidth` once and treat it as reactive state.
- Preserve usable touch targets and visible focus states at every breakpoint.

## Floating surfaces

Dialogs, drawers, popovers, dropdowns, command surfaces, and long menus must:

- remain within the dynamic viewport and relevant safe area;
- have an intentional internal scroll region when content can grow;
- avoid scroll chaining into the page;
- preserve focus trapping, Escape behavior, and accessible titles supplied by
  the owning Dune primitive.

Prefer `Dialog`, `AlertDialog`, `Drawer`, `Sheet`, `Popover`, or
`DropdownMenu` from `@springbrand/site-block` instead of recreating their
positioning and interaction locally.
