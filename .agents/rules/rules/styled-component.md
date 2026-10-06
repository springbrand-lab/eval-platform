# Web Styling and Design Tokens

The filename is retained for migration history. This project does not use
styled-components. Web styling uses Tailwind CSS 4, `@springbrand/styles`,
and styles exposed by Dune React components.

Applies to `web/src/**/*.tsx` and `web/src/**/*.css`.

## Shared styles first

- Read the installed `@springbrand/styles` Skill before changing themes,
  tokens, dark mode, or shared styling.
- Prefer semantic utilities such as `bg-background`, `text-foreground`,
  `border-border`, and `text-muted-foreground`.
- Check `@springbrand/site-block` and `@springbrand/gravel` before styling a
  replacement for an existing primitive.
- Keep application overrides after the imported package styles.

Do not add styled-components or another CSS-in-JS dependency for local styling.

## Tokens

Use existing semantic color, spacing, radius, and control-size tokens when they
express the design. Do not copy package tokens into the application or add a
second source of truth.

Raw color literals belong in owned token/theme definitions or exact asset
rendering, not ordinary component styling. Before adding a token to
`web/src/styles/theme.css`, verify that `@springbrand/styles/theme.css`
does not already own the concept. Preserve light/dark contrast and focus
visibility.

Off-scale values are acceptable when they represent a real measured constraint,
such as a one-pixel border or an asset dimension. Do not distort a design merely
to force every value onto a token.

## Responsive behavior

Prefer responsive CSS when only presentation changes. Use
`@springbrand/hooks` media hooks only when rendered behavior must change, and
account for their initial client value. Respect reduced-motion preferences for
non-essential animation.
