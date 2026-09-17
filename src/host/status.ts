import type { ScmGroup, ScmGroupId, ScmResource, ScmStatus, ScmUntrackedMode } from '../shared/protocol.ts'
import { findRepositoryRoot, type GitRunner } from './git.ts'

/** Branch facts carried by the `## ` header of `git status --porcelain`. */
export interface BranchInfo {
  branch: string | null
  detached: boolean
  unborn: boolean
  upstream: string | null
  ahead: number
  behind: number
}

/** One raw porcelain entry: the two status letters plus its path. */
export interface RawEntry {
  x: string
  y: string
  path: string
}

/** Conflict letter pairs, with the label VS Code shows for each. */
const CONFLICT_LABELS: Readonly<Record<string, string>> = {
  DD: 'Conflict: Both Deleted',
  AU: 'Conflict: Added By Us',
  UD: 'Conflict: Deleted By Them',
  UA: 'Conflict: Added By Them',
  DU: 'Conflict: Deleted By Us',
  AA: 'Conflict: Both Added',
  UU: 'Conflict: Both Modified',
}

/** Conflicts whose deletion side is rendered struck through. */
const CONFLICT_STRIKE = new Set(['DD', 'UD', 'DU'])

/** Index-side status letter to the decoration letter VS Code shows. */
const INDEX_LETTERS: Readonly<Record<string, ScmResource['code']>> = {
  M: 'M',
  A: 'A',
  D: 'D',
  R: 'R',
  C: 'C',
  T: 'T',
}

/** Index-side status letter to its human-readable status. */
const INDEX_LABELS: Readonly<Record<string, string>> = {
  M: 'Index Modified',
  A: 'Index Added',
  D: 'Index Deleted',
  R: 'Index Renamed',
  C: 'Index Copied',
  T: 'Index Type Changed',
}

/** Working-tree status letter to the decoration letter VS Code shows. */
const WORKTREE_LETTERS: Readonly<Record<string, ScmResource['code']>> = {
  M: 'M',
  A: 'A',
  D: 'D',
  T: 'T',
}

/** Working-tree status letter to its human-readable status. */
const WORKTREE_LABELS: Readonly<Record<string, string>> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  T: 'Type Changed',
}

/** Every group's label and whether an empty group is dropped. */
const GROUP_META: Readonly<Record<ScmGroupId, { label: string; hideWhenEmpty: boolean; order: number }>> = {
  merge: { label: 'Merge Changes', hideWhenEmpty: true, order: 0 },
  index: { label: 'Staged Changes', hideWhenEmpty: true, order: 1 },
  workingTree: { label: 'Changes', hideWhenEmpty: false, order: 2 },
  untracked: { label: 'Untracked Changes', hideWhenEmpty: true, order: 3 },
}

/** Split a repository-relative path into its directory and file name. */
export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? { dir: '', name: path } : { dir: path.slice(0, cut), name: path.slice(cut + 1) }
}

/** Parse the `## ` header line into branch facts. */
export function parseBranchHeader(line: string): BranchInfo {
  const rest = line.startsWith('## ') ? line.slice(3) : line
  if (rest.startsWith('HEAD (no branch)')) {
    return { branch: null, detached: true, unborn: false, upstream: null, ahead: 0, behind: 0 }
  }
  if (rest.startsWith('No commits yet on ')) {
    return {
      branch: rest.slice('No commits yet on '.length).trim(),
      detached: false,
      unborn: true,
      upstream: null,
      ahead: 0,
      behind: 0,
    }
  }
  let names = rest
  let ahead = 0
  let behind = 0
  const bracket = rest.indexOf(' [')
  if (bracket !== -1) {
    const meta = rest.slice(bracket)
    names = rest.slice(0, bracket)
    ahead = Number(/ahead (\d+)/.exec(meta)?.[1] ?? 0)
    behind = Number(/behind (\d+)/.exec(meta)?.[1] ?? 0)
  }
  const separator = names.indexOf('...')
  const branch = (separator === -1 ? names : names.slice(0, separator)).trim()
  const upstream = separator === -1 ? null : names.slice(separator + 3).trim() || null
  return { branch: branch || null, detached: false, unborn: false, upstream, ahead, behind }
}

/**
 * Parse `git status --porcelain=v1 -z` output.
 *
 * Each record is `XY<space>path`; a rename or copy record is followed by the
 * original path as its own NUL-terminated field.
 * @param raw - the raw NUL-separated output.
 * @returns branch facts and one entry per changed path.
 */
export function parsePorcelain(raw: string): { branch: BranchInfo; entries: RawEntry[] } {
  const tokens = raw.split('\0')
  const entries: RawEntry[] = []
  let branch: BranchInfo = {
    branch: null,
    detached: false,
    unborn: false,
    upstream: null,
    ahead: 0,
    behind: 0,
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '') continue
    if (token.startsWith('## ')) {
      branch = parseBranchHeader(token)
      continue
    }
    if (token.length < 3) continue
    const x = token[0]
    const y = token[1]
    const path = token.slice(3)
    entries.push({ x, y, path })
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') index += 1
  }
  return { branch, entries }
}

