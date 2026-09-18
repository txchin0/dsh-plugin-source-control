/**
 * Action-layer checks for the Host half.
 *
 * Most of `src/host/actions.ts` is argv assembly, and the interesting part of it
 * is *which* commands run, in what order, for a given repository state — git's
 * actions come in pairs (a sync is a pull and then a push; a publish is a push
 * that sets the upstream) and getting the pair wrong is invisible in the panel
 * until someone notices the branch never moved. So this file has two halves:
 *
 *   - a recorder: a fake runner that captures argv, used to pin the sequences
 *     and the branches between them (a failed pull must not be pushed on top of);
 *   - a fixture: a throwaway repository with a bare remote, where the same
 *     actions run against real git and the *effect* is checked — the commit
 *     reaches the remote, the upstream gets set.
 *
 * Run with `pnpm test`; the module is bundled on the fly so the test reads the
 * same source the Host half does.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = path.join(here, '..', 'src', 'host', 'actions.ts')
const stage = await mkdtemp(path.join(tmpdir(), 'scm-actions-'))
const bundled = path.join(stage, 'actions.cjs')
await build({
  entryPoints: [source],
  outfile: bundled,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  logLevel: 'error',
})
const { runAction } = await import(pathToFileURL(bundled).href)

/** A filesystem stub: the `.gitignore` action is the only caller. */
const noFs = {
  resolve: async (target) => target,
  readText: async () => '',
  writeText: async () => {},
}

/**
 * A runner that records every invocation and answers from a script.
 *
 * `answers` is a list of `{ match, result }`; the first whose `match` is a prefix
 * of the argv wins, so a test only has to describe the commands it cares about.
 */
function recorder(answers = []) {
  const calls = []
  const runner = {
    calls,
    /** The argv of every call, as a readable command line. */
    get commands() {
      return calls.map((args) => args.join(' '))
    },
    async run(cwd, args, input) {
      calls.push(args)
      const answer = answers.find(({ match }) => match.every((part, index) => args[index] === part))
      const result = answer?.result ?? { exitCode: 0, stdout: '', stderr: '' }
      return { stdout: '', stderr: '', exitCode: 0, command: args.join(' '), input, ...result }
    },
    async tryText(cwd, args) {
      const result = await this.run(cwd, args)
      return result.exitCode === 0 ? result.stdout : undefined
    },
  }
  return runner
}

/** What `readBranch` reads back for a branch that tracks `origin/main`. */
const TRACKS_MAIN = [
  { match: ['rev-parse', '--abbrev-ref', 'HEAD'], result: { exitCode: 0, stdout: 'main\n' } },
  { match: ['config', '--get', 'branch.main.remote'], result: { exitCode: 0, stdout: 'origin\n' } },
  { match: ['config', '--get', 'branch.main.merge'], result: { exitCode: 0, stdout: 'refs/heads/main\n' } },
]

const cases = []
const test = (name, run) => cases.push({ name, run })

/**
 * The commands that change something, in order.
 *
 * Everything but the reads: an action opens by asking git where it is — a
 * `rev-parse`, a `config --get`, a `rev-list` — and the assertions here are about
 * what it then does, and in which order. (The commit line starts with
 * `-c user.useConfigOnly=true`, so the subcommand is not the first word.)
 */
const effects = (git) =>
  git.commands.filter(
    (command) => !/^(-c\s+\S+\s+)?(rev-parse|config|rev-list|symbolic-ref|status|remote|version)\b/.test(command),
  )

test('a sync pulls the upstream and then pushes the branch', async () => {
  const git = recorder([
    ...TRACKS_MAIN,
    { match: ['rev-list', '--count'], result: { exitCode: 0, stdout: '1\n' } },
  ])
  const result = await runAction(git, noFs, '/repo', { cwd: '/repo', action: 'sync' })
  assert.deepEqual(effects(git), ['pull origin main', 'push origin main:main'])
  assert.equal(result.ok, true)
})

test('a sync that leaves the branch in step does not push', async () => {
  const git = recorder([
    ...TRACKS_MAIN,
    { match: ['rev-list', '--count'], result: { exitCode: 0, stdout: '0\n' } },
  ])
  await runAction(git, noFs, '/repo', { cwd: '/repo', action: 'sync' })
  assert.deepEqual(effects(git), ['pull origin main'])
})

