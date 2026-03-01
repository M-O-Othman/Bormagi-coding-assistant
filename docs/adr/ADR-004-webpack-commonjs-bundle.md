# ADR-004: webpack CommonJS Bundle for Extension Host

**Date:** 2026-01-15
**Status:** Accepted
**Deciders:** Core team

## Context

VS Code extensions run in the extension host process, which uses Node.js CommonJS (`require()`). Modern npm packages increasingly ship as ESM-only (e.g. `docx`, `p-limit`, `got`). The extension must:

- Ship as a single bundled file for fast activation and easy packaging.
- Work in the extension host's CommonJS module system.
- Handle ESM-only dependencies without breaking the build.

Build tool options: `esbuild`, `webpack`, `tsc` alone, `rollup`.

## Decision

Use **webpack** with `target: 'node'` and `libraryTarget: 'commonjs2'` to bundle all source TypeScript into `dist/extension.js`. Configuration in `webpack.config.js`.

ESM-only packages (`docx`, `pptxgenjs`) are loaded via **dynamic `import()`** at call time rather than at module load time, with `any`-cast to suppress type errors from CJS/ESM interop. This defers the import until the feature is first used, avoiding activation-time failures.

```typescript
// Pattern for ESM-only packages
const docxMod: any = await import('docx');
const { Document, Packer } = docxMod;
```

## Consequences

### Positive
- Single output file (`dist/extension.js`) simplifies `.vsix` packaging.
- Tree-shaking reduces bundle size by excluding unused exports.
- Dynamic imports for ESM packages avoid CJS/ESM interop issues at activation time.
- webpack's `externals: { vscode: 'commonjs vscode' }` correctly excludes the VS Code API from the bundle.

### Negative / Trade-offs
- webpack configuration adds build complexity vs. plain `tsc`.
- Dynamic imports for ESM packages mean the first call to `create_document` / `create_presentation` has a cold-load delay.
- `any`-cast on ESM imports removes type safety for those modules.
- Source maps must be kept for meaningful stack traces (`devtool: 'nosources-source-map'`).

### Neutral
- TypeScript compilation (`tsconfig.json`) targets `ES2020` with `module: commonjs` for webpack compatibility.
- A separate `tsconfig.test.json` targets `ES2020` with `module: commonjs` for Jest + ts-jest.
- `tsconfig.test.json` excludes `src/tests/` from the production build.

## Alternatives Considered

| Alternative | Why Rejected |
|-------------|-------------|
| `tsc` alone (no bundler) | Produces many files; `node_modules` must ship with the `.vsix` (large); no tree-shaking |
| `esbuild` | Faster builds but ESM interop is more complex and less battle-tested for VS Code extensions at time of decision |
| `rollup` | Less ecosystem support for CommonJS output and Node built-ins compared to webpack |
| Native ESM extension host | VS Code extension host does not support ESM as of VS Code 1.85 |
