import type { ScmCode, ScmCommit, ScmCommitFile, ScmHistory, ScmRef } from '../shared/protocol.ts'
import type { GitRunner } from './git.ts'
import { splitPath } from './status.ts'

/** Field separator inside one `git log` record. */
const FIELD = '\u001f'
/** Record separator between `git log` records. */
const RECORD = '\u001e'

/**
 * The `git log` format this module parses.
 *
 * Unit and record separators are used rather than newlines because a commit
 * subject may contain anything a person can type, and this output is split
 * rather than line-read.
 */
const LOG_FORMAT = `%H${FIELD}%h${FIELD}%P${FIELD}%an${FIELD}%aI${FIELD}%D${FIELD}%s${RECORD}`

/** Commit status letter to the decoration letter the graph row shows. */
const COMMIT_LETTERS: Readonly<Record<string, ScmCode>> = {
  M: 'M',
  A: 'A',
  D: 'D',
  T: 'T',
  R: 'R',
  C: 'C',
  U: '!',
}

/** Commit status letter to its human-readable status. */
const COMMIT_LABELS: Readonly<Record<string, string>> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  T: 'Type Changed',
  R: 'Renamed',
  C: 'Copied',
  U: 'Conflict',
}

/**
 * Parse one `%D` decoration list.
 *
 * Git writes `HEAD -> main, origin/main, tag: v1.0`; a detached HEAD is the
 * bare `HEAD`. Names carrying a slash are reported as remote-tracking refs,
 * which is the shape the graph colours differently.
 * @param raw - the decoration field, possibly empty.
 * @returns the refs to render, HEAD first.
 */
export function parseRefs(raw: string): ScmRef[] {
  const refs: ScmRef[] = []
  for (const entry of raw.split(',').map((part) => part.trim()).filter((part) => part !== '')) {
    if (entry.startsWith('HEAD -> ')) {
      refs.push({ name: 'HEAD', kind: 'head' })
      refs.push({ name: entry.slice('HEAD -> '.length), kind: 'branch' })
      continue
    }
    if (entry === 'HEAD') {
      refs.push({ name: 'HEAD', kind: 'head' })
      continue
    }
    if (entry.startsWith('tag: ')) {
      refs.push({ name: entry.slice('tag: '.length), kind: 'tag' })
      continue
    }
    refs.push({ name: entry, kind: entry.includes('/') ? 'remote' : 'branch' })
  }
  return refs
}

/**
 * Parse the `git log` output this module requests.
 *
 * Git terminates every record with a newline *after* the format's own output,
 * so each record but the first arrives with a leading newline; the record is
 * trimmed before it is split, or that newline would ride on the first field and
 * the hash would never compare equal to the parent that named it.
 * @param raw - the raw output.
 * @returns the commits, newest first.
 */
export function parseHistory(raw: string): ScmCommit[] {
  const commits: ScmCommit[] = []
  for (const chunk of raw.split(RECORD)) {
    const record = chunk.trim()
    if (record === '') continue
    const fields = record.split(FIELD)
    if (fields.length < 7) continue
    commits.push({
      hash: fields[0],
      shortHash: fields[1],
      parents: fields[2].split(' ').filter((parent) => parent !== ''),
      author: fields[3],
      date: fields[4],
      refs: parseRefs(fields[5]),
      subject: fields[6].trim(),
    })
  }
  return commits
}

/**
 * Parse `git show --name-status -z` output.
 *
 * Records alternate status and path, and renames are reported as a deletion
 * plus an addition because the command is run with `--no-renames`: each half
 * then opens a diff that resolves cleanly.
 * @param raw - the raw NUL-separated output.
 * @returns one entry per changed file.
 */
export function parseCommitFiles(raw: string): ScmCommitFile[] {
  const fields = raw.split('\u0000').filter((field) => field !== '')
  const files: ScmCommitFile[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index][0]
    const path = fields[index + 1]
    if (path === undefined || path === '') continue
    const { dir, name } = splitPath(path)
    files.push({
      path,
      name,
      dir,
      code: COMMIT_LETTERS[status] ?? 'M',
      statusText: COMMIT_LABELS[status] ?? 'Changed',
    })
  }
  return files
}

/** How many commits the Graph section asks for by default. */
export const DEFAULT_HISTORY_LIMIT = 150

/**
 * Read the repository's recent history for the Graph section.
 * @param git - the runner.
 * @param root - the absolute working-tree root.
 * @param limit - the largest number of commits to return.
 * @param ahead - commits ahead of upstream, from the status read.
 * @param behind - commits behind upstream, from the status read.
 * @param upstream - the upstream ref name, when the branch tracks one.
 * @returns the history, or an empty one for a repository with no commits yet.
 */
export async function readHistory(
  git: GitRunner,
  root: string,
  limit: number,
  ahead: number,
  behind: number,
  upstream: string | null,
): Promise<ScmHistory> {
  // The graph needs the three revisions the swimlane model anchors on: the
  // checked-out commit, its upstream, and their common ancestor.
  const head = (await git.tryText(root, ['rev-parse', '--verify', '--quiet', 'HEAD']))?.trim() ?? null
  let upstreamRevision: string | null = null
  let mergeBase: string | null = null
  if (upstream !== null) {
    upstreamRevision = (await git.tryText(root, ['rev-parse', '--verify', '--quiet', upstream]))?.trim() ?? null
    mergeBase = (await git.tryText(root, ['merge-base', 'HEAD', upstream]))?.trim() ?? null
  }

  const base: ScmHistory = {
    commits: [],
    incoming: behind,
    outgoing: ahead,
    hasMore: false,
    head,
    upstreamRevision,
    upstreamRef: upstream,
    mergeBase,
  }

  // Being behind means the upstream tip is not an ancestor of HEAD, so the
  // upstream has to be named as a second starting point or its commits — and
  // therefore the Incoming Changes row, which anchors on them — never appear.
  const revisions = behind > 0 && upstream !== null ? ['HEAD', upstream] : ['HEAD']
  const result = await git.run(root, [
    'log',
    `--max-count=${limit + 1}`,
    '--date-order',
    `--pretty=format:${LOG_FORMAT}`,
    ...revisions,
  ])
  if (result.exitCode !== 0) {
    // An unborn branch has no history to walk; that is a state, not a failure.
    return base
  }
  const parsed = parseHistory(result.stdout)
  const hasMore = parsed.length > limit
  return { ...base, commits: hasMore ? parsed.slice(0, limit) : parsed, hasMore }
}

/**
 * Read the files one commit changed.
 * @param git - the runner.
 * @param root - the absolute working-tree root.
 * @param hash - the commit to inspect.
 * @returns one entry per changed file.
 */
export async function readCommitFiles(
  git: GitRunner,
  root: string,
  hash: string,
): Promise<ScmCommitFile[]> {
  const result = await git.run(root, [
    '-c',
    'core.quotepath=false',
    'show',
    '--format=',
    '--name-status',
    '-z',
    '--no-renames',
    hash,
  ])
  if (result.exitCode !== 0) return []
  return parseCommitFiles(result.stdout)
}
