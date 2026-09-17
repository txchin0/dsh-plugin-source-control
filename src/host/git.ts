import type { HostSubprocess } from './services.ts'

/** Cap on collected stdout: a status listing of a very large tree still fits. */
const STDOUT_CAP = 16 * 1024 * 1024
/** Cap on collected stderr: git diagnostics are short. */
const STDERR_CAP = 1024 * 1024
/** Grace between the terminate request and the forced kill. */
const GRACE_MS = 4000

/** One finished git invocation. */
export interface GitResult {
  /** The process exit code, or `null` when a signal ended it. */
  exitCode: number | null
  stdout: string
  stderr: string
  /** The command line, quoted for display in the panel's output line. */
  command: string
}

/** Render one argv element the way a shell would need it written. */
function quote(argument: string): string {
  return /[\s"'\\$`]/.test(argument) ? JSON.stringify(argument) : argument
}

/** `git` failed, with git's own diagnostic as the message. */
export class GitFailure extends Error {}

/** The requested directory is not inside a git working tree. */
export class NotARepository extends Error {}

/**
 * Run git through the subprocess seam.
 *
 * The runner resolves the executable once and reuses it. Every call is a real
 * argv array — no shell is involved, so repository paths never need escaping.
 */
export class GitRunner {
  #executable: string | undefined

  constructor(private readonly subprocess: HostSubprocess) {}

  /** The absolute path of the git executable in this execution world. */
  async executable(): Promise<string> {
    this.#executable ??= await this.subprocess.resolveExecutable('git')
    return this.#executable
  }

  /** Run git and return its raw result, whatever the exit code. */
  async run(cwd: string, args: readonly string[], input?: string): Promise<GitResult> {
    const executable = await this.executable()
    const handle = this.subprocess.spawn({
      argv: [executable, ...args],
      cwd,
      stdio: {
        stdin: input === undefined ? 'ignore' : { data: input },
        stdout: { maxBytes: STDOUT_CAP },
        stderr: { maxBytes: STDERR_CAP },
      },
      graceMs: GRACE_MS,
    })
    const outcome = await handle.done
    return {
      exitCode: outcome.exitCode,
      stdout: handle.collected.stdout?.readFrom(0).text ?? '',
      stderr: handle.collected.stderr?.readFrom(0).text ?? '',
      command: ['git', ...args].map(quote).join(' '),
    }
  }

  /** Run git and reject with git's stderr when it fails. */
  async text(cwd: string, args: readonly string[], input?: string): Promise<string> {
    const result = await this.run(cwd, args, input)
    if (result.exitCode !== 0) {
      throw new GitFailure(result.stderr.trim() || result.command + ' failed')
    }
    return result.stdout
  }

  /** Run git and return stdout, or `undefined` when the command fails. */
  async tryText(cwd: string, args: readonly string[]): Promise<string | undefined> {
    const result = await this.run(cwd, args)
    return result.exitCode === 0 ? result.stdout : undefined
  }
}

/**
 * Resolve the working-tree root for a directory.
 * @param git - the runner.
 * @param cwd - an absolute directory the panel was opened at.
 * @returns the absolute repository root.
 * @throws NotARepository when the directory is not inside a working tree.
 */
export async function findRepositoryRoot(git: GitRunner, cwd: string): Promise<string> {
  const inside = await git.tryText(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside?.trim() !== 'true') throw new NotARepository(cwd)
  const root = await git.tryText(cwd, ['rev-parse', '--show-toplevel'])
  if (root === undefined || root.trim() === '') throw new NotARepository(cwd)
  return root.trim()
}
