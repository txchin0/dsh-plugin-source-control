/**
 * A worked example step script: open the Source Control tab and report what the
 * panel actually rendered.
 *
 * Copy this as the starting point for a new check. Three things are worth
 * keeping: the fixture preamble (the right Sidebar's layout is per session and
 * memory-only, so a check must reach a session before any panel exists), the
 * `probe()` that reads real DOM state, and the assertion at the end — a step
 * that silently failed must fail the run.
 *
 * Environment:
 *   SCM_SESSION_INDEX  which session row to open, top to bottom (default 0)
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

  // Only expanded workspaces list their sessions, and a fresh client's list
  // opens its workspaces already expanded where a used one's are collapsed —
  // which is why this only clicks when nothing is on screen. A toggle-by-toggle
  // walk would collapse the list it was trying to read.
  await check('expand workspaces', async () => {
    const VISIBLE_ROWS = `[...document.querySelectorAll('.YDXeBa_sessionRow')].filter((n) => n.offsetParent !== null && n.getBoundingClientRect().width > 0).length`
    const already = await driver.probe(VISIBLE_ROWS)
    if (already > 0) return already
    const workspaces = await driver.probe(`document.querySelectorAll('.YDXeBa_projectRow').length`)
    for (let index = 0; index < workspaces; index += 1) {
      await driver.click({ selector: '.YDXeBa_projectRow', index })
      await driver.sleep(800)
    }
    const rows = await driver.probe(VISIBLE_ROWS)
    if (rows === 0) throw new Error('no session rows became visible')
    return rows
  })

  // The first row is a "New Session" placeholder whenever no conversation is
  // open yet, and clicking it opens nothing, so the wanted index counts only
  // over the rows that actually name a session.
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

  // A fresh session's right column starts collapsed; the reveal control is in
  // the conversation header's corner, which exists only once a session is open.
  // A client that starts with the column already open has no such control, so
  // this is best-effort rather than a check.
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
  await driver.sleep(3500)

  const panel = await driver.probe(`(() => {
    const node = document.querySelector('.dsh-scm')
    if (node === null) {
      return { present: false, rightbar: (document.querySelector('[data-slot="rightbar.session"]') || {}).innerText }
    }
    return {
      present: true,
      panes: [...node.querySelectorAll('.dsh-scm-pane')].map((pane) => ({
        view: pane.getAttribute('data-view'),
        title: (pane.querySelector('.dsh-scm-pane-title') || {}).innerText,
        expanded: pane.getAttribute('data-expanded') === 'true',
      })),
      changeRows: node.querySelectorAll('.dsh-scm-group .dsh-scm-row').length,
      commitRows: node.querySelectorAll('.dsh-scm-commit').length,
    }
  })()`)
  trace.push({ step: 'panel', panel })

  trace.push({ step: 'screenshot', result: await driver.shot('open-panel') })

  if (!panel.present) failures.push('panel did not render')
  if (failures.length > 0) throw new Error(`steps failed: ${failures.join(', ')}`)
  return trace
}
