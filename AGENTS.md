# Repository guidance

This repository implements a stdio MCP server backed by Pi. Use `README.md` for user-facing setup and tool behavior; use the source and configuration as the authority for current implementation details.

## Boundaries

- Keep `core` independent of features and concrete agent SDKs. Features depend on core contracts; runtimes implement those contracts and stay independent of features. `App` is the composition root that wires implementations together.
- Preserve these boundaries when adding behavior. The import restrictions in `.oxlintrc.json` are executable checks; follow them rather than weakening them to make a dependency compile.
- Across `src` directories, use the `@/` alias. Relative imports stay within the same directory or its descendants.
- Keep shared session and tool behavior in the existing core/features abstractions instead of duplicating it in individual tools or runtime adapters.

## Prompts

- Keep prompts beside the code that consumes them. Maintain the distinction between host-facing tool descriptions and Pi-facing review instructions or quality criteria.
- When changing a prompt, check its reader and how it is assembled before editing; the prompt is part of runtime behavior, not general documentation.

## Documentation

- Keep `README.md` focused on current behavior, configuration, usage, and operating requirements. Do not add implementation narratives or change history; put task history and verification in the delivery or an explicitly requested changelog.

## Validation

Inspect `package.json` for the current validation scripts. Run the relevant tests and checks for the changed behavior; include the build when changes affect runtime loading, imports, or packaging. Follow the existing test patterns under `__tests__/`.
