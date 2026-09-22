# Repository Guidelines

## Project Structure & Module Organization

NestJS collects Bidcenter notices into SQLite through Prisma.

- `src/bidcenter/`: HTTP client, protocol decoding, parsing, and request pacing.
- `src/auth/`: browser login and encrypted sessions; `src/collector/`: scheduling and resumable collection; `src/projects/`: persistence and queries; `src/common/`: database, DTOs, and notifications.
- `public/`: plain JavaScript, HTML, and CSS administration UI.
- `prisma/`: schema and versioned migrations; `test/`: automated tests.
- `scripts/`: operational helpers; `deploy/`: service examples; `docs/`: protocol and verification records.
- `outputs/`: reports; ignored `data/`: runtime files; `src/generated/` and `dist/`: generated code.

## Build, Test, and Development Commands

Use Node.js `>=24.14.0 <25`: run `nvm install` and `nvm use`.

```bash
npm ci                    # Install locked dependencies
npm run setup             # Initialize missing .env, generate Prisma, apply migrations
npm run browser:install   # Install Chromium for browser login
npm run build             # Generate Prisma client and compile TypeScript
npm start                 # Run compiled service at localhost:3100 by default
npm run typecheck         # Check TypeScript without emitting files
npm test                  # Run automated tests
npm run test:http         # Smoke-check an already running local service
npm run db:migrate        # Apply committed database migrations
npm run backup            # Create a consistent SQLite backup
```

Rebuild backend changes before restarting; no watch script exists.

## Coding Style & Naming Conventions

Use two-space indentation, single quotes, and semicolons. TypeScript uses strict checking. Use camelCase for functions and variables, PascalCase for classes, and filenames like `projects.service.ts` or `request-pacer.ts`. No formatter or linter is configured. Never edit generated Prisma files directly.

## Testing Guidelines

Tests use `node:test`, strict assertions, and `tsx`; name files `test/*.test.ts`. Mock website requests and use temporary SQLite databases with cleanup. Add regression coverage for changed parsing, pacing, session recovery, or persistence behavior. No numeric coverage threshold exists. Run tests, typecheck, and build before submitting code changes; use HTTP smoke checks for API changes.

## Commit & Pull Request Guidelines

History uses `feat: ...` and `feat(parser): ...`, with English and Chinese descriptions. Follow this optionally scoped style. PRs should explain behavior changes, validation, related issues, and configuration or migration impact. Include screenshots for UI changes.

## Security & Agent Guidance

Never commit credentials, cookies, `.env`, or `data/`. Preserve request pacing, server cooldowns, manual CAPTCHA handling, and website access limits. Keep unauthenticated administration bound to loopback by default.

For library/API/CLI documentation, use Context7: resolve the library ID, then query the relevant concept. Skip Context7 for general refactoring and business logic.
