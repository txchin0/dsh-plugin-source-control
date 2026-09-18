/**
 * The diff pane, checked to be *rendering* rather than merely mounted.
 *
 * The pane has one failure mode that looks like nothing at all: the diff body
 * builds its Monaco theme inside the effect that creates the editor, so a colour
 * Monaco refuses throws while the body mounts, the slot runtime drops the entry,
 * and the tab comes up blank with no header, no message, and no explanation —
 * only a console error. That is why it is invisible to every static check here.
 * The scheme is what decides it: the DeepSeek Harness tokens are read off the
 * page, and the light theme's `--dsw-alias-bg-base` is the three-digit `#fff`,
 * which is legal CSS and illegal Monaco theme data.
 *
 * So this check drives the whole path in whatever scheme the server it is
 * pointed at is in — the preference is one durable document shared by every
 * profile, so `DSH_HOME=<isolated home>` is how the other scheme gets a run —
 * and asserts the five things the blank pane failed:
 *
 *   - the diff body rendered at all;
 *   - its header names a comparison rather than a failure or a spinner;
 *   - Monaco's diff editor mounted and produced view lines with text in them;
 *   - it laid out two side-by-side surfaces;
 *   - its computed background is the page's own `--dsw-alias-bg-base`, which is
 *     what proves the theme's colours survived the trip from a CSS token into
 *     Monaco's theme data.
 *
 * Nothing is written to the repository — the diff pane is read-only.
 *
 * Environment:
 *   SCM_SESSION_INDEX  which session row to open, top to bottom (default 0)
 *   SHOT_DIR           where the screenshot lands
 */
