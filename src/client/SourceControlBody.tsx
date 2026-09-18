import * as React from 'react'
import type { ScmActionRequest, ScmCommit, ScmCommitFile, ScmGroup, ScmHistory, ScmResource, ScmStatus } from '../shared/protocol.ts'
import type { DiffNavigation } from '../shared/routes.ts'
import { fetchCommitFiles, fetchHistory, fetchStatus, postAction, SourceControlError } from './api.ts'
import { GraphSection } from './GraphSection.tsx'
import { Menu, MenuAnchor, type MenuItem } from './Menu.tsx'

/** The session snapshot the file explorer also reads its root from. */
interface SessionSnapshot {
  byId: Record<string, { cwd?: string } | undefined>
}

/** The tab information the seat injects. */
interface TabInformation {
  panel?: { id: string }
  tab?: { id: string; visible: boolean }
}

/** What the panel asks the plugin to open when a file is clicked. */
export interface OpenDiffRequest extends DiffNavigation {
  sessionId: string
  paneId: string
  tabId: string
}

/** Everything the seat hands the panel body. */
export interface SourceControlBodyProps {
  useTabInfo: () => TabInformation
  sessionId: string
  useSessions: (selector: (sessions: SessionSnapshot) => unknown) => unknown
  openDiff: (request: OpenDiffRequest) => void
  useColorScheme: () => 'light' | 'dark'
}

/** One pending confirmation. */
interface Confirmation {
  title: string
  body: string
  label: string
  run: () => void
}

/** How often the panel re-reads the repository while it is on screen. */
const POLL_MS = 4000

/**
 * One pane header's height, in pixels.
 *
 * `DEFAULT_PANE_HEADER_SIZE` in VS Code's `paneview.ts`; the stylesheet's
 * `--pane-header-size` is kept in sync with it there, and so is `.dsh-scm`'s.
 * A collapsed pane is pinned to exactly this size — that is the whole of VS
 * Code's collapse mechanism (see `paneStyle`).
 */
const PANE_HEADER = 22

/** `Pane`'s default `minimumBodySize` for a vertical pane, in pixels. */
const PANE_MIN_BODY = 120

/**
 * The share of the pane view the Changes pane takes before it is first dragged.
 *
 * VS Code lays a fresh container out from the view descriptors' `weight`s —
 * Changes is 40 and Graph is 40 (`scm.contribution.ts`) — so the two panes start
 * at half the column each.
 */
const INITIAL_RATIO = 0.5

/** Which pane a fold applies to. */
type PaneId = 'changes' | 'graph'

/**
 * The flex box one pane needs to reproduce VS Code's split-view sizing.
 *
 * VS Code sizes panes in pixels and expresses a collapsed pane as a *range*
 * rather than a flag: `minimumSize === maximumSize === headerSize`
 * (`Pane.minimumSize`/`maximumSize` in `paneview.ts`). That single equality is
 * what pins the pane to its header, stops it absorbing the space its neighbour
 * gave up, and pushes the freed space onto the pane above or below it —
 * `distributeEmptySpace` walks the panes from the bottom up, so an expanded
 * neighbour grows and a collapsed one is left at 22px.
 *
 * `flex-grow` proportional to the panes' stored shares reproduces the expanded
 * half of that exactly, and it reproduces the collapse for free: with only one
 * growable pane left, that pane takes every freed pixel and the collapsed one
 * ends up last — at the bottom of the column.
 *
 * The shares are divided by the expanded panes' total before they reach
 * `flex-grow`, and that is not cosmetic: CSS distributes only `sum(flex-grow)` of
 * the free space when that sum is *below one*, so a lone growable pane left at
 * `0.5` would take half the column and strand the rest as a blank gap under the
 * collapsed header — the exact symptom this port was written to remove.
 * @param share - the pane's share of the two panes' combined size.
 * @param expanded - whether the pane is expanded.
 * @param total - the shares of the expanded panes, added up.
 * @returns the inline style for the pane element.
 */
