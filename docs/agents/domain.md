# Domain Docs

Read `CONTEXT-MAP.md` before changing a package or application, then read the
context document for the affected application. Shared packages define reusable
contracts and capabilities; they do not create additional application
contexts.

```text
/
├── CONTEXT-MAP.md
├── docs/architecture.md
├── docs/eval-sp-deployment.md
├── docs/package-boundaries.md
├── apps/
│   ├── eval-api/CONTEXT.md
│   ├── eval-web/CONTEXT.md
│   └── eval-cli/CONTEXT.md
└── packages/
```

Keep the vocabulary in the context documents stable. Record a new cross-cutting
architectural decision in `docs/architecture.md` before implementing it.
