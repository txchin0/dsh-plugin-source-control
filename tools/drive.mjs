/**
 * A dependency-free Chrome DevTools Protocol driver for verifying this plugin
 * in a real browser.
 *
 * Static checks cannot see the two failure modes this plugin actually has:
 * a slot body that throws while React unmounts it (which takes the whole right
 * column down), and SVG built imperatively whose computed stroke/fill is the
 * entire visual result. Both are only visible in a live page, so they are
 * checked here.
 *
 * Usage:
 *   node tools/drive.mjs <url-with-token> <stepsFile> [settleMs]
 *
 * Environment:
 *   CDP_PORT  remote-debugging port of the Chrome to attach to (default 9222)
 *   SHOT_DIR  directory `driver.shot(name)` writes to (default the OS temp dir)
 *
 * A steps file default-exports `async (driver) => report`, where `report` is any
 * JSON-serialisable value printed at the end. `driver` offers:
 *
 *   probe(expression)        evaluate JS in the page, returning its value
 *   click({selector|text|name, within?, index?})
 *   drag(selector, dx, dy)   real mouse drag of that element, in pixels
 *   doubleClick(selector)    real double click on that element
 *   hover(selector)          move the pointer onto it, without clicking
 *   park()                   move the pointer out of the way (see below)
 *   rect(selector)           that element's box in device-independent pixels
 *   type(text)               insert text into the focused element
 *   key(key, code, keyCode)  one key down/up pair
 *   sleep(ms)
 *   shot(name, clip?)        screenshot, returns the file path; `clip` is a
 *                            {x,y,width,height} device-independent rect, which is
 *                            how a check proves a *readable* control rather than
 *                            a legible-looking whole page
 *
 * The driver prints every console error and uncaught exception the page
 * produced, which is the whole point: a clean run prints no events section.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [url, stepsFile, settleMs = '5000'] = process.argv.slice(2)
if (url === undefined || stepsFile === undefined) {
  console.error('usage: node tools/drive.mjs <url-with-token> <stepsFile> [settleMs]')
  process.exit(2)
}

const port = process.env.CDP_PORT ?? '9222'
// Screenshots are diagnostics, so they default outside the repo; set SHOT_DIR to
// put them somewhere a step script or a human will look.
const shotDir = process.env.SHOT_DIR ?? path.join(tmpdir(), 'dsh-plugin-source-control-shots')
await mkdir(shotDir, { recursive: true })

let targets
try {
  targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
} catch (error) {
  console.error(
    `Could not reach Chrome on port ${port}. Launch it first, e.g.\n` +
      `  chrome --headless=new --remote-debugging-port=${port} --user-data-dir=<temp> about:blank`,
  )
  throw error
}

const page = targets.find((target) => target.type === 'page')
if (page === undefined) throw new Error(`No page target on port ${port}`)

const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()
const events = []

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id === undefined) {
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = (message.params.args ?? [])
        .map((argument) => argument.value ?? argument.description ?? argument.type)
        .join(' ')
      events.push(`[console.${message.params.type}] ${String(text).slice(0, 400)}`)
    } else if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails
      events.push(`[exception] ${String(details.exception?.description ?? details.text)}`)
    } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      events.push(`[log.error] ${String(message.params.entry.text).slice(0, 600)}`)
    }
    return
  }
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  if (message.error) entry.reject(new Error(message.error.message))
  else entry.resolve(message.result)
})

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) {
    throw new Error(`evaluate threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
  }
  return result.result.value
}

/**
 * Find a visible element by CSS selector, accessible name, or visible text.
 *
 * `selector` and `text`/`name` compose: a selector narrows the candidates and
 * the text filter still applies, so `{ selector: '.x-header', text: 'Graph' }`
 * picks the right one of several. Omitting both matches every visible element.
 * Without an explicit `index`, the innermost match wins, so a click lands on the
 * control rather than the container wrapping it.
 */
const FIND = `
function find(spec) {
  const visible = (node) => node !== null && node.offsetParent !== null && node.getBoundingClientRect().width > 0
  const root = spec.within ? document.querySelector(spec.within) : document
  if (root === null) return null
  const wanted = (spec.name || spec.text || '').toLowerCase()
  const matches = (node) => {
    if (!visible(node)) return false
    if (wanted === '') return true
    const name = (node.getAttribute('aria-label') || node.getAttribute('title') || '').toLowerCase()
    const text = (node.innerText || '').trim().toLowerCase()
    return spec.name ? name.includes(wanted) : text === wanted || text.includes(wanted)
  }
  if (spec.selector) {
    const nodes = [...root.querySelectorAll(spec.selector)].filter(matches)
    if (spec.index !== undefined) return nodes[spec.index] ?? null
    return nodes[0] ?? null
  }
  const candidates = [...root.querySelectorAll('button, [role="button"], [role="tab"], a, [role="treeitem"], [role="menuitem"], li, div')].filter(matches)
  return candidates.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0] ?? null
}
`