function paneStyle(share: number, expanded: boolean, total: number): React.CSSProperties {
  return expanded
    ? {
        flexGrow: total > 0 ? share / total : 1,
        flexShrink: 1,
        flexBasis: 0,
        minHeight: PANE_HEADER + PANE_MIN_BODY,
      }
    : { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', minHeight: PANE_HEADER, maxHeight: PANE_HEADER }
}

/** Sum every group's resources. */
function totalOf(status: ScmStatus): number {
  return status.groups.reduce((sum, group) => sum + group.resources.length, 0)
}

/** The codicon shown for one group's twisty. */
function twistyFor(collapsed: boolean): string {
  return collapsed ? 'chevron-right' : 'chevron-down'
}

/**
 * One pane header, as VS Code's `.pane-header` behaves.
 *
 * The twisty is a chevron which the stylesheet nudges down a pixel while the
 * pane is expanded; the title is uppercased by the stylesheet; and the actions
 * are revealed by the *pane's* hover, never by the header's own — VS Code shows
 * them only while the pane is expanded, which is what `data-expanded` is for.
 * Enter and Space toggle, Left collapses and Right expands, exactly as
 * `PaneView`'s header keydown handlers do.
 */
function PaneHeader({
  title,
  expanded,
  onToggle,
  children,
}: {
  title: string
  expanded: boolean
  onToggle: () => void
  children?: React.ReactNode
}): React.ReactElement {
  return (
    <div
      className="dsh-scm-pane-header"
      data-expanded={expanded ? 'true' : 'false'}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={`${title} Section`}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onToggle()
        } else if (event.key === 'ArrowLeft' && expanded) {
          event.preventDefault()
          onToggle()
        } else if (event.key === 'ArrowRight' && !expanded) {
          event.preventDefault()
          onToggle()
        }
      }}
    >
      <i className={`codicon codicon-${expanded ? 'chevron-down' : 'chevron-right'}`} />
      <h3 className="dsh-scm-pane-title">{title}</h3>
      <span className="dsh-scm-actions">{children}</span>
    </div>
  )
}