test('a sync whose pull fails stops there', async () => {
  // VS Code lets the failed pull throw out of `Repository._sync`, so the push
  // never runs — pushing after a pull that did not happen is how a branch gets
  // published on top of a conflict.
  const git = recorder([
    ...TRACKS_MAIN,
    { match: ['pull'], result: { exitCode: 1, stderr: 'CONFLICT' } },
  ])
  const result = await runAction(git, noFs, '/repo', { cwd: '/repo', action: 'sync' })
  assert.deepEqual(effects(git), ['pull origin main'])
  assert.equal(result.ok, false)
  assert.match(result.output, /CONFLICT/)
})

test('a sync with no upstream just pushes, as git.sync does', async () => {
  const git = recorder([{ match: ['rev-parse', '--abbrev-ref', 'HEAD'], result: { exitCode: 0, stdout: 'main\n' } }])
  await runAction(git, noFs, '/repo', { cwd: '/repo', action: 'sync' })
  assert.deepEqual(effects(git), ['push'])
})

test('a sync whose ahead count is unknown pushes anyway', async () => {
  // `shouldPush` in `Repository._sync` falls back to true when the count is not
  // a number, and a push that is not needed is a no-op.
  const git = recorder([...TRACKS_MAIN, { match: ['rev-list', '--count'], result: { exitCode: 128 } }])
  await runAction(git, noFs, '/repo', { cwd: '/repo', action: 'sync' })
  assert.deepEqual(effects(git), ['pull origin main', 'push origin main:main'])
})

test('a push names the refspec, and falls back to a plain push without an upstream', async () => {
  const tracking = recorder(TRACKS_MAIN)
  await runAction(tracking, noFs, '/repo', { cwd: '/repo', action: 'push' })
  assert.deepEqual(effects(tracking), ['push origin main:main'])

  const orphan = recorder([
    { match: ['rev-parse', '--abbrev-ref', 'HEAD'], result: { exitCode: 0, stdout: 'main\n' } },
  ])
  await runAction(orphan, noFs, '/repo', { cwd: '/repo', action: 'push' })
  assert.deepEqual(effects(orphan), ['push'])
})

test('a publish sets the upstream instead of trying a bare push first', async () => {
  const git = recorder([
    { match: ['rev-parse', '--abbrev-ref', 'HEAD'], result: { exitCode: 0, stdout: 'feature\n' } },
    { match: ['remote'], result: { exitCode: 0, stdout: 'origin\n' } },
  ])
  await runAction(git, noFs, '/repo', { cwd: '/repo', action: 'publish' })
  assert.deepEqual(effects(git), ['push --set-upstream origin feature'])
})

test('a pull names the upstream it is merging from', async () => {
  const git = recorder(TRACKS_MAIN)
  await runAction(git, noFs, '/repo', { cwd: '/repo', action: 'pull' })
  assert.deepEqual(effects(git), ['pull origin main'])
})

test('commit and push runs both, in that order', async () => {
  const git = recorder([...TRACKS_MAIN, { match: ['commit'], result: { exitCode: 0 } }])
  await runAction(git, noFs, '/repo', { cwd: '/repo', action: 'commitAndPush', message: 'work' })
  const commands = effects(git)
  assert.equal(commands.length, 2)
  assert.match(commands[0], /\bcommit\b/)
  assert.equal(commands[1], 'push origin main:main')
})

test('an action this build does not know fails, and names itself', async () => {
  // The Host half is loaded at boot and the panel is not, so a newer panel can ask
  // for an action this build has never heard of. Falling off the switch returned
  // `undefined`, which the route serialised into an empty 200 the panel could only
  // report as "The Source Control host returned HTTP 200."
  const git = recorder()
  const result = await runAction(git, noFs, '/repo', { cwd: '/repo', action: 'teleport' })
  assert.equal(result.ok, false)
  assert.match(result.output, /Unknown Source Control action: teleport/)
  assert.deepEqual(effects(git), [], 'an unknown action must not run anything')
})

/** Real git, for the fixture cases: the same shape as `GitRunner`. */
function realRunner() {
  return {
    async run(cwd, args, input) {
      const command = `git ${args.join(' ')}`
      const outcome = await new Promise((resolve) => {
        const child = spawn('git', args, { cwd, windowsHide: true })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => (stdout += chunk))
        child.stderr.on('data', (chunk) => (stderr += chunk))
        child.on('error', (error) => resolve({ exitCode: 1, stdout, stderr: String(error.message) }))
        child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }))
        child.stdin.end(input ?? '')
      })
      return { ...outcome, command }
    },
    async tryText(cwd, args) {
      const result = await this.run(cwd, args)
      return result.exitCode === 0 ? result.stdout : undefined
    },
  }
}

