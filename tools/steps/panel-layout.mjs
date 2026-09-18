/**
 * The panel's container, checked against VS Code's pane view.
 *
 * The Source Control panel is a port of VS Code's SCM *view container*: two
 * panes — Changes (the commit box, its button, the resource groups) and Graph —
 * each with a `.pane-header`, and a sash floated over the boundary between them.
 * The parts of that which only a live page can prove, and which this check pins:
 *
 *   - a collapsed pane is pinned to its header's 22px and the *other* pane takes
 *     every freed pixel, so the collapsed header ends up at the bottom of the
 *     column. The version this replaced kept its own `flex-grow` share and left
 *     the freed space blank below the Graph, which is the bug that started this;
 *   - the sash takes no layout room at all, so the two panes' heights always add
 *     up to the container;
 *   - the panes fold from their own headers (fold either and the other takes the
 *     whole column), drag from the sash, and reset to halves on a double click;
 *   - opening a diff beside the panel — the unmount path that has taken the
 *     whole right column down before — still leaves a working column.
 *
 * Environment:
 *   SCM_SESSION_INDEX   which session to open, top to bottom, counting only rows
 *                       that name a session — the "New Session" placeholder that
 *                       heads a cold client's list is skipped (default 0)
 *   SHOT_DIR            where the screenshots land
 */