export default async function run(driver) {
  const trace = []
  const RIGHT = '[data-slot="rightbar.session"]'
  const sessionIndex = Number(process.env.SCM_SESSION_INDEX ?? 0)
  const failures = []

  const step = async (name, action) => {
    try {
      const result = await action()
      trace.push({ step: name, result })
      process.stderr.write(`ok    ${name}\n`)
      return result
    } catch (error) {
      trace.push({ step: name, error: String(error.message) })
      process.stderr.write(`FAIL  ${name}: ${error.message}\n`)
      failures.push(name)
      return undefined
    }
  }

  const check = async (name, condition, describe) => {
    await step(name, async () => {
      const state = await condition()
      if (state !== true) throw new Error(describe(state))
      return state
    })
  }

  const waitFor = async (name, expression, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await driver.probe(expression)) return true
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${name}`)
      await driver.sleep(400)
    }
  }

  await step('expand workspaces', async () => {
    const rows = () => driver.probe(`document.querySelectorAll('.YDXeBa_sessionRow').length`)
    const workspaces = await driver.probe(`document.querySelectorAll('.YDXeBa_projectRow').length`)
    for (let index = 0; index < workspaces; index += 1) {
      const before = await rows()
      await driver.click({ selector: '.YDXeBa_projectRow', index })
      await driver.sleep(700)
      if ((await rows()) < before) {
        // The row was already open and the click closed it; put it back.
        await driver.click({ selector: '.YDXeBa_projectRow', index })
        await driver.sleep(700)
      }
    }
    return rows()
  })

  // The list's first row is a "New Session" placeholder whenever no conversation
  // is open yet, and clicking it never opens one, so the wanted index is counted
  // over the rows that actually name a session.
  await step('open session', async () => {
    await waitFor('a session row', `document.querySelectorAll('.YDXeBa_sessionRow').length > 0`)
    const rowIndex = await driver.probe(`(() => {
      const visible = (node) => node.offsetParent !== null && node.getBoundingClientRect().width > 0
      const rows = [...document.querySelectorAll('.YDXeBa_sessionRow')].filter(visible)
      const real = rows.filter((node) => (node.innerText || '').trim().toLowerCase() !== 'new session')
      const wanted = real[${sessionIndex}]
      return wanted === undefined ? -1 : rows.indexOf(wanted)
    })()`)
    if (rowIndex < 0) throw new Error(`no session row at index ${sessionIndex}`)
    await driver.click({ selector: '.YDXeBa_sessionRow', index: rowIndex })
    await waitFor('conversation header', `document.querySelector('[data-slot="conversation.session.header"]') !== null`)
    return rowIndex
  })

  await step('reveal right sidebar', async () => {
    const open = () =>
      driver.probe(
        `(() => { const node = document.querySelector('${RIGHT} [data-sidebar-right-panel]'); return node !== null && node.getAttribute('aria-hidden') !== 'true' })()`,
      )
    if (await open()) return 'already open'
    await waitFor(
      'the reveal control',
      `[...document.querySelectorAll('[aria-label]')].some((n) => n.getAttribute('aria-label') === 'Open right sidebar' && n.offsetParent !== null)`,
    )
    await driver.click({ name: 'Open right sidebar' })
    await waitFor('the right sidebar to open', `document.querySelector('${RIGHT} [data-sidebar-right-panel]') !== null`)
    return 'revealed'
  })

  await step('open Source Control', async () => {
    const tabs = () =>
      driver.probe(`[...document.querySelectorAll('${RIGHT} [role="tab"]')].map((n) => (n.innerText || '').trim())`)
    if (!(await tabs()).includes('Source Control')) {
      // The column keeps its tabs in memory only, so a fresh session's pane
      // starts on the guide tab — which is the picker listing every tab type the
      // plugin registered, this one included.
      if (!(await tabs()).includes('Start')) {
        await driver.click({ selector: `${RIGHT} [data-dockkit-add-tab]` })
        await driver.sleep(800)
      }
      await waitFor(
        'the guide to list Source Control',
        `[...document.querySelectorAll('${RIGHT} *')].some((n) => (n.innerText || '').trim() === 'Source Control')`,
      )
    }
    await driver.click({ text: 'Source Control', within: RIGHT })
    await waitFor('the Source Control panel', `document.querySelector('.dsh-scm') !== null`)
    await waitFor('the changes list', `document.querySelector('.dsh-scm-row') !== null`)
    return tabs()
  })

  // The scheme decides every colour below, so it is reported with them: a run in
  // the wrong one proves nothing about the scheme it was meant to test.
  const scheme = await driver.probe(`(() => {
    const token = (name) => getComputedStyle(document.body).getPropertyValue(name).trim()
    return {
      active: (document.querySelector('.dsh-scm') || {}).dataset?.scheme ?? null,
      darkAttribute: document.body.hasAttribute('data-ds-dark-theme'),
      bgBase: token('--dsw-alias-bg-base'),
      labelPrimary: token('--dsw-alias-label-primary'),
    }
  })()`)
  trace.push({ step: 'scheme', result: scheme })

  await step('open a diff', async () => {
    // A binary file compares to an empty editor, so the first text file is opened.
    const index = await driver.probe(`(() => {
      const rows = [...document.querySelectorAll('.dsh-scm-row')]
      const path = (node) => (node.getAttribute('title') || '').split(' • ')[0]
      const found = rows.findIndex((node) => /\\.(ts|tsx|js|mjs|json|css|md|txt|html|yml|yaml)$/i.test(path(node)))
      return found === -1 ? 0 : found
    })()`)
    await driver.click({ selector: '.dsh-scm-row', index })
    return index
  })

  /** Everything asserted below, read out of the page in one pass. */
  const PANE = `(() => {
    const editor = document.querySelector('.monaco-diff-editor')
    const lines = [...document.querySelectorAll('.monaco-diff-editor .view-line')]
    // The browser's own normalisation of the token the theme was built from: a
    // probe element painted with the variable and read back, which is the same
    // trip the editor's background took.
    const probe = document.createElement('div')
    probe.style.background = 'var(--dsw-alias-bg-base)'
    document.body.appendChild(probe)
    const expectedBackground = getComputedStyle(probe).backgroundColor
    probe.remove()
    // Monaco lays out a hidden gutter as a third \`.monaco-editor\`, so the two
    // surfaces are the ones with a box. Counting them is how "side by side" is
    // asserted without depending on where in the file the change happens to be.
    const surfaces = [...document.querySelectorAll('.monaco-diff-editor .monaco-editor')]
      .map((node) => node.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0)
    const first = document.querySelector('.monaco-diff-editor .monaco-editor')
    return {
      body: document.querySelector('.dsh-scm-diff') !== null,
      header: (document.querySelector('.dsh-scm-diff-paths') || {}).innerText ?? null,
      mounted: editor !== null,
      lineCount: lines.length,
      readable: lines.filter((node) => (node.innerText || '').trim() !== '').length,
      surfaces: surfaces.map((box) => ({ width: Math.round(box.width), height: Math.round(box.height) })),
      background: first === null ? null : getComputedStyle(first).backgroundColor,
      expectedBackground,
      foreground: first === null ? null : getComputedStyle(first).color,
    }
  })()`

  /** Read the pane once it has settled; a pane that never renders reports as empty. */
  const EMPTY = { body: false, header: null, mounted: false, lineCount: 0, readable: 0, surfaces: [], background: null, expectedBackground: null, foreground: null }
  const pane =
    (await step('render the diff pane', async () => {
      await waitFor('the diff body to render', `document.querySelector('.dsh-scm-diff') !== null`, 10000)
      await waitFor(
        'the Monaco diff to mount',
        `document.querySelector('.monaco-diff-editor .view-line') !== null`,
        20000,
      )
      // The editor lays out asynchronously, so the first paint is not the reading.
      await driver.sleep(2500)
      return driver.probe(PANE)
    })) ?? EMPTY
  trace.push({ step: 'diff pane', result: pane })

  // The failure this check exists for: the diff body threw while mounting, so
  // nothing rendered and the console carries the reason.
  await check(
    'the diff body rendered',
    () => pane.body,
    () => 'the diff pane rendered nothing — the body most likely threw while mounting',
  )
  await check(
    'the header names a comparison',
    () => typeof pane.header === 'string' && pane.header.includes('↔'),
    () => `the diff header reads ${JSON.stringify(pane.header)}`,
  )
  await check(
    'the Monaco diff editor mounted',
    () => pane.mounted && pane.readable > 1,
    () => `the diff editor holds ${pane.lineCount} view lines, ${pane.readable} of them with text`,
  )
  await check(
    'the editor wears the scheme background',
    () => pane.background !== null && pane.background === pane.expectedBackground,
    () => `the editor is ${pane.background} where --dsw-alias-bg-base is ${pane.expectedBackground}`,
  )
  // The diff layout itself. Note what is *not* asserted: the count of
  // `.line-insert`/`.line-delete` decorations. Monaco paints those for the
  // rendered lines only, so counting them measures where the change sits in
  // whichever file this run opened against whichever repository it opened it
  // in — a change below the fold reports zero in a pane that is working
  // perfectly. Two laid-out surfaces is the viewport-independent half of the
  // same question.
  await check(
    'the editor is a side-by-side diff of two laid-out surfaces',
    () => pane.surfaces.length === 2 && pane.surfaces[0].height === pane.surfaces[1].height,
    () => `the diff editor laid out ${JSON.stringify(pane.surfaces)}`,
  )

  await step('screenshot the diff pane', async () => {
    const clip = await driver.probe(`(() => {
      const node = document.querySelector('.dsh-scm-diff')
      if (node === null) return null
      const r = node.getBoundingClientRect()
      return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: r.width, height: r.height }
    })()`)
    if (clip === null) throw new Error('there is no diff pane to shoot')
    await driver.park()
    await driver.sleep(300)
    return driver.shot(`diff-${scheme.active ?? 'unknown'}`, clip)
  })

  if (failures.length > 0) {
    process.stderr.write(`--- trace ---\n${JSON.stringify(trace, null, 2)}\n`)
    throw new Error(`steps failed: ${failures.join(', ')}`)
  }
  return trace
}
