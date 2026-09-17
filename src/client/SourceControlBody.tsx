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

/** Sum every group's resources. */
function totalOf(status: ScmStatus): number {
  return status.groups.reduce((sum, group) => sum + group.resources.length, 0)
}

/** The codicon shown for one group's twisty. */
function twistyFor(collapsed: boolean): string {
  return collapsed ? 'chevron-right' : 'chevron-down'
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
  // and the share of the body the two sections take.
  const [history, setHistory] = React.useState<ScmHistory | null>(null)
  const [historyFailure, setHistoryFailure] = React.useState('')
  const [historyLoading, setHistoryLoading] = React.useState(true)
  const [historyNow, setHistoryNow] = React.useState(0)
  const [expanded, setExpanded] = React.useState('')
  const [commitFiles, setCommitFiles] = React.useState<Record<string, ScmCommitFile[] | 'loading'>>({})
  const [sections, setSections] = React.useState({ changes: false, graph: false })
  const [ratio, setRatio] = React.useState(0.58)

  const alive = React.useRef(true)
  const sequence = React.useRef(0)
  const historySequence = React.useRef(0)
  const editorRef = React.useRef<HTMLTextAreaElement | null>(null)
  const sectionsRef = React.useRef<HTMLDivElement | null>(null)
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

  const onDividerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const container = sectionsRef.current
    if (container === null) return
    const height = container.getBoundingClientRect().height
    if (height <= 0) return
    drag.current = { startY: event.clientY, startRatio: ratio, height }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onDividerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (current === null) return
    const next = current.startRatio + (event.clientY - current.startY) / current.height
    setRatio(Math.min(0.85, Math.max(0.15, next)))
  }

  const onDividerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

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
        <div className="dsh-scm-toolbar">
          <span className="dsh-scm-toolbar-title">Source Control</span>
          <button type="button" className="dsh-scm-action" title="Refresh" onClick={() => void refresh()}>
            <i className="codicon codicon-refresh" />
          </button>
        </div>
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
  const primaryLabel = merging ? 'Continue' : !hasUpstream ? 'Publish Branch' : needsSync ? 'Sync Changes' : 'Commit'
  const primaryIcon = merging ? 'check' : !hasUpstream ? 'cloud-upload' : needsSync ? 'sync' : 'check'
  const primaryAction = merging ? 'commit' : !hasUpstream ? 'push' : needsSync ? 'pull' : 'commit'
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

  return (
    <div className="dsh-scm" data-scheme={schemeAttribute}>
      <div className="dsh-scm-toolbar">
        <span className="dsh-scm-toolbar-title">Source Control</span>
        <button
          type="button"
          className={`dsh-scm-action${busyNow ? ' dsh-scm-action--spin' : ''}`}
          title="Refresh"
          onClick={() => void refresh()}
        >
          <i className="codicon codicon-refresh" />
        </button>
        <button
          type="button"
          className="dsh-scm-action"
          title="Stage All Changes"
          disabled={total === 0 || busyNow}
          onClick={() => void perform({ action: 'stageAll' })}
        >
          <i className="codicon codicon-add" />
        </button>
        <button
          type="button"
          className="dsh-scm-action"
          title="Unstage All Changes"
          disabled={total === 0 || busyNow}
          onClick={() => void perform({ action: 'unstageAll' })}
        >
          <i className="codicon codicon-remove" />
        </button>
        <button
          type="button"
          className="dsh-scm-action"
          title="Discard All Changes"
          disabled={total === 0 || busyNow}
          onClick={() => confirmDiscard(['.'], ['.'], true)}
        >
          <i className="codicon codicon-discard" />
        </button>
        <MenuAnchor open={menu === 'toolbar'}>
          <button
            type="button"
            className="dsh-scm-action"
            title="More Actions…"
            onClick={() => setMenu(menu === 'toolbar' ? '' : 'toolbar')}
          >
            <i className="codicon codicon-ellipsis" />
          </button>
          {menu === 'toolbar' ? <Menu items={toolbarMenu} onClose={() => setMenu('')} /> : null}
        </MenuAnchor>
      </div>

      <div className="dsh-scm-repository" title={status.root}>
        <i className="codicon codicon-repo" />
        <span className="dsh-scm-repository-name">{status.name}</span>
        <span className="dsh-scm-repository-branch">
          {status.detached ? (
            'detached HEAD'
          ) : (
            <>
              <i className="codicon codicon-git-branch" />
              {status.branch ?? 'HEAD'}
              {status.ahead > 0 ? ` ↑${status.ahead}` : ''}
              {status.behind > 0 ? ` ↓${status.behind}` : ''}
            </>
          )}
        </span>
        <span className="dsh-scm-count">{total}</span>
      </div>

      <div className="dsh-scm-input-row">
        <div className="dsh-scm-editor-wrap">
          <textarea
            ref={editorRef}
            className="dsh-scm-editor"
            value={message}
            spellCheck={false}
            rows={1}
            placeholder={`Message (Ctrl+Enter to commit on "${status.branch ?? 'HEAD'}")`}
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
          title={primaryLabel}
          disabled={primaryAction === 'commit' ? !canCommit : busyNow}
          onClick={runPrimary}
        >
          <i className={`codicon codicon-${busyNow && primaryAction === 'commit' ? 'sync' : primaryIcon}`} />
          {primaryLabel}
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

      <div className="dsh-scm-sections" ref={sectionsRef}>
        <div
          className="dsh-scm-section"
          data-collapsed={sections.changes ? 'true' : undefined}
          style={{ flexGrow: sections.changes ? 0 : ratio, flexBasis: sections.changes ? 'auto' : 0 }}
        >
          <div
            className="dsh-scm-section-header"
            role="button"
            tabIndex={0}
            onClick={() => setSections((current) => ({ ...current, changes: !current.changes }))}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setSections((current) => ({ ...current, changes: !current.changes }))
              }
            }}
          >
            <i className={`codicon codicon-${sections.changes ? 'chevron-right' : 'chevron-down'} dsh-scm-twisty`} />
            <span className="dsh-scm-section-title">Changes</span>
            <span className="dsh-scm-count">{total}</span>
          </div>
          {sections.changes ? null : (
            <div className="dsh-scm-section-body" role="tree">
              {total === 0 ? (
                <div className="dsh-scm-section-state">
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
          )}
        </div>

        {sections.changes || sections.graph ? null : (
          <div
            className="dsh-scm-divider"
            role="separator"
            aria-orientation="horizontal"
            title="Drag to resize"
            onPointerDown={onDividerDown}
            onPointerMove={onDividerMove}
            onPointerUp={onDividerUp}
            onPointerCancel={onDividerUp}
          />
        )}

        <div
          className="dsh-scm-section"
          data-collapsed={sections.graph ? 'true' : undefined}
          style={{ flexGrow: sections.graph ? 0 : 1 - ratio, flexBasis: sections.graph ? 'auto' : 0 }}
        >
          <div
            className="dsh-scm-section-header"
            role="button"
            tabIndex={0}
            onClick={() => setSections((current) => ({ ...current, graph: !current.graph }))}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setSections((current) => ({ ...current, graph: !current.graph }))
              }
            }}
          >
            <i className={`codicon codicon-${sections.graph ? 'chevron-right' : 'chevron-down'} dsh-scm-twisty`} />
            <span className="dsh-scm-section-title">Graph</span>
            <span className="dsh-scm-actions">
              <button
                type="button"
                className="dsh-scm-action"
                title="Refresh Graph"
                onClick={(event) => {
                  event.stopPropagation()
                  void refreshHistory()
                }}
              >
                <i className="codicon codicon-refresh" />
              </button>
            </span>
            <span className="dsh-scm-count">{history === null ? 0 : history.commits.length}</span>
          </div>
          {sections.graph ? null : (
            <div className="dsh-scm-section-body">
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
