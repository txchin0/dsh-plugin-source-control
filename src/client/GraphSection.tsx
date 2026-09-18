import * as React from 'react'
import type { ScmCommit, ScmCommitFile, ScmHistory } from '../shared/protocol.ts'
import {
  HISTORY_ITEM_BASE_REF_COLOR,
  HISTORY_ITEM_REF_COLOR,
  HISTORY_ITEM_REMOTE_REF_COLOR,
  INCOMING_CHANGES_ID,
  OUTGOING_CHANGES_ID,
  renderHistoryItemGraph,
  relativeTime,
  toHistoryItemViewModels,
  type HistoryItem,
  type HistoryItemRef,
  type HistoryItemRefKind,
  type HistoryItemViewModel,
} from './graph.ts'

/** The colour a reference of each kind is drawn in, as VS Code's git extension assigns it. */
function refColor(kind: HistoryItemRefKind | undefined): string {
  if (kind === 'remote') return HISTORY_ITEM_REMOTE_REF_COLOR
  if (kind === 'tag') return HISTORY_ITEM_BASE_REF_COLOR
  return HISTORY_ITEM_REF_COLOR
}

/** The colours a repository's references keep for as long as the graph is shown. */
function buildColorMap(commits: readonly ScmCommit[]): Map<string, string | undefined> {
  const colors = new Map<string, string | undefined>()
  for (const commit of commits) {
    for (const ref of commit.refs) {
      if (!colors.has(ref.name)) colors.set(ref.name, refColor(ref.kind))
    }
  }
  return colors
}

/** The reference the graph treats as the checked-out branch. */
function currentRef(history: ScmHistory): HistoryItemRef | undefined {
  const head = history.commits.find((commit) => commit.hash === history.head)
  const branch = head?.refs.find((ref) => ref.kind === 'branch')
  if (branch === undefined || history.head === null) return undefined
  return { id: branch.name, name: branch.name, revision: history.head, kind: 'branch' }
}

/** The reference the graph treats as the upstream. */
function remoteRef(history: ScmHistory): HistoryItemRef | undefined {
  return history.upstreamRevision === null
    ? undefined
    : {
        id: history.upstreamRef ?? 'upstream',
        name: history.upstreamRef ?? 'upstream',
        revision: history.upstreamRevision,
        kind: 'remote',
      }
}

/**
 * Draw one row's graph gutter.
 *
 * The SVG is built by the ported renderer and owned imperatively, exactly as VS
 * Code's list renderer owns it: React renders the empty host element and never
 * touches its children. The container's class is the original's too — note that
 * a HEAD row is classed `current`, which is the hook the stylesheet uses to fill
 * the node's centre with the row background and so hollow it out.
 * @param viewModel - the laid-out row.
 * @returns the gutter host.
 */
function GraphGutter({ viewModel }: { viewModel: HistoryItemViewModel }): React.ReactElement {
  const host = React.useRef<HTMLSpanElement | null>(null)

  React.useEffect(() => {
    const node = host.current
    if (node === null) return
    node.textContent = ''
    node.appendChild(renderHistoryItemGraph(viewModel))
  }, [viewModel])

  const className =
    viewModel.kind === 'HEAD'
      ? 'current'
      : viewModel.kind === 'node'
        ? ''
        : viewModel.kind

  return <span className={`dsh-scm-graph-container ${className}`.trim()} ref={host} />
}

/** One reference chip beside a commit subject. */
function RefChip({ name, kind }: { name: string; kind: string }): React.ReactElement {
  return (
    <span className="dsh-scm-ref" data-kind={kind}>
      {name}
    </span>
  )
}

/** What the Graph section renders. */
export interface GraphSectionProps {
  history: ScmHistory | null
  /** The instant relative dates are measured against, fixed when history loaded. */
  now: number
  loading: boolean
  failure: string
  /** The hash whose file list is expanded, or the empty string. */
  expanded: string
  /** Changed files per commit, or `'loading'` while they are being read. */
  files: Record<string, ScmCommitFile[] | 'loading'>
  onToggle: (commit: ScmCommit) => void
  onOpenFile: (commit: ScmCommit, file: ScmCommitFile) => void
}