const locate = async (spec) =>
  evaluate(`(() => { ${FIND} const node = find(${JSON.stringify(spec)}); if (!node) return null;
    const before = node.getBoundingClientRect();
    // Only scroll when the target is actually off screen: scrolling an element
    // that is already visible moves every scrollable ancestor with it, which
    // shifts the layout a check is in the middle of measuring.
    const offScreen = before.top < 0 || before.left < 0 || before.bottom > window.innerHeight || before.right > window.innerWidth;
    if (offScreen) node.scrollIntoView({ block: 'center' });
    const r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (node.innerText || '').trim().slice(0, 60), label: node.getAttribute('aria-label') || node.getAttribute('title') || '' }; })()`)

/** A real mouse press at a point, so React's synthetic handlers see it. */
const clickAt = async (x, y) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    })
  }
}

/**
 * A real mouse drag, in steps.
 *
 * The moves have to be real input events rather than scripted ones: the panel
 * captures the pointer on press, and `setPointerCapture` needs a pointer the
 * browser considers active, which a synthesised `PointerEvent` is not.
 */
const dragAt = async (from, to, steps = 6) => {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: from.x,
    y: from.y,
    button: 'left',
    clickCount: 1,
    buttons: 1,
  })
  for (let step = 1; step <= steps; step += 1) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + ((to.x - from.x) * step) / steps,
      y: from.y + ((to.y - from.y) * step) / steps,
      button: 'left',
      buttons: 1,
    })
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: to.x,
    y: to.y,
    button: 'left',
    clickCount: 1,
    buttons: 0,
  })
}

/** A real double click at a point, which is how VS Code resets a sash. */
const doubleClickAt = async (x, y) => {
  for (const clickCount of [1, 2]) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        clickCount,
        buttons: type === 'mousePressed' ? 1 : 0,
      })
    }
  }
}

const centreOf = async (selector) =>
  evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    if (node === null) return null
    const r = node.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), width: r.width, height: r.height, top: r.top, bottom: r.bottom }
  })()`)

const driver = {
  evaluate,
  sleep,
  async click(spec) {
    const rect = await locate(spec)
    if (rect === null) throw new Error(`click: no element for ${JSON.stringify(spec)}`)
    await clickAt(rect.x, rect.y)
    return rect
  },
  /** Drag the element matching `selector` by a pixel offset. */
  async drag(selector, dx, dy) {
    const rect = await centreOf(selector)
    if (rect === null) throw new Error(`drag: no element for ${selector}`)
    await dragAt(rect, { x: rect.x + dx, y: rect.y + dy })
    return rect
  },
  async doubleClick(selector) {
    const rect = await centreOf(selector)
    if (rect === null) throw new Error(`doubleClick: no element for ${selector}`)
    await doubleClickAt(rect.x, rect.y)
    return rect
  },
  /**
   * Move the pointer onto an element without clicking it.
   *
   * Needed because hover can be what reveals a control: a pane header keeps its
   * actions hidden until its pane is hovered, so a click aimed at one of those
   * actions would otherwise land on the header behind it.
   */
  async hover(selector) {
    const rect = await centreOf(selector)
    if (rect === null) throw new Error(`hover: no element for ${selector}`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, buttons: 0 })
    return rect
  },
  /**
   * Move the pointer off to a corner.
   *
   * Hover is part of this panel's look — a pane header keeps its actions hidden
   * until its pane is hovered — so a screenshot worth comparing has to be taken
   * with the pointer parked somewhere harmless rather than left wherever the
   * last click put it.
   */
  async park() {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, buttons: 0 })
  },
  rect: centreOf,
  async type(text) {
    await send('Input.insertText', { text })
  },
  async key(key, code, windowsVirtualKeyCode) {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        windowsVirtualKeyCode,
        nativeVirtualKeyCode: windowsVirtualKeyCode,
      })
    }
  },
  async shot(name, clip) {
    const result = await send(
      'Page.captureScreenshot',
      clip === undefined ? { format: 'png' } : { format: 'png', clip: { ...clip, scale: 2 } },
    )
    const file = path.join(shotDir, `${name}.png`)
    await writeFile(file, Buffer.from(result.data, 'base64'))
    return file
  },
  probe: evaluate,
}

await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
await send('Page.navigate', { url })
await sleep(Number(settleMs))

const steps = await import(`file://${path.resolve(stepsFile).replace(/\\/g, '/')}`)
let report
let failure
try {
  report = await steps.default(driver)
} catch (error) {
  // A failed run is exactly when the page events are worth reading, so the
  // steps' error is held back until they have been printed.
  failure = error
}
console.log(JSON.stringify(report ?? null, null, 2))
if (events.length > 0) {
  console.error(`--- page events (${events.length}) ---`)
  for (const line of events.slice(-25)) console.error(line)
  process.exitCode = 1
}
if (failure !== undefined) {
  console.error(failure.stack ?? String(failure))
  process.exitCode = 1
}

socket.close()
