/**
 * Type shims for the Monaco deep imports.
 *
 * The package ships one `.d.ts` for its public entry, while this plugin imports
 * the leaner editor-core entry (no TypeScript/JSON/CSS/HTML language services,
 * which would each demand their own worker) plus the tokeniser-only basic
 * languages. Both re-export the same public API, so the shim routes the types
 * there.
 */
declare module 'monaco-editor/esm/vs/editor/edcore.main.js' {
  export * from 'monaco-editor'
}

declare module 'monaco-editor/esm/vs/basic-languages/monaco.contribution.js' {
  const contribution: void
  export default contribution
}

declare module 'monaco-editor/esm/vs/editor/editor.worker.js' {
  const worker: void
  export default worker
}