/** Run git in the fixture and insist it worked. */
async function git(cwd, args, input) {
  const result = await realRunner().run(cwd, args, input)
  assert.equal(result.exitCode, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

/**
 * A bare remote, a seed clone that fills it, and a working clone of it.
 *
 * `-b main` is spelled out so the fixture does not depend on `init.defaultBranch`.
 */
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'scm-fixture-'))
  const origin = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  const work = path.join(root, 'work')
  await git(root, ['init', '--bare', '-b', 'main', origin])
  await git(root, ['init', '-b', 'main', seed])
  await git(seed, ['config', 'user.email', 'test@example.com'])
  await git(seed, ['config', 'user.name', 'Test'])
  await git(seed, ['config', 'commit.gpgsign', 'false'])
  await writeFile(path.join(seed, 'a.txt'), 'a\n')
  await git(seed, ['add', '-A'])
  await git(seed, ['commit', '-q', '-m', 'initial'])
  await git(seed, ['remote', 'add', 'origin', origin])
  await git(seed, ['push', '-q', '-u', 'origin', 'main'])
  await git(root, ['clone', '-q', origin, work])
  await git(work, ['config', 'user.email', 'test@example.com'])
  await git(work, ['config', 'user.name', 'Test'])
  await git(work, ['config', 'commit.gpgsign', 'false'])
  return { root, origin, seed, work }
}

test('a sync in a real repository moves the commit to the remote', async () => {
  const { root, origin, seed, work } = await fixture()
  try {
    await writeFile(path.join(work, 'b.txt'), 'b\n')
    await git(work, ['add', '-A'])
    await git(work, ['commit', '-q', '-m', 'local work'])
    const local = await git(work, ['rev-parse', 'HEAD'])
    assert.notEqual(await git(origin, ['rev-parse', 'main']), local, 'the fixture starts a commit ahead')

    // A commit on the other side, so the sync has something to pull as well: the
    // pull merges it, which is why the commit that reaches the remote is the
    // merge rather than the one made here.
    await writeFile(path.join(seed, 'c.txt'), 'c\n')
    await git(seed, ['add', '-A'])
    await git(seed, ['commit', '-q', '-m', 'upstream work'])
    await git(seed, ['push', '-q', 'origin', 'main'])

    const result = await runAction(realRunner(), noFs, work, { cwd: work, action: 'sync' })
    assert.equal(result.ok, true, result.output)
    const commands = result.command.split('\n')
    assert.match(commands[0], /git pull origin main/, 'the sync pulls its upstream first')
    assert.match(commands[1], /git push origin main:main/, 'and then pushes the branch')

    const pushed = await git(origin, ['rev-parse', 'main'])
    assert.equal(pushed, await git(work, ['rev-parse', 'HEAD']), 'the remote holds what the branch holds')
    await git(work, ['merge-base', '--is-ancestor', local, pushed], undefined)
    assert.equal(await git(work, ['rev-list', '--count', '@{upstream}..HEAD']), '0')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a sync on a branch that is only behind does not push', async () => {
  const { root, origin, seed, work } = await fixture()
  try {
    await writeFile(path.join(seed, 'd.txt'), 'd\n')
    await git(seed, ['add', '-A'])
    await git(seed, ['commit', '-q', '-m', 'upstream only'])
    await git(seed, ['push', '-q', 'origin', 'main'])

    const result = await runAction(realRunner(), noFs, work, { cwd: work, action: 'sync' })
    assert.equal(result.ok, true, result.output)
    assert.doesNotMatch(result.command, /git push/, 'nothing was ahead, so nothing was pushed')
    assert.equal(await git(work, ['rev-list', '--count', '@{upstream}..HEAD']), '0')
    assert.equal(await git(work, ['rev-parse', 'HEAD']), await git(origin, ['rev-parse', 'main']))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a publish puts a new branch on the remote and sets its upstream', async () => {
  const { root, origin, work } = await fixture()
  try {
    await git(work, ['switch', '-q', '-c', 'feature'])
    await writeFile(path.join(work, 'e.txt'), 'e\n')
    await git(work, ['add', '-A'])
    await git(work, ['commit', '-q', '-m', 'feature work'])
    const local = await git(work, ['rev-parse', 'HEAD'])

    const result = await runAction(realRunner(), noFs, work, { cwd: work, action: 'publish' })
    assert.equal(result.ok, true, result.output)
    assert.equal(await git(origin, ['rev-parse', 'feature']), local)
    assert.equal(await git(work, ['rev-parse', '--abbrev-ref', 'feature@{upstream}']), 'origin/feature')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const { name, run } of cases) {
  await run()
  console.log(`ok    ${name}`)
}

await rm(stage, { recursive: true, force: true })
console.log(`\nall ${cases.length} action cases pass`)
