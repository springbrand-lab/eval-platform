# React Test Selector Rules

Applies to React components and tests under `web/src/**`.

## Prefer user-visible selectors

Tests should first query by semantic role, accessible name, label, placeholder,
or visible text. These selectors verify the same contract users and assistive
technology depend on.

Do not require a test ID on every component, add a wrapper solely to carry a
selector, or expose internal component structure without a test need.

## When a test ID is justified

Use `data-testid` only when no stable semantic selector exists, such as an
otherwise anonymous structural region needed by an integration test.

A test ID must be:

- deterministic;
- kebab-case;
- stable across data values;
- scoped clearly enough to avoid ambiguity.

Do not generate it from random values or timestamps. Dynamic entity identifiers
may be passed separately when the test genuinely needs to distinguish rendered
items.

Dune components may expose `data-slot` for styling and composition. Reuse it
when it is the public package contract, but do not treat every internal slot as
a permanent application test API.
