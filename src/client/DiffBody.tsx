import * as React from 'react'
import type { ScmDiff } from '../shared/protocol.ts'
import type { DiffNavigation } from '../shared/routes.ts'
import { fetchDiff, SourceControlError } from './api.ts'
import { ensureTheme, monaco } from './monaco.ts'

/** The session snapshot the panel reads its working directory from. */
interface SessionSnapshot {
  byId: Record<string, { cwd?: string } | undefined>
}

/** Everything the seat hands the diff body. */
export interface DiffBodyProps {
  useTabInfo: () => {
    tab: { visible: boolean; navigation?: { params?: Partial<DiffNavigation>; revision?: number } }
  }
  sessionId: string
  useSessions: (selector: (sessions: SessionSnapshot) => unknown) => unknown
  useColorScheme: () => 'light' | 'dark'
}

/** The editor options the diff shares with VS Code's own diff editors. */
const EDITOR_OPTIONS: monaco.editor.IStandaloneDiffEditorConstructionOptions = {
  readOnly: true,
  originalEditable: false,
  renderSideBySide: true,
  useInlineViewWhenSpaceIsLimited: false,
  automaticLayout: true,
  // VS Code's diff overview: two 15px lanes down the right edge of the pane,
  // the removed one left of the inserted one, with the viewport drawn over
  // both. It is what says *where* in the file the changes are once the file is
  // longer than the pane — the ruler mirrors the whole document, so a change
  // below the fold is visible without scrolling to it. The lanes take their
  // colours from `diffEditorOverview.insertedForeground` /
  // `diffEditorOverview.removedForeground` and the viewport slider from the
  // `scrollbarSlider.*` pair, all of which `monaco.ts` already defines.
  renderOverviewRuler: true,
  renderIndicators: true,
  ignoreTrimWhitespace: false,
  scrollBeyondLastLine: false,
  minimap: { enabled: false },
  fontSize: 12,
  lineHeight: 18,
  fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, alwaysConsumeMouseWheel: false },
  renderLineHighlight: 'none',
  wordWrap: 'off',
  diffWordWrap: 'off',
}

/** The diff pane: a read-only Monaco diff of one changed file. */
/**
 * Run one teardown step, swallowing its failure.
 *
 * Disposal runs while React is unmounting this subtree, so an exception thrown
 * here escapes into the slot runtime and takes the whole column down with it —
 * which is exactly what a viewer is not entitled to do. A failed step is
 * reported and skipped instead.
 * @param step - the teardown step to attempt.
 */
function release(step: () => void): void {
  try {
    step()
  } catch (error) {
    console.error('[source-control] teardown step failed', error)
  }
}

export function DiffBody(props: DiffBodyProps): React.ReactElement {
  const { useTabInfo, sessionId, useSessions, useColorScheme } = props
  const tabInfo = useTabInfo()
  const params = tabInfo.tab?.navigation?.params
  const revision = tabInfo.tab?.navigation?.revision ?? 0
  const cwd = useSessions((sessions) => sessions.byId[sessionId]?.cwd) as string | undefined
  const scheme = useColorScheme()

  const path = params?.path ?? ''
  const kind = params?.kind ?? 'workingTree'
  const group = params?.group ?? 'workingTree'
  const hasIndexChange = params?.hasIndexChange === true
  const commit = params?.commit ?? ''

  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const editorRef = React.useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const modelsRef = React.useRef<{
    original: monaco.editor.ITextModel
    modified: monaco.editor.ITextModel
  } | null>(null)
  const [diff, setDiff] = React.useState<ScmDiff | null>(null)
  const [failure, setFailure] = React.useState('')
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    if (cwd === undefined || path === '') {
      setLoading(false)
      return undefined
    }
    let cancelled = false
    setLoading(true)
    setFailure('')
    fetchDiff(cwd, {
      path,
      name: params?.name ?? path,
      kind,
      group,
      hasIndexChange,
      ...(commit === '' ? {} : { commit }),
    })
      .then((value) => {
        if (cancelled) return
        setDiff(value)
        setLoading(false)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setDiff(null)
        setLoading(false)
        setFailure(
          error instanceof SourceControlError && error.reason === 'not-a-repository'
            ? 'This folder is not a Git repository.'
            : error instanceof Error
              ? error.message
              : String(error),
        )
      })
    return () => {
      cancelled = true
    }
  }, [cwd, path, kind, group, hasIndexChange, commit, revision])

  // The editor owns everything it holds, so it is created and disposed by one
  // effect. React runs an effect's cleanup before the cleanups of the effects
  // declared after it, so keeping the models out of a later effect is what
  // guarantees this editor is never asked to do anything after `dispose()`.
  React.useEffect(() => {
    const node = containerRef.current
    if (node === null) return undefined
    const editor = monaco.editor.createDiffEditor(node, { ...EDITOR_OPTIONS, theme: ensureTheme(scheme) })
    editorRef.current = editor
    return () => {
      editorRef.current = null
      release(() => editor.dispose())
      release(() => modelsRef.current?.original.dispose())
      release(() => modelsRef.current?.modified.dispose())
      modelsRef.current = null
    }
    // The editor is created once; the effects below keep it in step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    if (editorRef.current !== null) release(() => monaco.editor.setTheme(ensureTheme(scheme)))
  }, [scheme])

  // Swapping the compared documents carries no cleanup of its own: the pair
  // this run replaces is dropped here, and whatever is left when the pane
  // unmounts is dropped by the editor effect above.
  React.useEffect(() => {
    const editor = editorRef.current
    if (editor === null || diff === null) return
    const previous = modelsRef.current
    const original = monaco.editor.createModel(diff.original.text, diff.language)
    const modified = monaco.editor.createModel(diff.modified.text, diff.language)
    modelsRef.current = { original, modified }
    release(() => editor.setModel({ original, modified }))
    if (previous !== null) {
      release(() => previous.original.dispose())
      release(() => previous.modified.dispose())
    }
  }, [diff])

  const name = path === '' ? 'Diff' : (path.split('/').pop() ?? path)
  const comparison = diff === null ? '' : `${diff.original.label} ↔ ${diff.modified.label}`

  return (
    <div className="dsh-scm-diff">
      <div className="dsh-scm-diff-header">
        <i className="codicon codicon-diff" />
        <span className="dsh-scm-diff-title">{name}</span>
        <span className="dsh-scm-diff-paths">
          {failure !== ''
            ? failure
            : loading
              ? `${comparison === '' ? '' : `${comparison} • `}loading…`
              : `${comparison} • ${path}`}
        </span>
      </div>
      {diff !== null && (diff.binary || diff.truncated) ? (
        <div className="dsh-scm-diff-state">
          <i className={`codicon codicon-${diff.binary ? 'file-binary' : 'warning'}`} />
          <span>
            {diff.binary
              ? 'This file is binary, so no text comparison is available.'
              : 'This file is too large and was truncated before comparison.'}
          </span>
        </div>
      ) : null}
      <div
        className="dsh-scm-diff-editor"
        ref={containerRef}
        style={diff !== null && (diff.binary || diff.truncated) ? { display: 'none' } : undefined}
      />
    </div>
  )
}
