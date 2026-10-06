# React Component Decomposition

Applies to React code under `web/src/**`.

Before changing Web UI, read the relevant installed Dune React package Skills
listed in the root `AGENTS.md`, then inspect the component, its callers, and
nearby implementations.

## Split by responsibility, not line count

Split a component when doing so creates a clearer responsibility boundary, for
example when it:

- coordinates several independent sections or workflows;
- mixes substantial data/state orchestration with reusable presentation;
- repeats a meaningful UI or interaction pattern;
- contains a section that can be understood and tested independently.

A long cohesive component may remain one file. A short component should not be
split merely to satisfy a size target. Do not introduce container/presenter
layers, registries, factories, or one-use abstractions for visual neatness.

## Reuse before extraction

1. Check `@springbrand/site-block`, `@springbrand/gravel`,
   `@springbrand/message-panel`, and their installed Skills.
2. Keep domain-specific composition local to its feature.
3. Move behavior to an owning `@springbrand/*` package only when that package
   owns the capability or multiple real consumers already need it.
4. When replacing an implementation, migrate callers and remove the obsolete
   path in the same change.

Do not edit `node_modules`, copy a published package implementation into
`web`, or extract a speculative shared component because it might be reused
later.