/** The Graph view: the branch history with its swimlanes and references. */
export function GraphSection({
  history,
  now,
  loading,
  failure,
  expanded,
  files,
  onToggle,
  onOpenFile,
}: GraphSectionProps): React.ReactElement {
  const viewModels = React.useMemo(() => {
    if (history === null) return []
    const items: HistoryItem[] = history.commits.map((commit) => ({
      id: commit.hash,
      parentIds: commit.parents,
      subject: commit.subject,
      author: commit.author,
      displayId: commit.shortHash,
      references: commit.refs.map((ref) => ({
        id: ref.name,
        name: ref.name,
        kind: ref.kind,
        revision: commit.hash,
      })),
    }))
    return toHistoryItemViewModels(
      items,
      buildColorMap(history.commits),
      currentRef(history),
      remoteRef(history),
      undefined,
      true,
      true,
      history.mergeBase ?? undefined,
    )
  }, [history])

  if (failure !== '') {
    return (
      <div className="dsh-scm-pane-state">
        <i className="codicon codicon-warning" />
        <span>{failure}</span>
      </div>
    )
  }

  if (history === null) {
    return <div className="dsh-scm-pane-state">{loading ? 'Reading history…' : 'No history.'}</div>
  }

  if (viewModels.length === 0) {
    return (
      <div className="dsh-scm-pane-state">
        <i className="codicon codicon-git-commit" />
        <span>This repository has no commits yet.</span>
      </div>
    )
  }

  /** The commit backing a row, or `undefined` for the synthetic changes rows. */
  const commitOf = (viewModel: HistoryItemViewModel): ScmCommit | undefined =>
    viewModel.kind === 'incoming-changes' || viewModel.kind === 'outgoing-changes'
      ? undefined
      : history.commits.find((commit) => commit.hash === viewModel.historyItem.id)

  return (
    <div className="dsh-scm-graph">
      {viewModels.map((viewModel) => {
        const { historyItem } = viewModel
        const commit = commitOf(viewModel)
        const open = commit !== undefined && expanded === commit.hash
        const listing = commit === undefined ? undefined : files[commit.hash]
        const tooltip =
          commit === undefined
            ? `${historyItem.subject}: ${historyItem.id === INCOMING_CHANGES_ID ? history.incoming : history.outgoing}`
            : [commit.subject, '', `${commit.shortHash} · ${commit.author}`, new Date(commit.date).toLocaleString()].join(
                '\n',
              )

        return (
          <React.Fragment key={historyItem.id}>
            <div
              className="dsh-scm-commit"
              role="treeitem"
              tabIndex={0}
              data-kind={viewModel.kind}
              data-expanded={open ? 'true' : undefined}
              title={tooltip}
              onClick={() => {
                if (commit !== undefined) onToggle(commit)
              }}
              onKeyDown={(event) => {
                if (commit !== undefined && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault()
                  onToggle(commit)
                }
              }}
            >
              <GraphGutter viewModel={viewModel} />
              <span className="dsh-scm-commit-body">
                {commit === undefined ? null : (
                  <i className={`codicon codicon-${open ? 'chevron-down' : 'chevron-right'} dsh-scm-commit-twisty`} />
                )}
                {historyItem.references?.map((ref) => (
                  <RefChip key={ref.id} name={ref.name} kind={ref.kind ?? 'branch'} />
                ))}
                <span className="dsh-scm-commit-subject">{historyItem.subject}</span>
              </span>
              {commit === undefined ? (
                <span className="dsh-scm-count">
                  {historyItem.id === INCOMING_CHANGES_ID ? history.incoming : history.outgoing}
                </span>
              ) : (
                <span className="dsh-scm-commit-date">{relativeTime(commit.date, now)}</span>
              )}
            </div>

            {open && commit !== undefined ? (
              listing === undefined || listing === 'loading' ? (
                <div className="dsh-scm-commit-file dsh-scm-commit-file--state">Reading files…</div>
              ) : listing.length === 0 ? (
                <div className="dsh-scm-commit-file dsh-scm-commit-file--state">No files changed.</div>
              ) : (
                listing.map((file) => (
                  <div
                    key={`${commit.hash}:${file.path}`}
                    className="dsh-scm-row dsh-scm-commit-file"
                    role="treeitem"
                    tabIndex={0}
                    title={`${file.path} • ${file.statusText}`}
                    onClick={() => onOpenFile(commit, file)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onOpenFile(commit, file)
                      }
                    }}
                  >
                    <span className="dsh-scm-commit-file-gutter" />
                    <i className="codicon codicon-file dsh-scm-row-icon" />
                    <span className="dsh-scm-label">
                      <span className="dsh-scm-name">{file.name}</span>
                      {file.dir !== '' ? <span className="dsh-scm-dir">{file.dir}</span> : null}
                    </span>
                    <span className="dsh-scm-badge" data-code={file.code}>
                      {file.code}
                    </span>
                  </div>
                ))
              )
            ) : null}
          </React.Fragment>
        )
      })}

      {history.hasMore ? (
        <div className="dsh-scm-commit-file dsh-scm-commit-file--state">
          Older commits are not loaded.
        </div>
      ) : null}
    </div>
  )
}
