/**
 * The wire contract between the Host half and the browser half.
 *
 * The two halves are bundled separately (Node ESM and a browser module), so
 * these types are the only shared surface: they are erased at build time and
 * exist to keep both sides honest. Everything here is lossless JSON.
 */

/** A single-letter git decoration letter, matching VS Code's status letters. */
export type ScmCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '!' | 'T'

/** Which SCM resource group a file belongs to. */
export type ScmGroupId = 'merge' | 'index' | 'workingTree' | 'untracked'

/** Which pair of revisions the diff viewer must compare for a file. */
export type ScmDiffKind = 'index' | 'workingTree' | 'untracked' | 'deleted' | 'merge' | 'commit'

/** How untracked files are grouped, mirroring VS Code's `git.untrackedChanges`. */
export type ScmUntrackedMode = 'mixed' | 'separate' | 'hidden'

/** One changed file. */
export interface ScmResource {
  /** Repository-relative path, always with forward slashes. */
  path: string
  /** Last path segment. */
  name: string
  /** Repository-relative directory, empty at the repository root. */
  dir: string
  /** The decoration letter. */
  code: ScmCode
  /** Human-readable status, e.g. `Index Modified`. */
  statusText: string
  /** Whether the row renders struck through (deletions). */
  strikeThrough: boolean
  /** The group this row belongs to. */
  group: ScmGroupId
  /** The comparison the diff viewer must make. */
  diffKind: ScmDiffKind
  /** Whether the file also carries an index-side change, which decides the working-tree diff base. */
  hasIndexChange: boolean
}

/** One collapsible group of changed files. */
export interface ScmGroup {
  id: ScmGroupId
  label: string
  resources: ScmResource[]
}

/** Everything the panel needs for one refresh. */
export interface ScmStatus {
  /** Absolute path of the repository working tree. */
  root: string
  /** Directory name of the repository root. */
  name: string
  /** Current branch, or `null` when HEAD is detached. */
  branch: string | null
  /** Whether HEAD points at a commit rather than a branch. */
  detached: boolean
  /** Whether the repository has no commits yet. */
  unborn: boolean
  /** Upstream ref, when the branch tracks one. */
  upstream: string | null
  /** Commits ahead of upstream. */
  ahead: number
  /** Commits behind upstream. */
  behind: number
  groups: ScmGroup[]
}

/** One side of a file comparison. */
export interface ScmDiffSide {
  /** The revision label shown above the editor. */
  label: string
  /** The file content, or the empty string when the side does not exist. */
  text: string
  /** Whether this side exists at all. */
  exists: boolean
}

/** A resolved file comparison. */
export interface ScmDiff {
  path: string
  name: string
  /** Monaco language id derived from the file extension. */
  language: string
  original: ScmDiffSide
  modified: ScmDiffSide
  /** Both sides are binaries, so no text comparison is offered. */
  binary: boolean
  /** A side exceeded the byte cap and was cut short. */
  truncated: boolean
}

/** The actions the browser half may ask the Host half to run. */
export type ScmActionName =
  | 'stage'
  | 'unstage'
  | 'discard'
  | 'stageAll'
  | 'unstageAll'
  | 'discardAll'
  | 'ignore'
  | 'commit'
  | 'commitAmend'
  | 'commitAndPush'
  | 'push'
  | 'pull'
  | 'fetch'

/** One action request. */
export interface ScmActionRequest {
  /** Absolute path of the session working directory. */
  cwd: string
  action: ScmActionName
  /** Repository-relative paths the action applies to. */
  paths?: string[]
  /** Of those paths, the untracked ones a discard must remove rather than restore. */
  untracked?: string[]
  /** The commit message, for the commit actions. */
  message?: string
}

/** The outcome of one action. */
export interface ScmActionResult {
  ok: boolean
  /** The command that ran, for the panel's output line. */
  command: string
  /** Combined git output, trimmed. */
  output: string
}

/** Every failure this API reports carries this shape. */
export interface ScmFailure {
  error: string
}

/** One reference decorating a commit. */
export interface ScmRef {
  name: string
  /** `head` and the checked-out branch, a local branch, a remote-tracking branch, or a tag. */
  kind: 'head' | 'branch' | 'remote' | 'tag'
}

/** One commit in the repository's history. */
export interface ScmCommit {
  hash: string
  shortHash: string
  /** Parent hashes; more than one makes this a merge commit. */
  parents: string[]
  author: string
  /** Author date, ISO 8601. */
  date: string
  subject: string
  refs: ScmRef[]
}

/** The history the Graph section renders. */
export interface ScmHistory {
  /** Newest first, at most `limit` commits. */
  commits: ScmCommit[]
  /** Commits the branch is behind its upstream: VS Code's "Incoming Changes". */
  incoming: number
  /** Commits the branch is ahead of its upstream: VS Code's "Outgoing Changes". */
  outgoing: number
  /** More commits exist past the requested window. */
  hasMore: boolean
  /** The checked-out commit, which the graph draws as HEAD. */
  head: string | null
  /** The upstream commit, when the branch tracks one. */
  upstreamRevision: string | null
  /** The upstream ref's name, e.g. `origin/main`. */
  upstreamRef: string | null
  /** The common ancestor of HEAD and its upstream, when both exist. */
  mergeBase: string | null
}

/** One file a single commit changed. */
export interface ScmCommitFile {
  path: string
  name: string
  dir: string
  code: ScmCode
  statusText: string
}
