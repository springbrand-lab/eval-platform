# Frontend Reachability and Dead Code

Applies to frontend behavior under `web/src/**`.

## Verify the live path before changing behavior

Before fixing or extending an existing component:

1. Search for its importers and public re-exports with `rg`.
2. Walk from the relevant TanStack route or mounted feature to the rendered
   component.
3. Confirm that similarly named files, tests, comments, or types are not being
   mistaken for a live caller.

A file that compiles is not necessarily reachable. If the referenced component
is dead, find and change the live path and report the dead file separately.

## Remove replacements

When a new implementation replaces an old one, migrate the callers and remove
the superseded component, styles, tests, and newly orphaned children in the same
change. Recheck importers immediately before deletion.

Keep an old path only when it still has a real caller or migration need. Mark it
deprecated, name the replacement, and reference a concrete removal condition.

## Out-of-scope dead code

Do not delete unrelated dead code during a focused task. Record it as a cleanup
candidate. Never keep a known-dead replacement silently, because it attracts
future fixes that cannot affect the product.