export default async function run(driver) {
  const trace = []
  const RIGHT = '[data-slot="rightbar.session"]'
  const CHANGES = '.dsh-scm-pane[data-view="changes"]'
  const GRAPH = '.dsh-scm-pane[data-view="graph"]'
  const HEADER = '.dsh-scm-pane-header'
  const SASH = '.dsh-scm-sash-handle'
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

  /** Wait for an expression to hold, so no click races a render. */
  const waitFor = async (expression, label, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if ((await driver.probe(expression)) === true) return true
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
      await driver.sleep(250)
    }
  }

  /**
   * Everything this check asserts, read straight out of the DOM.
   *
   * The two panes' boxes and the container's are returned rounded, because the
   * flexbox split is fractional and the assertions compare sums.
   */
  const LAYOUT = `(() => {
    const panel = document.querySelector('.dsh-scm')
    if (panel === null) return null
    const box = (node) => {
      if (node === null) return null
      const r = node.getBoundingClientRect()
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) }
    }
    // Page.captureScreenshot wants x/y, so the panel's box is clipped a second
    // way rather than reusing the box above.
    const clip = (node) => {
      const r = node.getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    }
    const panes = [...panel.querySelectorAll('.dsh-scm-pane')]
    const text = (node, selector) => {
      const found = node === null ? null : node.querySelector(selector)
      return found === null ? '' : (found.innerText || '').trim()
    }
    return {
      panes: panes.map((pane) => ({
        view: pane.getAttribute('data-view'),
        expanded: pane.getAttribute('data-expanded') === 'true',
        title: text(pane, '.dsh-scm-pane-title'),
        header: box(pane.querySelector('.dsh-scm-pane-header')),
        body: box(pane.querySelector('.dsh-scm-pane-body')),
        box: box(pane),
      })),
      container: box(panel.querySelector('.dsh-scm-panes')),
      sash: box(panel.querySelector(${JSON.stringify(SASH)})),
      sashDisabled: (panel.querySelector('.dsh-scm-sash') || {}).dataset?.disabled === 'true',
      // The Changes pane is the commit box, its button, and the groups — not a
      // toolbar and not a separate repository row.
      hasInput: panel.querySelector('.dsh-scm-editor') !== null,
      inputPlaceholder: (panel.querySelector('.dsh-scm-editor') || {}).placeholder || '',
      commitButton: text(panel, '.dsh-scm-button'),
      toolbar: panel.querySelectorAll('.dsh-scm-toolbar').length,
      repositoryRow: panel.querySelectorAll('.dsh-scm-repository').length,
      changeRows: panel.querySelectorAll('.dsh-scm-group .dsh-scm-row').length,
      commitRows: panel.querySelectorAll('.dsh-scm-commit').length,
      headerActions: [...panel.querySelectorAll('.dsh-scm-pane-header .dsh-scm-action')].map(
        (button) => button.getAttribute('title'),
      ),
      panel: clip(panel),
    }
  })()`

  // Only expanded workspaces list their sessions. The list's default differs by
  // how the client was loaded, so expand only when nothing is on screen: a
  // toggle-by-toggle walk collapses an already-expanded list instead.
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

  // The list's first row is a "New Session" placeholder whenever no conversation
  // is open yet, and clicking it never opens one, so the wanted index is counted
  // over the rows that actually name a session.
  const rowIndex = await driver.probe(`(() => {
    const visible = (node) => node.offsetParent !== null && node.getBoundingClientRect().width > 0
    const rows = [...document.querySelectorAll('.YDXeBa_sessionRow')].filter(visible)
    const real = rows.filter((node) => (node.innerText || '').trim().toLowerCase() !== 'new session')
    const wanted = real[${sessionIndex}]
    return wanted === undefined ? -1 : rows.indexOf(wanted)
  })()`)
  if (rowIndex < 0) {
    failures.push(`no session row at index ${sessionIndex}`)
    throw new Error(`steps failed: ${failures.join(', ')}`)
  }
  await check('open session', () => driver.click({ selector: '.YDXeBa_sessionRow', index: rowIndex }))
  await driver.sleep(4000)

  // A collapsed column offers its reveal control in the conversation header's
  // corner, which exists only once a session is open; a client that starts with
  // the column already open has no such control, so this is best-effort.
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

  const initial = await driver.probe(LAYOUT)
  trace.push({ step: 'layout', result: initial })
  if (initial === null) {
    failures.push('panel did not render')
    throw new Error(`steps failed: ${failures.join(', ')}`)
  }

  // The container VS Code builds: two panes, each with a header.
  if (initial.panes.length !== 2) failures.push(`expected two panes, saw ${initial.panes.length}`)
  if (initial.panes.map((pane) => pane.view).join(',') !== 'changes,graph') {
    failures.push(`panes are ${initial.panes.map((pane) => pane.view).join(',')}, not changes,graph`)
  }
  const titles = initial.panes.map((pane) => pane.title.toLowerCase())
  if (titles[0] !== 'changes' || titles[1] !== 'graph') {
    failures.push(`pane headers read ${JSON.stringify(titles)}, not ["changes","graph"]`)
  }
  if (!initial.panes.every((pane) => pane.expanded)) failures.push('the panes did not start expanded')
  if (initial.toolbar !== 0) failures.push('the panel still draws a container toolbar')
  if (initial.repositoryRow !== 0) failures.push('the panel still draws a repository row')
  if (!initial.hasInput) failures.push('the Changes pane has no commit input')
  if (!initial.inputPlaceholder.includes('to commit')) failures.push('the commit input lost its placeholder')
  if (!initial.headerActions.includes('Refresh')) failures.push('the pane headers lost the Refresh action')
  if (initial.changeRows === 0) failures.push('the Changes pane lists no files')

  // The sash is a 4px hit strip floated over the boundary: it must not consume a
  // row of its own, or the panes stop adding up to the column.
  if (initial.sash === null) failures.push('the sash is gone')
  else if (initial.sash.height !== 4) failures.push(`the sash hit strip is ${initial.sash.height}px, not 4px`)

  const sums = (state) => state.panes.reduce((sum, pane) => sum + pane.box.height, 0)
  if (initial.sash !== null && Math.abs(sums(initial) - initial.container.height) > 2) {
    failures.push(`the panes add up to ${sums(initial)}px in a ${initial.container.height}px column`)
  }

  await check('panel screenshot', async () => {
    // Resting state: hover is part of the look here, so the pointer is parked
    // before the shot rather than left on whatever was clicked last.
    await driver.park()
    await driver.sleep(200)
    return driver.shot('panel', initial.panel)
  })

  // The header's menu has to escape the 22px bar it hangs from: this panel's
  // popovers are ordinary DOM inside their anchor, where VS Code's are an
  // overlay layer, so a clipped header would cut the dropdown off.
  await check('the header menu opens clear of its header', async () => {
    await driver.hover(`${CHANGES} ${HEADER}`)
    await waitFor(
      `getComputedStyle(document.querySelector(${JSON.stringify(`${CHANGES} .dsh-scm-actions`)})).display !== 'none'`,
      'the header actions to appear on hover',
    )
    await driver.click({ selector: `${CHANGES} .dsh-scm-action[title="More Actions…"]` })
    await waitFor(`document.querySelector('.dsh-scm-menu') !== null`, 'the menu to open')
    const menu = await driver.rect('.dsh-scm-menu')
    const header = await driver.rect(`${CHANGES} ${HEADER}`)
    if (menu === null) throw new Error('the menu did not open')
    if (menu.height < 80) throw new Error(`the menu is only ${menu.height}px tall, so it is being clipped`)
    if (menu.top < header.bottom) throw new Error('the menu opened over its own header rather than below it')
    // Drive an item so the menu is not merely painted: Collapse All folds every
    // group away, Expand All brings them back. The item must not also reach the
    // header it hangs from, which folds the whole pane.
    await driver.click({ text: 'Collapse All' })
    await waitFor(
      `document.querySelectorAll('.dsh-scm-group .dsh-scm-row').length === 0`,
      'Collapse All to fold every row',
    )
    const expanded = await driver.probe(
      `document.querySelector(${JSON.stringify(CHANGES)}).getAttribute('data-expanded')`,
    )
    if (expanded !== 'true') throw new Error('a menu item folded the pane its own header belongs to')
    await driver.hover(`${CHANGES} ${HEADER}`)
    await driver.click({ selector: `${CHANGES} .dsh-scm-action[title="More Actions…"]` })
    await waitFor(`document.querySelector('.dsh-scm-menu') !== null`, 'the menu to reopen')
    await driver.click({ text: 'Expand All' })
    await waitFor(
      `document.querySelectorAll('.dsh-scm-group .dsh-scm-row').length === ${initial.changeRows}`,
      'Expand All to bring every row back',
    )
    return { menu: { top: Math.round(menu.top), height: Math.round(menu.height) } }
  })

  // The reported bug: folding the Graph leaves the freed room to the Changes
  // pane, so the folded header ends up at the bottom of the column rather than
  // floating above a blank gap.
  await check('fold the Graph from its header', async () => {
    await driver.click({ selector: `${GRAPH} ${HEADER}` })
    await waitFor(`document.querySelector(${JSON.stringify(GRAPH)}).getBoundingClientRect().height <= 23`, 'the Graph to fold')
    await driver.sleep(300)
    const folded = await driver.probe(LAYOUT)
    const graph = folded.panes[1]
    const changes = folded.panes[0]
    if (folded.commitRows !== 0) throw new Error(`the folded Graph still rendered ${folded.commitRows} rows`)
    if (graph.box.height !== 22) throw new Error(`the folded Graph is ${graph.box.height}px tall, not its 22px header`)
    if (Math.abs(graph.box.bottom - folded.container.bottom) > 2) {
      throw new Error(`the folded header sits at ${graph.box.bottom}, not at the bottom ${folded.container.bottom}`)
    }
    if (Math.abs(changes.box.height - (folded.container.height - 22)) > 2) {
      throw new Error(`the Changes pane took ${changes.box.height}px of ${folded.container.height - 22}px`)
    }
    if (!folded.sashDisabled) throw new Error('the sash stayed draggable beside a folded pane')
    await driver.park()
    await driver.sleep(200)
    await driver.shot('graph-folded', folded.panel)
    return { graph: graph.box, changes: changes.box.height, container: folded.container.height }
  })

  // Unfolding restores the split that was there before, because folding never
  // touches the remembered share.
  await check('unfold the Graph', async () => {
    await driver.click({ selector: `${GRAPH} ${HEADER}` })
    await waitFor(`document.querySelector(${JSON.stringify(GRAPH)}).getBoundingClientRect().height > 23`, 'the Graph to unfold')
    await driver.sleep(300)
    const unfolded = await driver.probe(LAYOUT)
    if (Math.abs(unfolded.panes[1].box.height - initial.panes[1].box.height) > 2) {
      throw new Error(
        `the Graph came back at ${unfolded.panes[1].box.height}px, not the ${initial.panes[1].box.height}px it had`,
      )
    }
    if (unfolded.sashDisabled) throw new Error('the sash stayed disabled once both panes were back')
    return unfolded.panes.map((pane) => pane.box.height)
  })

  // The other direction: folding Changes hands the whole column to the Graph.
  await check('fold the Changes pane', async () => {
    await driver.click({ selector: `${CHANGES} ${HEADER}` })
    await waitFor(`document.querySelector(${JSON.stringify(CHANGES)}).getBoundingClientRect().height <= 23`, 'Changes to fold')
    await driver.sleep(300)
    const folded = await driver.probe(LAYOUT)
    if (folded.changeRows !== 0) throw new Error('the folded Changes pane still lists files')
    if (folded.panes[0].box.height !== 22) throw new Error(`the folded Changes pane is ${folded.panes[0].box.height}px tall`)
    if (Math.abs(folded.panes[1].box.height - (folded.container.height - 22)) > 2) {
      throw new Error(`the Graph took ${folded.panes[1].box.height}px of ${folded.container.height - 22}px`)
    }
    // The README's second image: the Graph on its own, with Changes folded away.
    await driver.park()
    await driver.sleep(200)
    await driver.shot('graph', folded.panel)
    await driver.click({ selector: `${CHANGES} ${HEADER}` })
    await waitFor(`document.querySelector(${JSON.stringify(CHANGES)}).getBoundingClientRect().height > 23`, 'Changes to unfold')
    await driver.sleep(300)
    return driver.probe(LAYOUT).then((state) => state.panes.map((pane) => pane.box.height))
  })

  // Dragging the sash moves the boundary and nothing else: the pane above grows
  // by the drag, the one below gives the same pixels up.
  await check('drag the sash', async () => {
    const before = await driver.probe(LAYOUT)
    await driver.drag(SASH, 0, 80)
    await driver.sleep(300)
    const after = await driver.probe(LAYOUT)
    const grew = after.panes[0].box.height - before.panes[0].box.height
    const shrank = before.panes[1].box.height - after.panes[1].box.height
    if (Math.abs(grew - 80) > 6) throw new Error(`an 80px drag grew the Changes pane by ${grew}px`)
    if (Math.abs(grew - shrank) > 2) throw new Error(`the drag grew one pane by ${grew}px and shrank the other by ${shrank}px`)
    if (Math.abs(sums(after) - after.container.height) > 2) {
      throw new Error(`the panes add up to ${sums(after)}px after a drag, in a ${after.container.height}px column`)
    }
    return { grew, shrank }
  })

  // VS Code's sash resets the two panes to half each on a double click.
  await check('double click the sash', async () => {
    await driver.doubleClick(SASH)
    await driver.sleep(300)
    const reset = await driver.probe(LAYOUT)
    const [changes, graph] = reset.panes.map((pane) => pane.box.height)
    if (Math.abs(changes - graph) > 2) throw new Error(`a reset left ${changes}px above and ${graph}px below`)
    return { changes, graph }
  })

  // Opening a diff re-arranges the column — the panel moves to a new pane and
  // the diff takes the pane it came from — which is the unmount path that has
  // taken the whole right column down before. A clean run proves no body threw
  // while React tore it down, and the shot is the README's panel image.
  await check('open a diff beside the panel', async () => {
    // A binary file compares to an empty editor, so the shot wants a text one;
    // the first row is the fallback for a repository that has none.
    const index = await driver.probe(`(() => {
      const rows = [...document.querySelectorAll('.dsh-scm-row')]
      const path = (node) => (node.getAttribute('title') || '').split(' • ')[0]
      const found = rows.findIndex((node) => /\\.(ts|tsx|js|mjs|json|css|md|txt|html|yml|yaml)$/i.test(path(node)))
      return found === -1 ? 0 : found
    })()`)
    await driver.click({ selector: '.dsh-scm-row', index })
    await waitFor(`document.querySelector('.monaco-diff-editor') !== null`, 'the Monaco diff to mount')
    // The panel is a new tab in the pane the diff did not take, so it re-reads
    // the repository from scratch before the README shot is worth taking.
    await waitFor(
      `document.querySelectorAll('.dsh-scm-group .dsh-scm-row').length > 0`,
      'the panel beside the diff to re-read the repository',
    )
    await driver.sleep(2500)
    const after = await driver.probe(LAYOUT)
    if (after === null || after.panes.length !== 2) throw new Error('the panel did not survive the diff opening')
    await driver.park()
    await driver.sleep(200)
    return driver.shot('panel-full')
  })

  if (failures.length > 0) {
    // The trace carries each step's error; print it, because a run that fails
    // otherwise reports nothing but the names of the checks that failed.
    console.error(JSON.stringify(trace, null, 2))
    throw new Error(`steps failed: ${failures.join(', ')}`)
  }
  return trace
}
