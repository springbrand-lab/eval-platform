# Styling Comment Rules

The filename is retained for migration history. The project normally uses CSS
and Tailwind classes rather than styled-components.

- Comments should explain a constraint, browser behavior, package interaction,
  specificity requirement, or other reason the code cannot express.
- Do not narrate obvious declarations or duplicate component API documentation
  in style files.
- Put component API documentation beside the TypeScript component or public
  package export.
- Backticks are safe in ordinary CSS and TypeScript comments. If a tagged CSS
  template literal is ever used, an unescaped backtick inside the template
  still terminates the JavaScript string and must be escaped or removed.

Do not add a pre-commit hook or blanket backtick restriction for a syntax the
project does not use.
