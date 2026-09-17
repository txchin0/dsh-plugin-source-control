import { readFileSync } from 'node:fs'
import type {
  ScmActionRequest,
  ScmActionResult,
  ScmCommitFile,
  ScmDiff,
  ScmHistory,
  ScmStatus,
  ScmUntrackedMode,
} from '../shared/protocol.ts'
import { runAction } from './actions.ts'
import { readDiff, type DiffRequest } from './diff.ts'
import { findRepositoryRoot, GitFailure, GitRunner, NotARepository } from './git.ts'
import { DEFAULT_HISTORY_LIMIT, readCommitFiles, readHistory } from './history.ts'
import type { HostFs, HostRequest, HostResponse, HostSubprocess, HostWebServer } from './services.ts'
import { readStatus } from './status.ts'

/** Every route this plugin owns lives under this prefix. */
export const ROUTE_PREFIX = '/source-control'

/** Largest request body accepted, in bytes. */
const BODY_LIMIT = 1024 * 1024

/** Plugin configuration, resolved once at load. */
export interface SourceControlOptions {
  untrackedChanges: ScmUntrackedMode
  exclude: readonly string[]
}

/** The part of the Cordis context this handler needs: optional service lookup. */
export interface RouteHost {
  get(name: string): unknown
}

/** Send a JSON response. */
function sendJson(res: HostResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

/** Collect a request body, refusing anything past the cap. */
function readBody(req: HostRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = []
    let size = 0
    req.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk as Uint8Array)
      size += text.length
      if (size > BODY_LIMIT) {
        reject(new Error('Request body too large.'))
        return
      }
      chunks.push(text)
    })
    req.on('end', () => resolve(chunks.join('')))
    req.on('error', reject)
  })
}

/** Turn any failure into the panel's error line. */
function sendFailure(res: HostResponse, error: unknown): void {
  if (error instanceof NotARepository) {
    sendJson(res, 200, { error: 'not-a-repository' })
    return
  }
  if (error instanceof GitFailure) {
    sendJson(res, 200, { error: error.message })
    return
  }
  sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
}

/**
 * Install the plugin's HTTP surface.
 *
 * Every git read and write reaches the host through this handler: the browser
 * half never touches the filesystem, so repository access stays on the side
 * that owns the execution world.
 * @param host - the Cordis context, used for optional service lookup.
 * @param webServer - the browser HTTP carrier.
 * @param options - grouping options resolved from plugin config.
 * @returns the disposer removing the route.
 */
export function installRoutes(
  host: RouteHost,
  webServer: HostWebServer,
  options: SourceControlOptions,
): () => void {
  let cached: { subprocess: HostSubprocess; git: GitRunner } | undefined
  let worker: Buffer | undefined

  /** The runner for the currently mounted subprocess service. */
  const runner = (): GitRunner => {
    const subprocess = host.get('subprocess') as HostSubprocess | undefined
    if (subprocess === undefined) throw new Error('The subprocess service is not mounted.')
    if (cached?.subprocess !== subprocess) cached = { subprocess, git: new GitRunner(subprocess) }
    return cached.git
  }

  /** The filesystem provider, required to read working-tree files. */
  const filesystem = (): HostFs => {
    const fs = host.get('fs') as HostFs | undefined
    if (fs === undefined) throw new Error('The fs service is not mounted.')
    return fs
  }

  const handle = async (req: HostRequest, res: HostResponse): Promise<void> => {
    const url = new URL(req.url ?? ROUTE_PREFIX, 'http://localhost')
    const path = url.pathname.slice(ROUTE_PREFIX.length) || '/'
    try {
      if (path === '/monaco/editor.worker.js') {
        worker ??= readFileSync(new URL('./monaco-editor.worker.js', import.meta.url))
        res.statusCode = 200
        res.setHeader('content-type', 'text/javascript; charset=utf-8')
        res.setHeader('cache-control', 'public, max-age=31536000, immutable')
        res.end(worker)
        return
      }

      const git = runner()
      const fs = filesystem()

      if (path === '/api/status') {
        const cwd = url.searchParams.get('cwd')
        if (cwd === null || cwd === '') return sendJson(res, 400, { error: 'A working directory is required.' })
        const status: ScmStatus = await readStatus(git, cwd, options)
        return sendJson(res, 200, status)
      }

      if (path === '/api/diff') {
        const cwd = url.searchParams.get('cwd')
        const file = url.searchParams.get('path')
        if (cwd === null || cwd === '') return sendJson(res, 400, { error: 'A working directory is required.' })
        if (file === null || file === '') return sendJson(res, 400, { error: 'A file path is required.' })
        const commit = url.searchParams.get('commit')
        const request: DiffRequest = {
          path: file,
          name: url.searchParams.get('name') ?? file,
          kind: (url.searchParams.get('kind') ?? 'workingTree') as DiffRequest['kind'],
          group: (url.searchParams.get('group') ?? 'workingTree') as DiffRequest['group'],
          hasIndexChange: url.searchParams.get('hasIndexChange') === '1',
          ...(commit === null || commit === '' ? {} : { commit }),
        }
        const root = await findRepositoryRoot(git, cwd)
        const diff: ScmDiff = await readDiff(git, fs, root, request)
        return sendJson(res, 200, diff)
      }

      if (path === '/api/history') {
        const cwd = url.searchParams.get('cwd')
        if (cwd === null || cwd === '') return sendJson(res, 400, { error: 'A working directory is required.' })
        const requested = Number(url.searchParams.get('limit') ?? DEFAULT_HISTORY_LIMIT)
        const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 1000) : DEFAULT_HISTORY_LIMIT
        const status = await readStatus(git, cwd, options)
        const history: ScmHistory = await readHistory(
          git,
          status.root,
          limit,
          status.ahead,
          status.behind,
          status.upstream,
        )
        return sendJson(res, 200, history)
      }

      if (path === '/api/commit') {
        const cwd = url.searchParams.get('cwd')
        const hash = url.searchParams.get('hash')
        if (cwd === null || cwd === '') return sendJson(res, 400, { error: 'A working directory is required.' })
        if (hash === null || hash === '') return sendJson(res, 400, { error: 'A commit hash is required.' })
        const root = await findRepositoryRoot(git, cwd)
        const files: ScmCommitFile[] = await readCommitFiles(git, root, hash)
        return sendJson(res, 200, { files })
      }

      if (path === '/api/action' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as ScmActionRequest
        if (typeof body.cwd !== 'string' || body.cwd === '') {
          return sendJson(res, 400, { error: 'A working directory is required.' })
        }
        const root = await findRepositoryRoot(git, body.cwd)
        const result: ScmActionResult = await runAction(git, fs, root, body)
        return sendJson(res, 200, result)
      }

      sendJson(res, 404, { error: `Unknown source-control route: ${path}` })
    } catch (error) {
      sendFailure(res, error)
    }
  }

  return webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle })
}
