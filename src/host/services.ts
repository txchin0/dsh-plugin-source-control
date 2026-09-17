/**
 * Structural views of the Host services this plugin consumes.
 *
 * The plugin declares only what it calls, so it needs no runtime import from
 * the packages that provide these seams and stays installable on its own. Each
 * interface mirrors the published contract of the service with the same name.
 */

/** One managed child process's collected output reader. */
export interface HostOutputReader {
  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean }
}

/** A live managed child process. */
export interface HostSubprocessHandle {
  readonly collected: {
    readonly stdout?: HostOutputReader
    readonly stderr?: HostOutputReader
  }
  readonly done: Promise<{ exitCode: number | null }>
  terminate(): void
}

/** The fully-specified spawn request. */
export interface HostSubprocessSpawnSpec {
  argv: readonly string[]
  cwd: string
  stdio: {
    stdin: 'ignore' | 'pipe' | { readonly data: string }
    stdout: 'pipe' | 'inherit' | { maxBytes: number }
    stderr: 'pipe' | 'inherit' | { maxBytes: number }
  }
  graceMs: number
  signal?: AbortSignal
  env?: Record<string, string | undefined>
}

/** `ctx.subprocess`: argv-based process execution. */
export interface HostSubprocess {
  resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string>
  spawn(spec: HostSubprocessSpawnSpec): HostSubprocessHandle
}

/** A resolved filesystem target. */
export interface HostFsTarget {
  targetKey: string
  displayPath: string
}

/** `ctx.fs`: the filesystem provider seam. */
export interface HostFs {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<HostFsTarget>
  stat(target: HostFsTarget, signal?: AbortSignal): Promise<{ type: string } | undefined>
  readText(target: HostFsTarget, signal?: AbortSignal): Promise<string>
  writeText(
    target: HostFsTarget,
    content: string,
    expected?: unknown,
    signal?: AbortSignal,
    policy?: unknown,
  ): Promise<unknown>
}

/** One HTTP route owned by this plugin. */
export interface HostWebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: HostRequest, res: HostResponse) => void | Promise<void>
}

/** The subset of Node's `IncomingMessage` this plugin reads. */
export interface HostRequest {
  url?: string
  method?: string
  on(event: 'data', listener: (chunk: unknown) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
}

/** The subset of Node's `ServerResponse` this plugin writes. */
export interface HostResponse {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string | Uint8Array): void
}

/** `ctx.webServer`: the browser HTTP carrier. */
export interface HostWebServer {
  register(route: HostWebRoute): () => void
}