/**
 * Turn one porcelain entry into the rows the panel shows.
 *
 * A path with changes on both sides yields two rows — one staged, one
 * unstaged — exactly as VS Code lists it.
 * @param entry - the raw porcelain entry.
 * @returns zero or more resources.
 */
export function resourcesFor(entry: RawEntry): ScmResource[] {
  const { x, y, path } = entry
  const { dir, name } = splitPath(path)
  const pair = x + y

  if (CONFLICT_LABELS[pair] !== undefined) {
    return [
      {
        path,
        name,
        dir,
        code: '!',
        statusText: CONFLICT_LABELS[pair],
        strikeThrough: CONFLICT_STRIKE.has(pair),
        group: 'merge',
        diffKind: 'merge',
        hasIndexChange: true,
      },
    ]
  }

  if (pair === '??') {
    return [
      {
        path,
        name,
        dir,
        code: 'U',
        statusText: 'Untracked',
        strikeThrough: false,
        group: 'untracked',
        diffKind: 'untracked',
        hasIndexChange: false,
      },
    ]
  }

  const hasIndexChange = x !== ' ' && x !== '?' && x !== '!'
  const hasWorktreeChange = y !== ' ' && y !== '?' && y !== '!'
  const resources: ScmResource[] = []

  if (hasIndexChange) {
    const letter = INDEX_LETTERS[x]
    if (letter !== undefined) {
      resources.push({
        path,
        name,
        dir,
        code: letter,
        statusText: INDEX_LABELS[x],
        strikeThrough: letter === 'D',
        group: 'index',
        diffKind: letter === 'D' ? 'deleted' : 'index',
        hasIndexChange: true,
      })
    }
  }

  if (hasWorktreeChange) {
    const letter = WORKTREE_LETTERS[y]
    if (letter !== undefined) {
      resources.push({
        path,
        name,
        dir,
        code: letter,
        statusText: WORKTREE_LABELS[y],
        strikeThrough: letter === 'D',
        group: 'workingTree',
        diffKind: letter === 'D' ? 'deleted' : 'workingTree',
        hasIndexChange,
      })
    }
  }

  return resources
}

/** Order rows the way VS Code's list view does by default: by path. */
function byPath(left: ScmResource, right: ScmResource): number {
  return left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * Assemble the panel's groups from raw porcelain output.
 * @param raw - the raw NUL-separated `git status --porcelain=v1 -z` output.
 * @param options - how untracked files are grouped, and paths to omit.
 * @returns the groups in display order, with empty ones dropped.
 */
export function buildGroups(
  raw: string,
  options: { untrackedChanges: ScmUntrackedMode; exclude: readonly string[] },
): { groups: ScmGroup[]; branch: BranchInfo } {
  const { branch, entries } = parsePorcelain(raw)
  const excluded = new Set(options.exclude)
  const buckets = new Map<ScmGroupId, ScmResource[]>()

  for (const entry of entries) {
    for (const resource of resourcesFor(entry)) {
      if (excluded.has(resource.path)) continue
      if (resource.group === 'untracked' && options.untrackedChanges === 'hidden') continue
      const group: ScmGroupId =
        resource.group !== 'untracked' || options.untrackedChanges === 'separate'
          ? resource.group
          : 'workingTree'
      const bucket = buckets.get(group)
      if (bucket === undefined) buckets.set(group, [resource])
      else bucket.push(resource)
    }
  }

  const groups: ScmGroup[] = []
  for (const [id, meta] of Object.entries(GROUP_META) as [ScmGroupId, (typeof GROUP_META)[ScmGroupId]][]) {
    const resources = (buckets.get(id) ?? []).sort(byPath)
    if (resources.length === 0 && meta.hideWhenEmpty) continue
    groups.push({ id, label: meta.label, resources })
  }
  groups.sort((left, right) => GROUP_META[left.id].order - GROUP_META[right.id].order)
  return { groups, branch }
}

/** Options the panel resolves once from plugin config. */
export interface StatusOptions {
  untrackedChanges: ScmUntrackedMode
  exclude: readonly string[]
}

/**
 * Read the repository status for a working directory.
 * @param git - the runner.
 * @param cwd - an absolute directory inside the working tree.
 * @param options - grouping options from plugin config.
 * @returns the status the panel renders.
 */
export async function readStatus(
  git: GitRunner,
  cwd: string,
  options: StatusOptions,
): Promise<ScmStatus> {
  const root = await findRepositoryRoot(git, cwd)
  const raw = await git.text(root, [
    '-c',
    'core.quotepath=false',
    '--no-optional-locks',
    'status',
    '--porcelain=v1',
    '--branch',
    '-z',
    '--untracked-files=all',
  ])
  const { groups, branch } = buildGroups(raw, options)
  const name = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? root
  return {
    root,
    name,
    branch: branch.branch,
    detached: branch.detached,
    unborn: branch.unborn,
    upstream: branch.upstream,
    ahead: branch.ahead,
    behind: branch.behind,
    groups,
  }
}
