# Contributing to Local Log Viewer

Thanks for your interest in contributing.

## Development Setup

1. Install dependencies.
2. Build the extension.
3. Run tests.

```bash
npm install
npm run compile
npm test
```

For continuous compilation:

```bash
npm run watch
```

## How to Contribute

1. Fork the repository and create a feature branch.
2. Keep changes focused and avoid unrelated refactors.
3. Add or update tests when behavior changes.
4. Update documentation when needed.
5. Open a pull request with a clear description.

## Pull Request Checklist

- Code compiles with `npm run compile`.
- Tests pass with `npm test`.
- User-facing text is in English.
- Security-sensitive changes are explained in the PR.

## Code Style

- TypeScript with strict settings.
- Keep code minimal and readable.
- Prefer explicit naming and small functions.

## Reporting Issues

When opening an issue, include:

- OS and VS Code version.
- Extension version.
- Reproduction steps.
- Expected and actual behavior.
- Sample logs (without secrets).
