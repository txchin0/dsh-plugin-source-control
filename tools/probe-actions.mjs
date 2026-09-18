/**
 * Drives the plugin's own HTTP surface against a throwaway repository.
 *
 * The Host half is the only place the action logic can actually be wrong: the
 * panel asks for an action by name and the route runs git. This script builds a
 * fixture (a bare remote, a seed clone that fills it, a working clone of it),
 * posts the action the panel posts, and reports both the response and what the
 * remote then holds — which is the thing the panel cannot show you.
 *
 * Usage: node tools/probe-actions.mjs <base-url-with-token>
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const base = process.argv[2]
if (base === undefined) {
  console.error('usage: node tools/probe-actions.mjs <base-url-with-token>')
  process.exit(2)
}
const endpoint = new URL('/source-control/api/action', base)

/** Run git in the fixture and insist it worked. */
async function git(cwd, args) {
  const outcome = await new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: String(error.message) }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.stdin.end('')
  })
  if (outcome.code !== 0) throw new Error(`git ${args.join(' ')}: ${outcome.stderr}`)
  return outcome.stdout.trim()
}

/** Post one action and return the response as the panel would see it. */
async function post(body) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  return { status: response.status, bytes: text.length, parsed, text: text.slice(0, 400) }
}

const root = await mkdtemp(path.join(tmpdir(), 'scm-probe-'))
const origin = path.join(root, 'origin.git')
const seed = path.join(root, 'seed')
const work = path.join(root, 'work')

try {
  await git(root, ['init', '--bare', '-b', 'main', origin])
  await git(root, ['init', '-b', 'main', seed])
  await git(seed, ['config', 'user.email', 'probe@example.com'])
  await git(seed, ['config', 'user.name', 'Probe'])
  await git(seed, ['config', 'commit.gpgsign', 'false'])
  await writeFile(path.join(seed, 'a.txt'), 'a\n')
  await git(seed, ['add', '-A'])
  await git(seed, ['commit', '-q', '-m', 'initial'])
  await git(seed, ['remote', 'add', 'origin', origin])
  await git(seed, ['push', '-q', '-u', 'origin', 'main'])
  await git(root, ['clone', '-q', origin, work])
  await git(work, ['config', 'user.email', 'probe@example.com'])
  await git(work, ['config', 'user.name', 'Probe'])
  await git(work, ['config', 'commit.gpgsign', 'false'])

  // One commit on each side, so a sync has both something to pull and something
  // to push, exactly like the case the panel's button is for.
  await writeFile(path.join(work, 'b.txt'), 'b\n')
  await git(work, ['add', '-A'])
  await git(work, ['commit', '-q', '-m', 'local work'])
  await writeFile(path.join(seed, 'c.txt'), 'c\n')
  await git(seed, ['add', '-A'])
  await git(seed, ['commit', '-q', '-m', 'upstream work'])
  await git(seed, ['push', '-q', 'origin', 'main'])

  const before = { remote: await git(origin, ['rev-parse', 'main']), local: await git(work, ['rev-parse', 'HEAD']) }
  const sync = await post({ cwd: work, action: 'sync' })
  const after = {
    remote: await git(origin, ['rev-parse', 'main']),
    local: await git(work, ['rev-parse', 'HEAD']),
    inStep: await git(work, ['rev-list', '--count', '@{upstream}..HEAD']),
  }
  const unknown = await post({ cwd: work, action: 'teleport' })

  console.log(
    JSON.stringify(
      {
        fixture: root,
        before,
        sync,
        after,
        pushed: after.remote === after.local && after.remote !== before.remote,
        unknown,
      },
      null,
      2,
    ),
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
