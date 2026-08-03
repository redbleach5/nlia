// Mock for the `server-only` package.
//
// The real package throws an error when imported from a Client Component bundle.
// In Vitest we run in a Node environment and want to allow imports of modules
// that start with `import 'server-only'` (db-vec.ts, kb/*.ts, etc.).
//
// This mock is registered via vitest.config.mts → resolve.alias.

export {};
