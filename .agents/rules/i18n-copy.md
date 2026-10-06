# User-Visible Web Copy

Applies to user-visible strings under `web/src/**`.

This project does not currently have an application localization catalog or a
declared set of supported locales. Do not introduce an i18n framework, parallel
translation files, or fallback behavior as part of an unrelated copy change.

When changing copy:

- include labels, placeholders, accessible names, alt text, toasts, errors, and
  both branches of conditional UI;
- keep product and domain terminology consistent with the relevant
  `CONTEXT.md`;
- do not translate wire values, route segments, CSS selectors, log messages, or
  identifiers;
- avoid assembling sentences from fragments when future translation or word
  order would make the result ambiguous.

If localization is explicitly requested, first resolve the supported locales,
fallback locale, URL or preference behavior, and ownership of translations.
Then introduce one catalog source of truth and automated locale-key parity
checks in the same scoped change.
