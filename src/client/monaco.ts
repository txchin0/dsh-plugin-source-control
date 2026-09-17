/**
 * Monaco, wired to the worker this plugin serves.
 *
 * The editor core plus every basic language is imported, so files are
 * tokenised without any language-service worker: the only worker a diff needs
 * is the editor worker, and the Host half serves it from the plugin's own
 * route. The theme is rebuilt from the DeepSeek Harness alias tokens so the
 * editor matches the column it is embedded in.
 */
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main.js'
import 'monaco-editor/esm/vs/basic-languages/monaco.contribution.js'
import { ROUTE_PREFIX } from '../shared/routes.ts'

export { monaco }

interface MonacoEnvironmentShape {
  getWorkerUrl?: (moduleId: string, label: string) => string
}

const scope = self as unknown as { MonacoEnvironment?: MonacoEnvironmentShape }
scope.MonacoEnvironment = {
  getWorkerUrl: () => `${ROUTE_PREFIX}/monaco/editor.worker.js`,
}

/** Theme ids already defined, so the palette is read from the page only once. */
const defined = new Set<string>()

/** Read one alias token from the page, falling back when it is not defined. */
function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

/**
 * Define and remember the diff theme for a colour scheme.
 * @param scheme - the active DeepSeek Harness colour scheme.
 * @returns the Monaco theme id to pass to the editor.
 */
export function ensureTheme(scheme: 'light' | 'dark'): string {
  const id = `dsh-source-control-${scheme}`
  if (defined.has(id)) return id
  const dark = scheme === 'dark'
  monaco.editor.defineTheme(id, {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': token('--dsw-alias-bg-base', dark ? '#1b1b1c' : '#ffffff'),
      'editor.foreground': token('--dsw-alias-label-primary', dark ? '#e6e6e6' : '#1f1f1f'),
      'editorGutter.background': token('--dsw-alias-bg-base', dark ? '#1b1b1c' : '#ffffff'),
      'editorLineNumber.foreground': dark ? '#6e7681' : '#999999',
      'editorLineNumber.activeForeground': dark ? '#cccccc' : '#333333',
      'editor.selectionBackground': dark ? '#264f78' : '#add6ff',
      'diffEditor.border': token('--dsw-alias-border-l1', dark ? '#3c3c3c' : '#e5e5e5'),
      'diffEditor.insertedTextBackground': '#9bb95533',
      'diffEditor.removedTextBackground': '#ff000033',
      'diffEditor.insertedLineBackground': '#9bb95526',
      'diffEditor.removedLineBackground': '#ff000026',
      'diffEditorGutter.insertedLineBackground': '#9bb95555',
      'diffEditorGutter.removedLineBackground': '#ff000055',
      'diffEditorOverview.insertedForeground': '#9bb95580',
      'diffEditorOverview.removedForeground': '#ff000080',
      'scrollbarSlider.background': dark ? '#79797966' : '#64646466',
      'scrollbarSlider.hoverBackground': '#646464b3',
      'scrollbarSlider.activeBackground': '#bfbfbf66',
    },
  })
  defined.add(id)
  return id
}
