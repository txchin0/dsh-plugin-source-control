import type {
  ScmActionRequest,
  ScmActionResult,
  ScmCommitFile,
  ScmDiff,
  ScmHistory,
  ScmStatus,
} from '../shared/protocol.ts'
import { ROUTE_PREFIX } from '../shared/routes.ts'

/** One file comparison the diff pane asks the Host half to resolve. */
export interface DiffQuery {
  path: string
  name: string
  kind: string
  group: string
  hasIndexChange: boolean
  /** The commit a `commit` comparison is anchored at. */
  commit?: string
}

/** An API failure, carrying the Host half's own machine-readable reason. */
export class SourceControlError extends Error {
  constructor(
    message: string,
    /** The Host half's reason, e.g. `not-a-repository`. */
    readonly reason: string,
  ) {
    super(message)
  }
}

/** Unwrap one JSON response, turning any `error` field into a rejection. */
async function unwrap<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => undefined)) as
    | (T & { error?: string })
    | undefined
  if (body === undefined) {
    // Naming the status alone is useless here: the status is usually 200 and the
    // problem is that there was no JSON body at all, which is what a host half
    // older than this page looks like — it does not know the action being asked
    // for, so it has nothing to answer with.
    throw new SourceControlError(
      `The Source Control host answered HTTP ${response.status} without a JSON body. ` +
        'Its host half is probably an older build than this panel — restart the dsh server.',
      'http',
    )
  }
  if (typeof body.error === 'string') throw new SourceControlError(body.error, body.error)
  if (!response.ok) {
    throw new SourceControlError(`The Source Control host returned HTTP ${response.status}.`, 'http')
  }
  return body as T
}

/** Read the repository status for a working directory. */
export async function fetchStatus(cwd: string): Promise<ScmStatus> {
  const query = new URLSearchParams({ cwd })
  return unwrap<ScmStatus>(await fetch(`${ROUTE_PREFIX}/api/status?${query}`, { headers: { accept: 'application/json' } }))
}

/** Resolve both sides of one file comparison. */
export async function fetchDiff(cwd: string, file: DiffQuery): Promise<ScmDiff> {
  const query = new URLSearchParams({
    cwd,
    path: file.path,
    name: file.name,
    kind: file.kind,
    group: file.group,
    hasIndexChange: file.hasIndexChange ? '1' : '0',
  })
  if (file.commit !== undefined && file.commit !== '') query.set('commit', file.commit)
  return unwrap<ScmDiff>(await fetch(`${ROUTE_PREFIX}/api/diff?${query}`, { headers: { accept: 'application/json' } }))
}

/** Read the repository's recent history for the Graph section. */
export async function fetchHistory(cwd: string): Promise<ScmHistory> {
  const query = new URLSearchParams({ cwd })
  return unwrap<ScmHistory>(await fetch(`${ROUTE_PREFIX}/api/history?${query}`, { headers: { accept: 'application/json' } }))
}

/** Read the files one commit changed. */
export async function fetchCommitFiles(cwd: string, hash: string): Promise<ScmCommitFile[]> {
  const query = new URLSearchParams({ cwd, hash })
  const body = await unwrap<{ files: ScmCommitFile[] }>(
    await fetch(`${ROUTE_PREFIX}/api/commit?${query}`, { headers: { accept: 'application/json' } }),
  )
  return body.files
}

/** Run one Source Control action. */
export async function postAction(request: ScmActionRequest): Promise<ScmActionResult> {
  const response = await fetch(`${ROUTE_PREFIX}/api/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(request),
  })
  return unwrap<ScmActionResult>(response)
}
