/**
 * Verifies the commit button's label is legible in both colour schemes.
 *
 * The button fills itself with the theme's brand colour and hardcoded a white
 * label. The brand token is the theme's *foreground* colour — near-black in the
 * light theme and near-white in the dark one — so in the dark theme the label was
 * white on near-white and read as a blank pill. Computed colour is the whole
 * result here, so the check reads it rather than trusting the stylesheet.
 *
 * The dark theme is selected purely by the `data-ds-dark-theme` attribute on
 * `<body>`, so both schemes are measured in one run by toggling it; the theme is
 * restored before the run ends. The button is never clicked, so this cannot stage
 * or commit anything and is safe to point at a repository that matters.
 *
 * Environment:
 *   SCM_SESSION_INDEX  which session row to open, top to bottom (default 0)
 */
export default async function run(driver) {
  const trace = []
  const RIGHT = '[data-slot="rightbar.session"]'
  const sessionIndex = Number(process.env.SCM_SESSION_INDEX ?? 0)

  // The report is only printed when the run succeeds, so progress goes to stderr
  // as it happens: a failed run is exactly when the trace is worth reading.
  const step = async (name, action) => {
    try {
      const result = await action()
      trace.push({ step: name, result })
      process.stderr.write(`ok    ${name}\n`)
      return result
    } catch (error) {
      trace.push({ step: name, error: String(error.message) })
      process.stderr.write(`FAIL  ${name}: ${error.message}\n`)
      throw error
    }
  }

  const failures = []
  // A step may legitimately return nothing, so failure is carried by the throw,
  // never by the shape of the value.
  const check = async (name, action) => {
    try {
      await step(name, action)
    } catch {
      failures.push(name)
    }
  }

  /** Poll a page expression until it is truthy; the panes mount asynchronously. */
  const waitFor = async (name, expression, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await driver.probe(expression)) return true
      if (Date.now() > deadline) throw new Error(`waitFor(${name}) timed out`)
      await driver.sleep(400)
    }
  }

  const waitForClick = async (name, spec, expression) => {
    await waitFor(name, expression)
    return driver.click(spec)
  }

  await check('expand workspaces', async () => {
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

  await check('open session', async () => {
    await waitFor('a session row', `document.querySelectorAll('.YDXeBa_sessionRow').length > ${sessionIndex}`)
    await driver.click({ selector: '.YDXeBa_sessionRow', index: sessionIndex })
    // The conversation header, which owns the reveal control, mounts with it.
    await waitFor('conversation header', `document.querySelector('[data-slot="conversation.session.header"]') !== null`)
  })

  await check('reveal right sidebar', async () => {
    // The right column's slot is `display: contents`, so it always has a 0x0
    // rect: what says "open" is the tab strip it holds.
    const opened = () => driver.probe(`document.querySelectorAll('${RIGHT} [role="tab"]').length > 0`)
    if (await opened()) return 'already open'
    await waitForClick('reveal control', { name: 'Open right sidebar' }, `[...document.querySelectorAll('[aria-label]')].some((n) => n.getAttribute('aria-label') === 'Open right sidebar' && n.offsetParent !== null)`)
    await waitFor('right sidebar open', `document.querySelectorAll('${RIGHT} [role="tab"]').length > 0`)
    return 'revealed'
  })

  await check('open Source Control', async () => {
    await waitFor('Source Control tab', `[...document.querySelectorAll('${RIGHT} *')].some((n) => n.innerText && n.innerText.trim() === 'Source Control')`)
    await driver.click({ text: 'Source Control', within: RIGHT })
    await waitFor('source control panel', `document.querySelector('.dsh-scm-button') !== null || document.querySelector('.dsh-scm') !== null`)
  })

  // A disabled button renders at 45% opacity, which muddies a screenshot but not
  // the computed colours. Clearing the attribute puts the shot on the button a
  // person actually sees once there is something to commit. Nothing is clicked.
  const measure = () => driver.probe(`(() => {
    const luminance = (css) => {
      const parts = (css.match(/[\\d.]+/g) || []).slice(0, 3).map(Number)
      const [r, g, b] = parts.map((value) => {
        const channel = value / 255
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const ratio = (a, b) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100
    }
    const read = (selector) => {
      const node = document.querySelector(selector)
      if (node === null) return null
      const style = getComputedStyle(node)
      return {
        label: node.innerText.trim(),
        background: style.backgroundColor,
        color: style.color,
        borderLeft: style.borderLeftColor,
        opacity: style.opacity,
        contrast: ratio(style.backgroundColor, style.color),
      }
    }
    const button = document.querySelector('.dsh-scm-button')
    if (button !== null) button.disabled = false
    return {
      dark: document.body.hasAttribute('data-ds-dark-theme'),
      button: read('.dsh-scm-button'),
      dropdown: read('.dsh-scm-button-dropdown'),
    }
  })()`)

  const setScheme = (dark) =>
    driver.probe(`(() => {
      document.body.toggleAttribute('data-ds-dark-theme', ${dark})
      return document.body.hasAttribute('data-ds-dark-theme')
    })()`)

  trace.push({ step: 'panel', result: await driver.probe(`(() => {
    const button = document.querySelector('.dsh-scm-button')
    const panel = document.querySelector('.dsh-scm')
    return {
      panelPresent: panel !== null,
      buttonPresent: button !== null,
      label: button === null ? null : button.innerText.trim(),
      disabledBeforeForcing: button === null ? null : button.disabled,
    }
  })()`) })

  const schemes = {}
  const originalDark = await driver.probe(`document.body.hasAttribute('data-ds-dark-theme')`)
  for (const [name, dark] of [['dark', true], ['light', false]]) {
    await check(`measure ${name} scheme`, async () => {
      await setScheme(dark)
      await waitFor(`${name} commit button`, `document.querySelector('.dsh-scm-button') !== null`)
      // Let the panel's own re-render settle before reading computed colour.
      await driver.sleep(600)
      schemes[name] = await measure()
      if (schemes[name].button === null) throw new Error('the button disappeared before it could be measured')
      return { button: schemes[name].button, dropdown: schemes[name].dropdown }
    })

    // A whole-page shot cannot show whether a label is readable, which is the
    // entire question here, so capture the button row itself.
    await check(`screenshot ${name} scheme`, async () => {
      const clip = await driver.probe(`(() => {
        const rect = document.querySelector('.dsh-scm-button-row').getBoundingClientRect()
        const pad = 6
        return {
          x: Math.max(0, rect.left + window.scrollX - pad),
          y: Math.max(0, rect.top + window.scrollY - pad),
          width: rect.width + pad * 2,
          height: rect.height + pad * 2,
        }
      })()`)
      return driver.shot(`commit-button-${name}`, clip)
    })
  }
  trace.push({ step: 'schemes', result: schemes })

  await check('restore scheme', () => setScheme(originalDark))

  // WCAG AA for this text size is 4.5:1 and AAA is 7:1; a filled button should
  // clear AA comfortably. The reported bug measured roughly 1.0:1.
  for (const [name, measured] of Object.entries(schemes)) {
    if (measured?.button == null) {
      failures.push(`${name}: no commit button rendered`)
      continue
    }
    if (!(measured.button.contrast >= 4.5)) {
      failures.push(
        `${name}: label contrast ${measured.button.contrast}:1 (${measured.button.color} on ${measured.button.background})`,
      )
    }
    if (measured.button.label === '') failures.push(`${name}: button has no visible label`)
  }

  if (failures.length > 0) {
    process.stderr.write(`--- trace ---\n${JSON.stringify(trace, null, 2)}\n`)
    throw new Error(`steps failed: ${failures.join('; ')}`)
  }
  return trace
}
