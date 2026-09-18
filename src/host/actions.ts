import type { ScmActionRequest, ScmActionResult } from '../shared/protocol.ts'
import { joinPath } from './diff.ts'
import type { GitResult, GitRunner } from './git.ts'
import type { HostFs } from './services.ts'

/** Fold several git invocations into the one report the panel shows. */
function combine(results: readonly GitResult[]): ScmActionResult {
  const failed = results.find((result) => result.exitCode !== 0)
  return {
    ok: failed === undefined,
    command: results.map((result) => result.command).join('\n'),
    output: results
      .map((result) => (result.stdout + result.stderr).trim())
      .filter((text) => text !== '')
      .join('\n')
      .trim(),
  }
}

/** Whether HEAD resolves to a commit, which decides how the index is reset. */
async function hasHead(git: GitRunner, root: string): Promise<boolean> {
  const result = await git.run(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  return result.exitCode === 0
}

/**
 * Clear the index entries for some paths.
 *
 * A repository with no commits has nothing to reset to, so its entries are
 * dropped from the index directly — the same split VS Code's provider makes.
 */
async function unstage(git: GitRunner, root: string, paths: readonly string[]): Promise<GitResult> {
  if (await hasHead(git, root)) return git.run(root, ['reset', '-q', 'HEAD', '--', ...paths])
  return git.run(root, ['rm', '--cached', '-r', '--ignore-unmatch', '--', ...paths])
}

/** Restore tracked paths from the index and remove untracked ones. */
async function discard(
  git: GitRunner,
  root: string,
  tracked: readonly string[],
  untracked: readonly string[],
  recursive: boolean,
): Promise<GitResult[]> {
  const results: GitResult[] = []
  if (tracked.length > 0) results.push(await git.run(root, ['checkout', '-q', '--', ...tracked]))
  if (untracked.length > 0) {
    const flags = recursive ? ['-f', '-d', '-q'] : ['-f', '-q']
    results.push(await git.run(root, ['clean', ...flags, '--', ...untracked]))
  }
  return results
}

/** The checked-out branch and the upstream it tracks. */
interface Branch {
  /** The local branch name, e.g. `main`. */
  name: string
  /** The remote its upstream lives on, e.g. `origin`. */
  remote: string
  /** The branch name on that remote, e.g. `main`. */
  upstream: string
}

/**
 * Read the checked-out branch and its upstream.
 *
 * VS Code has this in its repository state; this half is stateless, so it is read
 * back from the configuration git wrote when the branch started tracking.
 * @param git - the runner.
 * @param root - the working-tree root.
 * @returns the branch, or `undefined` on a detached HEAD or an untracked branch.
 */
async function readBranch(git: GitRunner, root: string): Promise<Branch | undefined> {
  const name = (await git.tryText(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
  if (name === undefined || name === '' || name === 'HEAD') return undefined
  const remote = (await git.tryText(root, ['config', '--get', `branch.${name}.remote`]))?.trim()
  const merge = (await git.tryText(root, ['config', '--get', `branch.${name}.merge`]))?.trim()
  if (remote === undefined || remote === '' || merge === undefined || merge === '') return undefined
  return { name, remote, upstream: merge.replace(/^refs\/heads\//, '') }
}

/** The remote a publish would go to: VS Code asks when there is more than one. */
async function firstRemote(git: GitRunner, root: string): Promise<string | undefined> {
  const listed = (await git.tryText(root, ['remote']))?.split('\n').map((line) => line.trim())
  return listed?.find((line) => line !== '')
}

/**
 * Push the checked-out branch, exactly as VS Code's git extension does it.
 *
 * With an upstream the refspec is spelled out — `git push origin main:main` — so
 * the push does not depend on `push.default`; without one it is a plain
 * `git push`, which is what `git.push` runs and which git refuses, there being
 * no upstream to push to. Publishing is a separate action for that case.
 * @param git - the runner.
 * @param root - the working-tree root.
 * @returns the finished invocation.
 */
async function push(git: GitRunner, root: string): Promise<GitResult> {
  const branch = await readBranch(git, root)
  if (branch === undefined) return git.run(root, ['push'])
  return git.run(root, ['push', branch.remote, `${branch.name}:${branch.upstream}`])
}

/**
 * Publish the checked-out branch: `git push --set-upstream <remote> <branch>`.
 *
 * VS Code's `git.publish` uses the only remote when there is one and asks which
 * one when there are several; a panel has nowhere to ask, so it takes the first
 * and spells the command out either way.
 */
async function publish(git: GitRunner, root: string): Promise<GitResult> {
  const branch = (await git.tryText(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
  const remote = await firstRemote(git, root)
  if (branch === undefined || branch === '' || branch === 'HEAD' || remote === undefined) {
    return git.run(root, ['push'])
  }
  return git.run(root, ['push', '--set-upstream', remote, branch])
}

/** How many commits the branch is ahead of its upstream, or `undefined` if unknown. */
async function aheadOf(git: GitRunner, root: string): Promise<number | undefined> {
  const counted = await git.tryText(root, ['rev-list', '--count', '@{upstream}..HEAD'])
  const count = counted === undefined ? Number.NaN : Number.parseInt(counted.trim(), 10)
  return Number.isNaN(count) ? undefined : count
}

/**
 * VS Code's `git.sync`: pull the upstream, then push the branch if it is ahead.
 *
 * The order and the abort matter. `Repository._sync` pulls first and lets a
 * failed pull throw, so nothing is pushed on top of a merge that did not happen;
 * and it decides whether to push *after* the pull, from the refreshed count, so a
 * branch that was only behind comes back without a pointless push. An unknown
 * count pushes, as `shouldPush` defaults to true there.
 * @param git - the runner.
 * @param root - the working-tree root.
 * @returns the combined outcome of the pull and the push.
 */
async function sync(git: GitRunner, root: string): Promise<ScmActionResult> {
  const branch = await readBranch(git, root)
  // `git.sync` on a branch with no upstream just pushes, which is what VS Code's
  // command does before it ever reaches the pull.
  if (branch === undefined) return combine([await git.run(root, ['push'])])
  const pulled = await git.run(root, ['pull', branch.remote, branch.upstream])
  if (pulled.exitCode !== 0) return combine([pulled])
  if ((await aheadOf(git, root)) === 0) return combine([pulled])
  return combine([pulled, await push(git, root)])
}

/** Pull the upstream, naming it explicitly as VS Code's `git.pull` does. */
async function pull(git: GitRunner, root: string): Promise<GitResult> {
  const branch = await readBranch(git, root)
  return git.run(root, branch === undefined ? ['pull'] : ['pull', branch.remote, branch.upstream])
}

/** Append paths to the repository's `.gitignore`, keeping the existing content. */
async function ignore(
  fs: HostFs,
  root: string,
  paths: readonly string[],
): Promise<ScmActionResult> {
  const target = await fs.resolve(joinPath(root, '.gitignore'))
  let existing = ''
  try {
    existing = await fs.readText(target)
  } catch {
    existing = ''
  }
  const lines = existing.split(/\r?\n/).filter((line) => line !== '')
  const seen = new Set(lines)
  const added = paths.filter((path) => !seen.has(path))
  if (added.length === 0) {
    return { ok: true, command: 'Add to .gitignore', output: 'Already ignored.' }
  }
  await fs.writeText(target, `${[...lines, ...added].join('\n')}\n`)
  return { ok: true, command: 'Add to .gitignore', output: added.join('\n') }
}

/** Run the commit, optionally amending and optionally pushing afterwards. */
async function commit(
  git: GitRunner,
  root: string,
  request: ScmActionRequest,
): Promise<ScmActionResult> {
  const message = request.message ?? ''
  const args = ['-c', 'user.useConfigOnly=true', 'commit', '--quiet']
  if (request.action === 'commitAmend') args.push('--amend')
  if (message.trim() === '') args.push('--allow-empty-message')
  args.push('--file', '-')
  const result = await git.run(root, args, message)
  if (result.exitCode !== 0 || request.action !== 'commitAndPush') return combine([result])
  return combine([result, await push(git, root)])
}

/**
 * Run one Source Control action against a repository.
 * @param git - the runner.
 * @param fs - the filesystem provider, used by the `.gitignore` action.
 * @param root - the absolute working-tree root.
 * @param request - the action and its paths.
 * @returns the combined outcome.
 */
export async function runAction(
  git: GitRunner,
  fs: HostFs,
  root: string,
  request: ScmActionRequest,
): Promise<ScmActionResult> {
  const paths = request.paths ?? []
  switch (request.action) {
    case 'stage':
      return combine([await git.run(root, ['add', '-A', '--', ...paths])])
    case 'unstage':
      return combine([await unstage(git, root, paths)])
    case 'discard':
      return combine(await discard(git, root, paths, request.untracked ?? [], false))
    case 'stageAll':
      return combine([await git.run(root, ['add', '-A', '--', '.'])])
    case 'unstageAll':
      return combine([await unstage(git, root, ['.'])])
    case 'discardAll':
      return combine(await discard(git, root, ['.'], ['.'], true))
    case 'ignore':
      return ignore(fs, root, paths)
    case 'commit':
    case 'commitAmend':
    case 'commitAndPush':
      return commit(git, root, request)
    case 'push':
      return combine([await push(git, root)])
    case 'publish':
      return combine([await publish(git, root)])
    case 'pull':
      return combine([await pull(git, root)])
    case 'sync':
      return sync(git, root)
    case 'fetch':
      return combine([await git.run(root, ['fetch', '--all', '--prune'])])
    default:
      // Unreachable from this build, but reachable from a *newer* panel talking to
      // it: a Host half loaded at boot keeps running until the server restarts, so
      // this is what a client that knows an action the host does not asks for.
      // Answering with a failure rather than falling off the end is the whole
      // point — an action with no case used to return `undefined`, which the route
      // serialised into an empty `200`, and the panel reported that as
      // "The Source Control host returned HTTP 200."
      return {
        ok: false,
        command: `git ${String(request.action)}`,
        output:
          `Unknown Source Control action: ${String(request.action)}. ` +
          'The plugin host half is probably an older build than the panel — restart the server.',
      }
  }
}
