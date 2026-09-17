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

  // Only expanded workspaces list their sessions. Expand every collapsed one by
  // toggling and undoing the toggle when a click closed something instead.
  await check('expand workspaces', async () => {
    const rows = () => driver.probe(`document.querySelectorAll('.YDXeBa_sessionRow').length`)
    const workspaces = await driver.probe(`document.querySelectorAll('.YDXeBa_projectRow').length`)
    for (let index = 0; index < workspaces; index += 1) {
      const before = await rows()
      await driver.click({ selector: '.YDXeBa_projectRow', index })
      await driver.sleep(700)
      if ((await rows()) < before) {
        await driver.click({ selector: '.YDXeBa_projectRow', index })
        await driver.sleep(700)
      }
    }
    return rows()
  })

  await check('open session', () => driver.click({ selector: '.YDXeBa_sessionRow', index: sessionIndex }))
  await driver.sleep(4000)

  // A fresh session's right column starts collapsed; the reveal control is in
  // the conversation header's corner, which exists only once a session is open.
  await check('reveal right sidebar', () => driver.click({ name: 'Open right sidebar' }))
  await driver.sleep(2500)

  await check('open Source Control', () => driver.click({ text: 'Source Control', within: RIGHT }))
  await driver.sleep(3500)

  const panel = await driver.probe(`(() => {
    const node = document.querySelector('.dsh-scm')
    if (node === null) {
      return { present: false, rightbar: (document.querySelector('[data-slot="rightbar.session"]') || {}).innerText }
    }
    return {
      present: true,
      repo: (node.querySelector('.dsh-scm-repository-name') || {}).innerText,
      branch: (node.querySelector('.dsh-scm-repository-branch') || {}).innerText,
      sections: [...node.querySelectorAll('.dsh-scm-section')].map((section) => ({
        title: (section.querySelector('.dsh-scm-section-title') || {}).innerText,
        count: (section.querySelector('.dsh-scm-count') || {}).innerText,
        collapsed: section.getAttribute('data-collapsed') === 'true',
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
