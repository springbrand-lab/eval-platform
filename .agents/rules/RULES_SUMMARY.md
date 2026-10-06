# Project Rules Summary

This is the sole catalog for project rules referenced by the root `AGENTS.md`.
Rule files are not automatically path-scoped, so the agent must route work
through this index before proposing, planning, editing, reviewing, or advising.

1. Identify every row whose scope matches the requested or discovered work.
2. Read each matching rule file in full before deciding on the change.
3. Apply all matching rules; one task may activate several.
4. If no row matches, continue with the root `AGENTS.md` and relevant project
   documentation.

| Rule | Read when |
| --- | --- |
| `api-error-handling.md` | Changing API errors, HTTP clients, domain error translation, authentication failures, or request logging |
| `api-interface-implementation.md` | Adding or changing an API business interface from Model through Web SDK |
| `component-decomposition.md` | Creating or restructuring React components |
| `component-library.md` | Adding or changing Web UI controls or layouts |
| `styled-component.md` | Changing Web styling, tokens, responsive behavior, or themes |
| `styled-component-comments.md` | Commenting styling code or tagged CSS templates |
| `react-data-test-id.md` | Adding selectors or changing React component tests |
| `i18n-copy.md` | Adding or changing user-visible Web copy |
| `frontend-no-em-dashes.md` | Adding or changing user-visible Web copy |
| `layout-foundations.md` | Changing viewport, scrolling, responsive layout, or floating surfaces |
| `frontend-dead-code.md` | Fixing or replacing an existing frontend component |
| `cc-web-lander-boundary.md` | Moving behavior across workspaces or package boundaries |
| `database-schema-migrations.md` | Changing API business tables, Drizzle schema, or migrations |

The root `AGENTS.md`, relevant context documents, ADRs, and installed Dune
React package Skills remain authoritative. If a rule conflicts with an owned
package contract or an ADR, follow the owner and surface the conflict instead
of creating a local workaround.
