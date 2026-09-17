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

/** Push, publishing the branch on its first push when it has no upstream yet. */
async function push(git: GitRunner, root: string): Promise<GitResult> {
  const first = await git.run(root, ['push'])
  if (first.exitCode === 0) return first
  const branch = (await git.tryText(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
  const remote = (await git.tryText(root, ['remote']))?.split('\n')[0]?.trim()
  if (branch === undefined || branch === '' || branch === 'HEAD' || remote === undefined || remote === '') {
    return first
  }
  const published = await git.run(root, ['push', '--set-upstream', remote, branch])
  return published.exitCode === 0 ? published : first
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
    case 'pull':
      return combine([await git.run(root, ['pull'])])
    case 'fetch':
      return combine([await git.run(root, ['fetch', '--all', '--prune'])])
  }
}
