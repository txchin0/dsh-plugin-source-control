/**
 * Which action each commit-button label actually runs.
 *
 * The button is one control with four faces — Continue, Publish Branch, Sync
 * Changes, Commit — and each has to issue the *right* git work: a Sync Changes
 * that only pulls is the bug this check exists for, because nothing about the
 * panel shows it went half way. The mapping is git's action button, verbatim:
 * changes to commit win the button, then Publish, then Sync, then a disabled
 * Commit.
 *
 * The check never lets a request reach the Host half. It replaces `window.fetch`
 * with a stub that answers the panel's three calls — status, history, action —
 * from a table of synthetic repository states, so each label can be produced on
 * demand and each click is recorded instead of run. No repository is touched.
 *
 * Environment:
 *   SCM_SESSION_INDEX  which session to open, top to bottom, counting only rows
 *                      that name a session (default 0)
 */
export default async function run(driver) {
  const trace = []
  const RIGHT = '[data-slot="rightbar.session"]'
  const sessionIndex = Number(process.env.SCM_SESSION_INDEX ?? 0)
  const step = async (name, action) => {
    try {
      trace.push({ step: name, result: await action() })
      return true
    } catch (error) {
      trace.push({ step: name, error: String(error.message) })
      return false
    }
  }

  const failures = []
  const check = async (name, action) => {
    if (!(await step(name, action))) failures.push(name)
  }

  const waitFor = async (expression, label, timeoutMs = 12000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if ((await driver.probe(expression)) === true) return true
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
      await driver.sleep(250)
    }
  }

  /** One file row, which is all a status needs to have something to commit. */
  const resource = {
    path: 'a.txt',
    name: 'a.txt',
    dir: '',
    code: 'M',
    statusText: 'Modified',
    strikeThrough: false,
    group: 'workingTree',
    diffKind: 'workingTree',
    hasIndexChange: false,
  }
  const status = ({ groups = [], upstream = 'origin/main', ahead = 0, behind = 0 } = {}) => ({
    root: '/tmp/action-mapping',
    name: 'action-mapping',
    branch: 'main',
    detached: false,
    unborn: false,
    upstream,
    ahead,
    behind,
    groups,
  })
  const behindThenAhead = status({ ahead: 2, behind: 1 })
  const withChanges = status({ ahead: 2, behind: 1, groups: [{ id: 'workingTree', label: 'Changes', resources: [resource] }] })
  const noUpstream = status({ upstream: null })

  // Only expanded workspaces list their sessions, and a fresh client's list opens
  // expanded where a used one's is collapsed, so click only when nothing is on
  // screen — a toggle-by-toggle walk collapses the list it came to read.
  await check('expand workspaces', async () => {
    const VISIBLE_ROWS = `[...document.querySelectorAll('.YDXeBa_sessionRow')].filter((n) => n.offsetParent !== null && n.getBoundingClientRect().width > 0).length`
    if ((await driver.probe(VISIBLE_ROWS)) > 0) return 'already expanded'
    const workspaces = await driver.probe(`document.querySelectorAll('.YDXeBa_projectRow').length`)
    for (let index = 0; index < workspaces; index += 1) {
      await driver.click({ selector: '.YDXeBa_projectRow', index })
      await driver.sleep(800)
    }
    await waitFor(`${VISIBLE_ROWS} > 0`, 'session rows to appear')
    return 'expanded'
  })

  const rowIndex = await driver.probe(`(() => {
    const visible = (node) => node.offsetParent !== null && node.getBoundingClientRect().width > 0
    const rows = [...document.querySelectorAll('.YDXeBa_sessionRow')].filter(visible)
    const real = rows.filter((node) => (node.innerText || '').trim().toLowerCase() !== 'new session')
    const wanted = real[${sessionIndex}]
    return wanted === undefined ? -1 : rows.indexOf(wanted)
  })()`)
  if (rowIndex < 0) throw new Error(`no session row at index ${sessionIndex}`)
  await check('open session', () => driver.click({ selector: '.YDXeBa_sessionRow', index: rowIndex }))
  await driver.sleep(4000)

  await step('reveal right sidebar', async () => {
    try {
      await driver.click({ name: 'Open right sidebar' })
      await driver.sleep(2500)
      return 'revealed'
    } catch {
      return 'already open'
    }
  })

  await check('open Source Control', () => driver.click({ text: 'Source Control', within: RIGHT }))
  await waitFor(`document.querySelector('.dsh-scm-button') !== null`, 'the panel to render')

  await check('stub the host API', async () => {
    await driver.probe(`(() => {
      if (window.__scmStub !== undefined) return true
      const real = window.fetch.bind(window)
      const answer = (body) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
      window.__scmStubRealFetch = real
      window.__scmStub = { status: null, actions: [] }
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url
        // The action call is recorded and answered, never forwarded: a stray real
        // one would commit or push in whatever repository the session is on.
        if (url.includes('/source-control/api/action')) {
          window.__scmStub.actions.push(JSON.parse(init.body))
          return answer({ ok: true, command: 'stubbed', output: '' })
        }
        if (url.includes('/source-control/api/status')) return answer(window.__scmStub.status)
        if (url.includes('/source-control/api/history')) {
          return answer({ commits: [], incoming: 0, outgoing: 0, hasMore: false, head: null, upstreamRevision: null, upstreamRef: null, mergeBase: null })
        }
        return real(input, init)
      }
      return true
    })()`)
    return 'installed'
  })

  /** Put one synthetic state in front of the panel and read the button it draws. */
  const settle = async (next, expectedLabel) => {
    await driver.probe(`(() => { window.__scmStub.status = ${JSON.stringify(next)}; return true })()`)
    await waitFor(
      `document.querySelector('.dsh-scm-button') !== null && document.querySelector('.dsh-scm-button').innerText.trim().startsWith(${JSON.stringify(expectedLabel)})`,
      `the button to read "${expectedLabel}"`,
    )
    return driver.probe(`(() => {
      const button = document.querySelector('.dsh-scm-button')
      return {
        label: (button.innerText || '').trim(),
        title: button.getAttribute('title'),
        disabled: button.disabled,
        dropdown: document.querySelector('.dsh-scm-button-dropdown') !== null,
        counts: [...button.querySelectorAll('.dsh-scm-button-count')].map((node) => (node.innerText || '').trim()),
      }
    })()`)
  }

  /** Click the button and hand back the action the panel asked the host to run. */
  const clicked = async () => {
    await driver.probe(`(() => { window.__scmStub.actions.length = 0; return true })()`)
    await driver.click({ selector: '.dsh-scm-button' })
    await waitFor(`window.__scmStub.actions.length > 0`, 'the panel to ask for an action')
    const action = await driver.probe(`window.__scmStub.actions[0].action`)
    return action
  }

  // A branch out of step, with a clean tree: Sync Changes, and it must sync —
  // pull *and* push — rather than pull alone.
  await check('Sync Changes syncs', async () => {
    const button = await settle(behindThenAhead, 'Sync Changes')
    if (button.counts.join(',') !== '1,2') throw new Error(`the counts read ${JSON.stringify(button.counts)}, not behind then ahead`)
    if (button.dropdown) throw new Error('a sync button does not offer the commit dropdown')
    const action = await clicked()
    if (action !== 'sync') throw new Error(`Sync Changes asked for "${action}", not a sync`)
    return { label: button.label, title: button.title, action }
  })

  // Changes to commit win the button, exactly as git's action button decides —
  // even while the branch is out of step.
  await check('changes to commit win the button', async () => {
    const button = await settle(withChanges, 'Commit')
    if (button.disabled) throw new Error('the Commit button is disabled while there are changes')
    if (!button.dropdown) throw new Error('the Commit button lost its dropdown')
    const action = await clicked()
    if (action !== 'commit') throw new Error(`Commit asked for "${action}"`)
    return { label: button.label, action }
  })

  // No upstream: Publish Branch, which sets the upstream rather than pushing bare.
  await check('Publish Branch publishes', async () => {
    const button = await settle(noUpstream, 'Publish Branch')
    const action = await clicked()
    if (action !== 'publish') throw new Error(`Publish Branch asked for "${action}", not a publish`)
    return { label: button.label, action }
  })

  // A clean branch in step with its upstream: Commit, disabled.
  await check('a branch in step offers a disabled Commit', async () => {
    const button = await settle(status(), 'Commit')
    if (!button.disabled) throw new Error('Commit is enabled with nothing to commit')
    return { label: button.label, disabled: button.disabled }
  })

  // Hand the real API back, so the panel is left as it was found.
  await step('restore the host API', async () => {
    const restored = await driver.probe(`(() => {
      if (window.__scmStub === undefined) return { restored: false, reason: 'no stub' }
      const asked = window.__scmStub.actions.map((request) => request.action)
      window.fetch = window.__scmStubRealFetch
      delete window.__scmStubRealFetch
      delete window.__scmStub
      return { restored: window.fetch !== undefined, asked }
    })()`)
    await driver.sleep(4200)
    return restored
  })

  if (failures.length > 0) {
    console.error(JSON.stringify(trace, null, 2))
    throw new Error(`steps failed: ${failures.join(', ')}`)
  }
  return trace
}