/** One file row. */
function ResourceRow({
  resource,
  selected,
  busy,
  onOpen,
  onStage,
  onUnstage,
  onDiscard,
  onIgnore,
}: {
  resource: ScmResource
  selected: boolean
  busy: boolean
  onOpen: () => void
  onStage: () => void
  onUnstage: () => void
  onDiscard: () => void
  onIgnore: () => void
}): React.ReactElement {
  const staged = resource.group === 'index'
  return (
    <div
      className="dsh-scm-row"
      role="treeitem"
      tabIndex={0}
      data-selected={selected ? 'true' : undefined}
      data-strike={resource.strikeThrough ? 'true' : undefined}
      title={`${resource.path} • ${resource.statusText}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      <i className="codicon codicon-file dsh-scm-row-icon" />
      <span className="dsh-scm-label">
        <span className="dsh-scm-name">{resource.name}</span>
        {resource.dir !== '' ? <span className="dsh-scm-dir">{resource.dir}</span> : null}
      </span>
      <span className="dsh-scm-actions">
        <button
          type="button"
          className="dsh-scm-action"
          title="Open Changes"
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation()
            onOpen()
          }}
        >
          <i className="codicon codicon-compare-changes" />
        </button>
        {staged || resource.group === 'merge' ? null : (
          <button
            type="button"
            className="dsh-scm-action"
            title="Discard Changes"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation()
              onDiscard()
            }}
          >
            <i className="codicon codicon-discard" />
          </button>
        )}
        {resource.group === 'untracked' ? (
          <button
            type="button"
            className="dsh-scm-action"
            title="Add to .gitignore"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation()
              onIgnore()
            }}
          >
            <i className="codicon codicon-circle-slash" />
          </button>
        ) : null}
        {staged ? (
          <button
            type="button"
            className="dsh-scm-action"
            title="Unstage Changes"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation()
              onUnstage()
            }}
          >
            <i className="codicon codicon-remove" />
          </button>
        ) : (
          <button
            type="button"
            className="dsh-scm-action"
            title="Stage Changes"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation()
              onStage()
            }}
          >
            <i className="codicon codicon-add" />
          </button>
        )}
      </span>
      <span className="dsh-scm-badge" data-code={resource.code} data-staged={staged ? 'true' : undefined}>
        {resource.code}
      </span>
    </div>
  )
}

/** One collapsible group of file rows. */
function GroupSection({
  group,
  collapsed,
  selected,
  busy,
  onToggle,
  onOpen,
  onStage,
  onUnstage,
  onDiscard,
  onIgnore,
  onGroupStage,
  onGroupUnstage,
  onGroupDiscard,
}: {
  group: ScmGroup
  collapsed: boolean
  selected: string
  busy: boolean
  onToggle: () => void
  onOpen: (resource: ScmResource) => void
  onStage: (resource: ScmResource) => void
  onUnstage: (resource: ScmResource) => void
  onDiscard: (resource: ScmResource) => void
  onIgnore: (resource: ScmResource) => void
  onGroupStage: () => void
  onGroupUnstage: () => void
  onGroupDiscard: () => void
}): React.ReactElement {
  const staged = group.id === 'index'
  return (
    <div className="dsh-scm-group">
      <div className="dsh-scm-group-header" role="treeitem" onClick={onToggle}>
        <i className={`codicon codicon-${twistyFor(collapsed)} dsh-scm-twisty`} />
        <span className="dsh-scm-group-name">{group.label}</span>
        <span className="dsh-scm-actions">
          {group.id === 'workingTree' || group.id === 'untracked' ? (
            <button
              type="button"
              className="dsh-scm-action"
              title="Discard All Changes"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation()
                onGroupDiscard()
              }}
            >
              <i className="codicon codicon-discard" />
            </button>
          ) : null}
          {staged ? (
            <button
              type="button"
              className="dsh-scm-action"
              title="Unstage All Changes"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation()
                onGroupUnstage()
              }}
            >
              <i className="codicon codicon-remove" />
            </button>
          ) : (
            <button
              type="button"
              className="dsh-scm-action"
              title="Stage All Changes"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation()
                onGroupStage()
              }}
            >
              <i className="codicon codicon-add" />
            </button>
          )}
        </span>
        <span className="dsh-scm-count">{group.resources.length}</span>
      </div>
      {collapsed
        ? null
        : group.resources.map((resource) => (
            <ResourceRow
              key={`${group.id}:${resource.path}`}
              resource={resource}
              selected={selected === resource.path}
              busy={busy}
              onOpen={() => onOpen(resource)}
              onStage={() => onStage(resource)}
              onUnstage={() => onUnstage(resource)}
              onDiscard={() => onDiscard(resource)}
              onIgnore={() => onIgnore(resource)}
            />
          ))}
    </div>
  )
}

/** The Source Control panel: repository, commit box, and the changed files. */
export function SourceControlBody(props: SourceControlBodyProps): React.ReactElement {
  const { useTabInfo, sessionId, useSessions, openDiff, useColorScheme } = props
  const tabInfo = useTabInfo()
  const paneId = tabInfo.panel?.id ?? ''
  const tabId = tabInfo.tab?.id ?? ''
  const visible = tabInfo.tab?.visible !== false
  const cwd = useSessions((sessions) => sessions.byId[sessionId]?.cwd) as string | undefined
  const scheme = useColorScheme()

  const [status, setStatus] = React.useState<ScmStatus | null>(null)
  const [failure, setFailure] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [message, setMessage] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [output, setOutput] = React.useState<{ text: string; error: boolean } | null>(null)
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({})
  const [selected, setSelected] = React.useState('')
  const [menu, setMenu] = React.useState('')
  const [confirming, setConfirming] = React.useState<Confirmation | null>(null)

  // The Graph view's own state: its history, the files of an expanded commit,
  // and the share of the pane view each of the two panes takes.
  const [history, setHistory] = React.useState<ScmHistory | null>(null)
  const [historyFailure, setHistoryFailure] = React.useState('')
  const [historyLoading, setHistoryLoading] = React.useState(true)
  const [historyNow, setHistoryNow] = React.useState(0)
  const [expanded, setExpanded] = React.useState('')
  const [commitFiles, setCommitFiles] = React.useState<Record<string, ScmCommitFile[] | 'loading'>>({})
  // Folding is per pane and never touches `ratio`: VS Code remembers the pixel
  // size a pane had before it was collapsed and restores it on expand, so a
  // split the user dragged is still there afterwards.
  const [folded, setFolded] = React.useState<Record<PaneId, boolean>>({ changes: false, graph: false })
  const [ratio, setRatio] = React.useState(INITIAL_RATIO)

  const alive = React.useRef(true)
  const sequence = React.useRef(0)
  const historySequence = React.useRef(0)
  const editorRef = React.useRef<HTMLTextAreaElement | null>(null)
  const panesRef = React.useRef<HTMLDivElement | null>(null)
  const drag = React.useRef<{ startY: number; startRatio: number; height: number } | null>(null)

  React.useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refresh = React.useCallback(async (): Promise<void> => {
    if (cwd === undefined) {
      setLoading(false)
      return
    }
    const mine = (sequence.current += 1)
    try {
      const next = await fetchStatus(cwd)
      if (!alive.current || sequence.current !== mine) return
      setStatus(next)
      setFailure('')
    } catch (error) {
      if (!alive.current || sequence.current !== mine) return
      setStatus(null)
      setFailure(
        error instanceof SourceControlError && error.reason === 'not-a-repository'
          ? 'This folder is not a Git repository.'
          : error instanceof Error
            ? error.message
            : String(error),
      )
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [cwd])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const refreshHistory = React.useCallback(async (): Promise<void> => {
    if (cwd === undefined) {
      setHistoryLoading(false)
      return
    }
    const mine = (historySequence.current += 1)
    try {
      const next = await fetchHistory(cwd)
      if (!alive.current || historySequence.current !== mine) return
      setHistory(next)
      setHistoryNow(Date.now())
      setHistoryFailure('')
    } catch (error) {
      if (!alive.current || historySequence.current !== mine) return
      setHistory(null)
      setHistoryFailure(
        error instanceof SourceControlError && error.reason === 'not-a-repository'
          ? 'This folder is not a Git repository.'
          : error instanceof Error
            ? error.message
            : String(error),
      )
    } finally {
      if (alive.current) setHistoryLoading(false)
    }
  }, [cwd])

  // History is read on mount and after every action, never on the status poll:
  // a commit list is stable between writes, and walking it every few seconds
  // would spend real work on an answer that has not changed.
  React.useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  React.useEffect(() => {
    if (!visible) return undefined
    const handle = setInterval(() => {
      void refresh()
    }, POLL_MS)
    return () => clearInterval(handle)
  }, [refresh, visible])

  React.useEffect(() => {
    const node = editorRef.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(204, Math.max(24, node.scrollHeight))}px`
  }, [message])

  const perform = React.useCallback(
    async (request: Omit<ScmActionRequest, 'cwd'>): Promise<boolean> => {
      if (cwd === undefined) return false
      setBusy(request.action)
      setMenu('')
      try {
        const result = await postAction({ cwd, ...request })
        if (alive.current) {
          setOutput({
            text: [result.command, result.output].filter((part) => part !== '').join('\n'),
            error: !result.ok,
          })
        }
        if (result.ok && (request.action === 'commit' || request.action === 'commitAmend' || request.action === 'commitAndPush')) {
          if (alive.current) setMessage('')
        }
        return result.ok
      } catch (error) {
        if (alive.current) {
          setOutput({ text: error instanceof Error ? error.message : String(error), error: true })
        }
        return false
      } finally {
        if (alive.current) setBusy('')
        await refresh()
        // A write can add or move commits, so the Graph follows every action.
        await refreshHistory()
      }
    },
    [cwd, refresh, refreshHistory],
  )

  const open = React.useCallback(
    (resource: ScmResource): void => {
      setSelected(resource.path)
      openDiff({
        sessionId,
        paneId,
        tabId,
        path: resource.path,
        name: resource.name,
        kind: resource.diffKind,
        group: resource.group,
        hasIndexChange: resource.hasIndexChange,
      })
    },
    [openDiff, paneId, sessionId, tabId],
  )

  const toggleCommit = React.useCallback(
    (commit: ScmCommit): void => {
      setExpanded((current) => (current === commit.hash ? '' : commit.hash))
      if (cwd === undefined || commitFiles[commit.hash] !== undefined) return
      setCommitFiles((current) => ({ ...current, [commit.hash]: 'loading' }))
      void fetchCommitFiles(cwd, commit.hash)
        .then((files) => {
          if (alive.current) setCommitFiles((current) => ({ ...current, [commit.hash]: files }))
        })
        .catch(() => {
          if (alive.current) setCommitFiles((current) => ({ ...current, [commit.hash]: [] }))
        })
    },
    [commitFiles, cwd],
  )

  const openCommitFile = React.useCallback(
    (commit: ScmCommit, file: ScmCommitFile): void => {
      setSelected(file.path)
      openDiff({
        sessionId,
        paneId,
        tabId,
        path: file.path,
        name: file.name,
        kind: 'commit',
        group: 'index',
        hasIndexChange: false,
        commit: commit.hash,
      })
    },
    [openDiff, paneId, sessionId, tabId],
  )

  /** Fold or unfold one pane. The other pane takes the space either way. */
  const togglePane = React.useCallback((pane: PaneId): void => {
    setFolded((current) => ({ ...current, [pane]: !current[pane] }))
  }, [])

  /**
   * Start a sash drag.
   *
   * The sash takes no room of its own — VS Code floats it over the boundary —
   * so the two panes' sizes add up to the container's height and the ratio is
   * all that has to be remembered.
   */
  const onSashDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const container = panesRef.current
    if (container === null) return
    const height = container.getBoundingClientRect().height
    if (height <= 0) return
    drag.current = { startY: event.clientY, startRatio: ratio, height }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // A pointer the browser does not consider active cannot be captured; the
      // drag still works, it just does not survive leaving the element.
    }
  }

  /**
   * Drag the boundary: the pane above the sash grows, the one below shrinks,
   * and each stops at its minimum — `header + minimumBodySize`, which is
   * `SplitView.resize`'s clamp. Below two minimums the column scrolls, as VS
   * Code's split view does.
   */
  const onSashMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (current === null) return
    const wanted = current.startRatio * current.height + (event.clientY - current.startY)
    const least = PANE_HEADER + PANE_MIN_BODY
    const most = Math.max(least, current.height - least)
    setRatio(Math.min(most, Math.max(least, wanted)) / current.height)
  }

  const onSashUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    drag.current = null
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // Releasing a capture that was never taken is not worth a word.
    }
  }

  /** Double-clicking the sash gives the two panes half the column each. */
  const onSashReset = (): void => setRatio(INITIAL_RATIO)

  const confirmDiscard = React.useCallback(
    (paths: string[], untracked: string[], all: boolean): void => {
      setConfirming({
        title: 'Discard Changes',
        body: all
          ? 'All tracked modifications will be reverted, and untracked files and folders will be deleted. This cannot be undone.'
          : `Changes to ${paths.length === 1 ? paths[0] : `${paths.length} files`} will be discarded. This cannot be undone.`,
        label: 'Discard',
        run: () => {
          void perform({ action: all ? 'discardAll' : 'discard', paths, untracked })
        },
      })
    },
    [perform],
  )

  const schemeAttribute = scheme === 'light' ? 'light' : 'dark'
  const total = status === null ? 0 : totalOf(status)
  const busyNow = busy !== ''

  if (cwd === undefined) {
    return (
      <div className="dsh-scm" data-scheme={schemeAttribute}>
        <div className="dsh-scm-state">
          <i className="codicon codicon-source-control" />
          <span>Open a session with a working directory to see its changes.</span>
        </div>
      </div>
    )
  }

  if (failure !== '') {
    return (
      <div className="dsh-scm" data-scheme={schemeAttribute}>
        <div className="dsh-scm-state">
          <i className="codicon codicon-warning" />
          <span>{failure}</span>
        </div>
      </div>
    )
  }

  if (status === null) {
    return (
      <div className="dsh-scm" data-scheme={schemeAttribute}>
        <div className="dsh-scm-state">
          <span>{loading ? 'Reading repository…' : 'No repository status.'}</span>
        </div>
      </div>
    )
  }

  const merging = status.groups.some((group) => group.id === 'merge' && group.resources.length > 0)
  const hasUpstream = status.upstream !== null
  const needsSync = status.ahead > 0 || status.behind > 0
  // The labels and their order are git's action button, verbatim: Continue while
  // a merge is in progress, Publish Branch while the branch has no upstream,
  // Sync Changes while it is ahead or behind, and Commit otherwise — each with
  // the icon git puts in the same place (`extensions/git/src/actionButton.ts`,
  // `postCommitCommands.ts`).
  const primaryLabel = merging ? 'Continue' : !hasUpstream ? 'Publish Branch' : needsSync ? 'Sync Changes' : 'Commit'
  const primaryIcon = merging ? 'check' : !hasUpstream ? 'cloud-upload' : needsSync ? 'sync' : 'check'
  const primaryAction = merging ? 'commit' : !hasUpstream ? 'push' : needsSync ? 'pull' : 'commit'
  const branch = status.branch ?? ''
  // git's tooltips: the commit one names the branch, the sync one counts what it
  // would move, and a detached HEAD drops the branch clause.
  const primaryTitle = merging
    ? 'Continue Merge'
    : !hasUpstream
      ? branch === ''
        ? 'Publish Branch'
        : `Publish Branch "${branch}"`
      : needsSync
        ? `${status.behind > 0 ? `Pull ${status.behind}` : ''}${status.behind > 0 && status.ahead > 0 ? ' and ' : ''}${status.ahead > 0 ? `push ${status.ahead}` : ''} commit${status.behind + status.ahead === 1 ? '' : 's'}`
        : branch === ''
          ? 'Commit Changes'
          : `Commit Changes on "${branch}"`
  const canCommit = total > 0 && !busyNow

  const toolbarMenu: MenuItem[] = [
    { id: 'fetch', label: 'Fetch', icon: 'cloud-download', run: () => void perform({ action: 'fetch' }) },
    { id: 'pull', label: 'Pull', icon: 'arrow-down', run: () => void perform({ action: 'pull' }) },
    { id: 'push', label: 'Push', icon: 'arrow-up', run: () => void perform({ action: 'push' }) },
    {
      id: 'collapse',
      label: 'Collapse All',
      icon: 'collapse-all',
      separatorBefore: true,
      run: () => setCollapsed(Object.fromEntries(status.groups.map((group) => [group.id, true]))),
    },
    {
      id: 'expand',
      label: 'Expand All',
      icon: 'expand-all',
      run: () => setCollapsed({}),
    },
    {
      id: 'stage-all',
      label: 'Stage All Changes',
      icon: 'add',
      separatorBefore: true,
      disabled: total === 0 || busyNow,
      run: () => void perform({ action: 'stageAll' }),
    },
    {
      id: 'unstage-all',
      label: 'Unstage All Changes',
      icon: 'remove',
      disabled: total === 0 || busyNow,
      run: () => void perform({ action: 'unstageAll' }),
    },
    {
      id: 'discard-all',
      label: 'Discard All Changes',
      icon: 'discard',
      disabled: total === 0 || busyNow,
      run: () => confirmDiscard(['.'], ['.'], true),
    },
  ]

  const commitMenu: MenuItem[] = [
    { id: 'commit', label: 'Commit', icon: 'check', disabled: !canCommit, run: () => void perform({ action: 'commit', message }) },
    {
      id: 'amend',
      label: 'Commit (Amend)',
      icon: 'check',
      disabled: busyNow || status.unborn,
      run: () => void perform({ action: 'commitAmend', message }),
    },
    {
      id: 'commit-push',
      label: 'Commit & Push',
      icon: 'arrow-up',
      separatorBefore: true,
      disabled: !canCommit,
      run: () => void perform({ action: 'commitAndPush', message }),
    },
  ]

  const runPrimary = (): void => {
    if (primaryAction === 'commit') void perform({ action: 'commit', message })
    else if (primaryAction === 'push') void perform({ action: 'push' })
    else void perform({ action: 'pull' })
  }

  // What the expanded panes' shares add up to, which is what `flex-grow` has to
  // be normalised against — see `paneStyle`. A folded pane contributes nothing,
  // so the pane left standing takes the column on its own.
  const expandedShare = (folded.changes ? 0 : ratio) + (folded.graph ? 0 : 1 - ratio)

  return (
    <div className="dsh-scm" data-scheme={schemeAttribute}>
      <div className="dsh-scm-panes" ref={panesRef}>
        {/*
          Two panes, exactly as VS Code's SCM view container holds them: the
          Changes view (the commit box, its button, and the resource groups) and
          the Graph below it. Each carries its own header — which is where VS
          Code puts the view's actions, and why the panel has no toolbar of its
          own: the container's title area is the tab strip above this body, and
          VS Code contributes no actions to it for Source Control.
        */}
        <div
          className="dsh-scm-pane"
          data-view="changes"
          data-expanded={folded.changes ? 'false' : 'true'}
          style={paneStyle(ratio, !folded.changes, expandedShare)}
        >
          <PaneHeader title="Changes" expanded={!folded.changes} onToggle={() => togglePane('changes')}>
            <button
              type="button"
              className={`dsh-scm-action${busyNow ? ' dsh-scm-action--spin' : ''}`}
              title="Refresh"
              onClick={(event) => {
                event.stopPropagation()
                void refresh()
              }}
            >
              <i className="codicon codicon-refresh" />
            </button>
            <MenuAnchor open={menu === 'toolbar'}>
              <button
                type="button"
                className="dsh-scm-action"
                title="More Actions…"
                onClick={(event) => {
                  event.stopPropagation()
                  setMenu(menu === 'toolbar' ? '' : 'toolbar')
                }}
              >
                <i className="codicon codicon-ellipsis" />
              </button>
              {menu === 'toolbar' ? <Menu items={toolbarMenu} onClose={() => setMenu('')} /> : null}
            </MenuAnchor>
          </PaneHeader>

          {folded.changes ? null : (
            <div className="dsh-scm-pane-body">
              <div className="dsh-scm-pane-scroll">
                <div className="dsh-scm-input-row">
                  <div className="dsh-scm-editor-wrap">
                    <textarea
                      ref={editorRef}
                      className="dsh-scm-editor"
                      value={message}
                      spellCheck={false}
                      rows={1}
                      /* git's placeholder: the branch clause goes away on a
                       * detached HEAD, exactly as `repository.ts` drops it. */
                      placeholder={
                        branch === ''
                          ? 'Message (Ctrl+Enter to commit)'
                          : `Message (Ctrl+Enter to commit on "${branch}")`
                      }
                      aria-label="Source Control Input"
                      onChange={(event) => setMessage(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                          event.preventDefault()
                          void perform({ action: 'commit', message })
                        }
                      }}
                    />
                  </div>
                </div>

                <div className="dsh-scm-button-row">
                  <button
                    type="button"
                    className={`dsh-scm-button${merging || !hasUpstream || needsSync ? ' dsh-scm-button--solo' : ''}`}
                    title={primaryTitle}
                    disabled={primaryAction === 'commit' ? !canCommit : busyNow}
                    onClick={runPrimary}
                  >
                    <i className={`codicon codicon-${busyNow && primaryAction === 'commit' ? 'sync' : primaryIcon}`} />
                    {primaryLabel}
                    {/* git's short label: the counts ride on the button, behind
                     * first, so the branch row VS Code does not draw is not
                     * needed to see them. */}
                    {needsSync ? (
                      <span className="dsh-scm-button-counts">
                        {status.behind > 0 ? (
                          <span className="dsh-scm-button-count">
                            {status.behind}
                            <i className="codicon codicon-arrow-down" />
                          </span>
                        ) : null}
                        {status.ahead > 0 ? (
                          <span className="dsh-scm-button-count">
                            {status.ahead}
                            <i className="codicon codicon-arrow-up" />
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </button>
                  {merging || !hasUpstream || needsSync ? null : (
                    <MenuAnchor open={menu === 'commit'}>
                      <button
                        type="button"
                        className="dsh-scm-button-dropdown"
                        title="More Actions…"
                        onClick={() => setMenu(menu === 'commit' ? '' : 'commit')}
                      >
                        <i className="codicon codicon-chevron-down" />
                      </button>
                      {menu === 'commit' ? <Menu items={commitMenu} onClose={() => setMenu('')} /> : null}
                    </MenuAnchor>
                  )}
                </div>

                {output !== null ? (
                  <div className="dsh-scm-output" data-error={output.error ? 'true' : undefined}>
                    {output.text}
                  </div>
                ) : null}

                <div className="dsh-scm-groups" role="tree">
                  {total === 0 ? (
                    <div className="dsh-scm-pane-state">
                      <i className="codicon codicon-check" />
                      <span>No changes. Your working tree is clean.</span>
                    </div>
                  ) : (
                    status.groups.map((group) => (
                      <GroupSection
                        key={group.id}
                        group={group}
                        collapsed={collapsed[group.id] === true}
                        selected={selected}
                        busy={busyNow}
                        onToggle={() => setCollapsed((current) => ({ ...current, [group.id]: current[group.id] !== true }))}
                        onOpen={open}
                        onStage={(resource) => void perform({ action: 'stage', paths: [resource.path] })}
                        onUnstage={(resource) => void perform({ action: 'unstage', paths: [resource.path] })}
                        onDiscard={(resource) =>
                          confirmDiscard(
                            resource.group === 'untracked' ? [] : [resource.path],
                            resource.group === 'untracked' ? [resource.path] : [],
                            false,
                          )
                        }
                        onIgnore={(resource) => void perform({ action: 'ignore', paths: [resource.path] })}
                        onGroupStage={() => void perform({ action: 'stage', paths: group.resources.map((r) => r.path) })}
                        onGroupUnstage={() => void perform({ action: 'unstage', paths: group.resources.map((r) => r.path) })}
                        onGroupDiscard={() =>
                          confirmDiscard(
                            group.resources.filter((r) => r.group !== 'untracked').map((r) => r.path),
                            group.resources.filter((r) => r.group === 'untracked').map((r) => r.path),
                            false,
                          )
                        }
                      />
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/*
          The sash takes no layout room at all: VS Code floats it over the
          boundary between two panes (`.sash-container` is `position: absolute`),
          so the panes' sizes still add up to the column. It is inert — and so
          invisible, since it paints nothing at rest — as soon as either
          neighbour is collapsed, which is what `SashState.Disabled` means there.
        */}
        <div
          className="dsh-scm-sash"
          data-disabled={folded.changes || folded.graph ? 'true' : undefined}
          onPointerDown={onSashDown}
          onPointerMove={onSashMove}
          onPointerUp={onSashUp}
          onPointerCancel={onSashUp}
          onDoubleClick={onSashReset}
        >
          <div className="dsh-scm-sash-handle" role="separator" aria-orientation="horizontal" title="Drag to resize" />
        </div>

        <div
          className="dsh-scm-pane"
          data-view="graph"
          data-expanded={folded.graph ? 'false' : 'true'}
          style={paneStyle(1 - ratio, !folded.graph, expandedShare)}
        >
          <PaneHeader title="Graph" expanded={!folded.graph} onToggle={() => togglePane('graph')}>
            <button
              type="button"
              className={`dsh-scm-action${historyLoading ? ' dsh-scm-action--spin' : ''}`}
              title="Refresh"
              onClick={(event) => {
                event.stopPropagation()
                void refreshHistory()
              }}
            >
              <i className="codicon codicon-refresh" />
            </button>
          </PaneHeader>

          {folded.graph ? null : (
            <div className="dsh-scm-pane-body">
              <div className="dsh-scm-pane-scroll">
                <GraphSection
                  history={history}
                  now={historyNow}
                  loading={historyLoading}
                  failure={historyFailure}
                  expanded={expanded}
                  files={commitFiles}
                  onToggle={toggleCommit}
                  onOpenFile={openCommitFile}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {confirming !== null ? (
        <div className="dsh-scm-scrim" onClick={() => setConfirming(null)}>
          <div
            className="dsh-scm-confirm"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="dsh-scm-confirm-title">{confirming.title}</p>
            <p className="dsh-scm-confirm-body">{confirming.body}</p>
            <div className="dsh-scm-confirm-actions">
              <button type="button" className="dsh-scm-confirm-button" onClick={() => setConfirming(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="dsh-scm-confirm-button dsh-scm-confirm-button--danger"
                onClick={() => {
                  const action = confirming.run
                  setConfirming(null)
                  action()
                }}
              >
                {confirming.label}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
