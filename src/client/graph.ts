/*---------------------------------------------------------------------------------------------
 *  Ported from VS Code's Source Control Graph.
 *
 *  Source: src/vs/workbench/contrib/scm/browser/scmHistory.ts
 *  Copyright (c) Microsoft Corporation. Licensed under the MIT License.
 *
 *  Ported essentially verbatim — the swimlane model (`toISCMHistoryItemViewModelArray`),
 *  the reference ordering, and the SVG builders (`renderSCMHistoryItemGraph` and the draw
 *  helpers). The adaptations are only these:
 *
 *   - `ColorIdentifier` (VS Code's CSS-variable indirection) is replaced by plain colour
 *     strings, because this panel has no theme-colour registry.
 *   - The interfaces are declared here rather than imported from VS Code.
 *   - The SVG is built with `document.createElementNS` directly rather than via `svgElem`.
 *
 *  The detail that matters most is the stroke/fill pairing, which the panel's CSS
 *  completes: every circle is stroked in the row's background colour, and the *last*
 *  circle of a HEAD / incoming / outgoing node is filled with it too. That pairing is
 *  what makes those nodes read as rings instead of discs.
 *--------------------------------------------------------------------------------------------*/

/** Row height of one history item. */
export const SWIMLANE_HEIGHT = 22
/** Horizontal pitch of one swimlane. */
export const SWIMLANE_WIDTH = 11
const SWIMLANE_CURVE_RADIUS = 5
const CIRCLE_RADIUS = 4
const CIRCLE_STROKE_WIDTH = 2

/** `scmGraph.foreground1..5`, cycled for branches that carry no label colour. */
export const GRAPH_COLORS: readonly string[] = ['#FFB000', '#DC267F', '#994F00', '#40B0A6', '#B66DFF']
/** `scmGraph.historyItemRefColor` (chartsBlue): the current, local branch. */
export const HISTORY_ITEM_REF_COLOR = '#3794ff'
/** `scmGraph.historyItemRemoteRefColor` (chartsPurple): a remote-tracking branch. */
export const HISTORY_ITEM_REMOTE_REF_COLOR = '#B180D7'
/** `scmGraph.historyItemBaseRefColor`: a tag or other base reference. */
export const HISTORY_ITEM_BASE_REF_COLOR = '#EA5C00'

/** Synthetic history item ids, as VS Code names them. */
export const INCOMING_CHANGES_ID = 'scm-graph-incoming-changes'
export const OUTGOING_CHANGES_ID = 'scm-graph-outgoing-changes'

/** How a reference is drawn and ordered. */
export type HistoryItemRefKind = 'head' | 'branch' | 'remote' | 'tag'

/** One reference decorating a commit. */
export interface HistoryItemRef {
  id: string
  name: string
  revision?: string | undefined
  color?: string | undefined
  kind?: HistoryItemRefKind | undefined
}

/** One commit, as the graph model consumes it. */
export interface HistoryItem {
  id: string
  parentIds: string[]
  subject: string
  author?: string | undefined
  displayId?: string | undefined
  references?: HistoryItemRef[] | undefined
}

/** One occupied swimlane: the commit it is waiting for, and its colour. */
export interface HistoryItemGraphNode {
  id: string
  color: string
}

/** What a row is: a commit, the checked-out commit, or a synthetic changes row. */
export type HistoryItemKind = 'HEAD' | 'node' | 'incoming-changes' | 'outgoing-changes'

/** One laid-out row: the swimlanes entering and leaving it, and what to draw. */
export interface HistoryItemViewModel {
  historyItem: HistoryItem
  inputSwimlanes: HistoryItemGraphNode[]
  outputSwimlanes: HistoryItemGraphNode[]
  kind: HistoryItemKind
}

/** The colour of a history item's own label, if any of its references carries one. */
function getLabelColorIdentifier(
  historyItem: HistoryItem,
  colorMap: Map<string, string | undefined>,
): string | undefined {
  if (historyItem.id === INCOMING_CHANGES_ID) {
    return HISTORY_ITEM_REMOTE_REF_COLOR
  } else if (historyItem.id === OUTGOING_CHANGES_ID) {
    return HISTORY_ITEM_REF_COLOR
  } else {
    for (const ref of historyItem.references ?? []) {
      const colorIdentifier = colorMap.get(ref.id)
      if (colorIdentifier !== undefined) {
        return colorIdentifier
      }
    }
  }

  return undefined
}

/** Wrap a lane index the way VS Code's `rot` does. */
function rot(value: number, max: number): number {
  return ((value % max) + max) % max
}

/**
 * Build the swimlane model for a commit list.
 *
 * Ported from `toISCMHistoryItemViewModelArray`. Each row carries the swimlanes
 * entering it and the swimlanes leaving it; the renderer needs both to know what
 * passes through, what curves in, and what the node itself continues into.
 * @param historyItems - commits newest first.
 * @param colorMap - reference id to colour, for lanes anchored at a label.
 * @param currentHistoryItemRef - the checked-out commit, drawn as HEAD.
 * @param currentHistoryItemRemoteRef - the upstream commit, for the incoming row.
 * @param currentHistoryItemBaseRef - the merge base, for the outgoing row.
 * @param addIncomingChanges - whether to insert the synthetic incoming row.
 * @param addOutgoingChanges - whether to insert the synthetic outgoing row.
 * @param mergeBase - the common ancestor of HEAD and its upstream.
 * @returns one view model per row, newest first.
 */
export function toHistoryItemViewModels(
  historyItems: readonly HistoryItem[],
  colorMap = new Map<string, string | undefined>(),
  currentHistoryItemRef?: HistoryItemRef | undefined,
  currentHistoryItemRemoteRef?: HistoryItemRef | undefined,
  currentHistoryItemBaseRef?: HistoryItemRef | undefined,
  addIncomingChanges?: boolean,
  addOutgoingChanges?: boolean,
  mergeBase?: string | undefined,
): HistoryItemViewModel[] {
  let colorIndex = -1
  const viewModels: HistoryItemViewModel[] = []

  for (const historyItem of historyItems) {
    const kind: HistoryItemKind = historyItem.id === currentHistoryItemRef?.revision ? 'HEAD' : 'node'
    const outputSwimlanesFromPreviousItem = viewModels.at(-1)?.outputSwimlanes ?? []
    const inputSwimlanes = outputSwimlanesFromPreviousItem.map((node) => ({ ...node }))
    const outputSwimlanes: HistoryItemGraphNode[] = []

    let firstParentAdded = false

    // Add first parent to the output
    if (historyItem.parentIds.length > 0) {
      for (const node of inputSwimlanes) {
        if (node.id === historyItem.id) {
          if (!firstParentAdded) {
            outputSwimlanes.push({
              id: historyItem.parentIds[0],
              color: getLabelColorIdentifier(historyItem, colorMap) ?? node.color,
            })
            firstParentAdded = true
          }

          continue
        }

        outputSwimlanes.push({ ...node })
      }
    }

    // Add unprocessed parent(s) to the output
    for (let i = firstParentAdded ? 1 : 0; i < historyItem.parentIds.length; i++) {
      let colorIdentifier: string | undefined

      if (i === 0) {
        colorIdentifier = getLabelColorIdentifier(historyItem, colorMap)
      } else {
        const historyItemParent = historyItems.find((item) => item.id === historyItem.parentIds[i])
        colorIdentifier = historyItemParent ? getLabelColorIdentifier(historyItemParent, colorMap) : undefined
      }

      if (!colorIdentifier) {
        colorIndex = rot(colorIndex + 1, GRAPH_COLORS.length)
        colorIdentifier = GRAPH_COLORS[colorIndex]
      }

      outputSwimlanes.push({ id: historyItem.parentIds[i], color: colorIdentifier })
    }

    // Add colours to references
    const references = (historyItem.references ?? []).map((ref) => {
      let color = colorMap.get(ref.id)
      if (colorMap.has(ref.id) && color === undefined) {
        const inputIndex = inputSwimlanes.findIndex((node) => node.id === historyItem.id)
        const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length
        color =
          circleIndex < outputSwimlanes.length
            ? outputSwimlanes[circleIndex].color
            : circleIndex < inputSwimlanes.length
              ? inputSwimlanes[circleIndex].color
              : HISTORY_ITEM_REF_COLOR
      }

      return { ...ref, color }
    })

    references.sort((ref1, ref2) =>
      compareHistoryItemRefs(ref1, ref2, currentHistoryItemRef, currentHistoryItemRemoteRef, currentHistoryItemBaseRef),
    )

    viewModels.push({
      historyItem: { ...historyItem, references },
      kind,
      inputSwimlanes,
      outputSwimlanes,
    })
  }

  addIncomingOutgoingChangesHistoryItems(
    viewModels,
    currentHistoryItemRef,
    currentHistoryItemRemoteRef,
    addIncomingChanges,
    addOutgoingChanges,
    mergeBase,
  )

  return viewModels
}

/**
 * Order references the way VS Code does: current, then remote, then base, then
 * anything else that has a colour.
 * @param ref1 - the first reference.
 * @param ref2 - the second reference.
 * @param currentHistoryItemRef - the local branch reference.
 * @param currentHistoryItemRemoteRef - the remote reference.
 * @param currentHistoryItemBaseRef - the base reference.
 * @returns a comparator result.
 */
export function compareHistoryItemRefs(
  ref1: HistoryItemRef,
  ref2: HistoryItemRef,
  currentHistoryItemRef?: HistoryItemRef,
  currentHistoryItemRemoteRef?: HistoryItemRef,
  currentHistoryItemBaseRef?: HistoryItemRef,
): number {
  const order = (ref: HistoryItemRef): number => {
    if (ref.id === currentHistoryItemRef?.id) {
      return 1
    } else if (ref.id === currentHistoryItemRemoteRef?.id) {
      return 2
    } else if (ref.id === currentHistoryItemBaseRef?.id) {
      return 3
    } else if (ref.color !== undefined) {
      return 4
    }

    return 99
  }

  return order(ref1) - order(ref2)
}

/** Find the last index whose value satisfies a predicate. */
function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index
  }
  return -1
}

/**
 * Insert the synthetic Incoming and Outgoing Changes rows.
 *
 * Ported from `addIncomingOutgoingChangesHistoryItems`. These rows are built after
 * the real ones precisely so they can borrow the swimlanes the real rows already
 * computed — the state just before the merge base, and just above HEAD — which is
 * what makes them land in the right column.
 */
function addIncomingOutgoingChangesHistoryItems(
  viewModels: HistoryItemViewModel[],
  currentHistoryItemRef?: HistoryItemRef,
  currentHistoryItemRemoteRef?: HistoryItemRef,
  addIncomingChanges?: boolean,
  addOutgoingChanges?: boolean,
  mergeBase?: string,
): void {
  const local = currentHistoryItemRef
  const remote = currentHistoryItemRemoteRef

  // The original's guard is `local?.revision !== remote?.revision`: equal
  // revisions — including both being absent — mean there is nothing between
  // them to show. Each block below then re-guards what it actually needs.
  if (local?.revision === remote?.revision || mergeBase === undefined) return

  // Incoming changes node
  if (addIncomingChanges && remote?.revision !== undefined && remote.revision !== mergeBase) {
    const beforeHistoryItemIndex = findLastIndex(viewModels, (vm) =>
      vm.outputSwimlanes.some((node) => node.id === mergeBase),
    )
    const afterHistoryItemIndex = viewModels.findIndex((vm) => vm.historyItem.id === mergeBase)

    if (beforeHistoryItemIndex !== -1 && afterHistoryItemIndex !== -1) {
      // The incoming changes may already have been merged; VS Code suppresses the
      // row in that case rather than drawing a second edge into the merge base.
      const incomingChangeMerged =
        viewModels[beforeHistoryItemIndex].historyItem.parentIds.length === 2 &&
        viewModels[beforeHistoryItemIndex].historyItem.parentIds.includes(mergeBase)

      if (!incomingChangeMerged) {
        // Re-point the swimlanes that waited for the merge base at the new row
        const before = viewModels[beforeHistoryItemIndex]
        viewModels[beforeHistoryItemIndex] = {
          ...before,
          inputSwimlanes: before.inputSwimlanes.map((node) =>
            node.id === mergeBase && node.color === HISTORY_ITEM_REMOTE_REF_COLOR
              ? { ...node, id: INCOMING_CHANGES_ID }
              : node,
          ),
          outputSwimlanes: before.outputSwimlanes.map((node) =>
            node.id === mergeBase && node.color === HISTORY_ITEM_REMOTE_REF_COLOR
              ? { ...node, id: INCOMING_CHANGES_ID }
              : node,
          ),
        }

        const inputSwimlanes = viewModels[beforeHistoryItemIndex].outputSwimlanes.map((node) => ({ ...node }))
        const outputSwimlanes = viewModels[afterHistoryItemIndex].inputSwimlanes.map((node) => ({ ...node }))
        const displayIdLength = viewModels[0].historyItem.displayId?.length ?? 0

        viewModels.splice(afterHistoryItemIndex, 0, {
          historyItem: {
            id: INCOMING_CHANGES_ID,
            displayId: '0'.repeat(displayIdLength),
            parentIds: [mergeBase],
            author: remote.name,
            subject: 'Incoming Changes',
          },
          kind: 'incoming-changes',
          inputSwimlanes,
          outputSwimlanes,
        })
      }
    }
  }

  // Outgoing changes node
  if (addOutgoingChanges && local?.revision !== undefined && local.revision !== mergeBase) {
    const currentHistoryItemRefIndex = viewModels.findIndex(
      (vm) => vm.kind === 'HEAD' && vm.historyItem.id === local.revision,
    )

    if (currentHistoryItemRefIndex !== -1) {
      const inputSwimlanes = viewModels[currentHistoryItemRefIndex].inputSwimlanes.slice(0)
      const outputSwimlanes = inputSwimlanes
        .slice(0)
        .concat({ id: local.revision, color: HISTORY_ITEM_REF_COLOR })

      viewModels.splice(currentHistoryItemRefIndex, 0, {
        historyItem: {
          id: OUTGOING_CHANGES_ID,
          displayId: viewModels[0].historyItem.displayId
            ? '0'.repeat(viewModels[0].historyItem.displayId.length)
            : undefined,
          parentIds: [local.revision],
          author: local.name,
          subject: 'Outgoing Changes',
        },
        kind: 'outgoing-changes',
        inputSwimlanes,
        outputSwimlanes,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// SVG builders
// ---------------------------------------------------------------------------

/** A stroked, unfilled path in a lane's colour. */
function createPath(color: string, strokeWidth = 1): SVGPathElement {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke-width', `${strokeWidth}px`)
  path.setAttribute('stroke-linecap', 'round')
  path.style.stroke = color

  return path
}

/**
 * One circle of a node.
 *
 * A colour makes it a filled disc; without one it is left to the panel's CSS,
 * which is where the hole at the centre of a HEAD or incoming/outgoing node
 * comes from.
 */
function drawCircle(index: number, radius: number, strokeWidth: number, color?: string): SVGCircleElement {
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  circle.setAttribute('cx', `${SWIMLANE_WIDTH * (index + 1)}`)
  circle.setAttribute('cy', `${SWIMLANE_WIDTH}`)
  circle.setAttribute('r', `${radius}`)

  circle.style.strokeWidth = `${strokeWidth}px`
  if (color) {
    circle.style.fill = color
  }

  return circle
}

/** The dashed ring that marks the synthetic Incoming and Outgoing rows. */
function drawDashedCircle(index: number, strokeWidth: number, color: string): SVGCircleElement {
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  circle.setAttribute('cx', `${SWIMLANE_WIDTH * (index + 1)}`)
  circle.setAttribute('cy', `${SWIMLANE_WIDTH}`)
  circle.setAttribute('r', `${CIRCLE_RADIUS + 1}`)

  circle.style.stroke = color
  circle.style.strokeWidth = `${strokeWidth}px`
  circle.style.strokeDasharray = '4,2'

  return circle
}

/** A vertical run of a lane through one row. */
function drawVerticalLine(x1: number, y1: number, y2: number, color: string, strokeWidth = 1): SVGPathElement {
  const path = createPath(color, strokeWidth)
  path.setAttribute('d', `M ${x1} ${y1} V ${y2}`)

  return path
}

/** The last lane index whose node names an id, or -1. */
function findLastLaneIndex(nodes: readonly HistoryItemGraphNode[], id: string): number {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (nodes[index].id === id) return index
  }
  return -1
}

/**
 * Draw one row's share of the graph.
 *
 * Ported from `renderSCMHistoryItemGraph`: the shapes, their order, and the
 * construction of each node's circles are the original's; only the colour
 * plumbing differs.
 * @param viewModel - the laid-out row.
 * @returns the row's SVG element.
 */
export function renderHistoryItemGraph(viewModel: HistoryItemViewModel): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.classList.add('graph')

  const historyItem = viewModel.historyItem
  const inputSwimlanes = viewModel.inputSwimlanes
  const outputSwimlanes = viewModel.outputSwimlanes

  // Find the history item in the input swimlanes
  const inputIndex = inputSwimlanes.findIndex((node) => node.id === historyItem.id)

  // Circle index - use the input swimlane index if present, otherwise add it to the end
  const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length

  // Circle color - use the output swimlane color if present, otherwise the input swimlane color
  const circleColor =
    circleIndex < outputSwimlanes.length
      ? outputSwimlanes[circleIndex].color
      : circleIndex < inputSwimlanes.length
        ? inputSwimlanes[circleIndex].color
        : HISTORY_ITEM_REF_COLOR

  let outputSwimlaneIndex = 0
  for (let index = 0; index < inputSwimlanes.length; index++) {
    const color = inputSwimlanes[index].color

    // Current commit
    if (inputSwimlanes[index].id === historyItem.id) {
      // Base commit
      if (index !== circleIndex) {
        const d: string[] = []
        const path = createPath(color)

        // Draw /
        d.push(`M ${SWIMLANE_WIDTH * (index + 1)} 0`)
        d.push(`A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * index} ${SWIMLANE_WIDTH}`)

        // Draw -
        d.push(`H ${SWIMLANE_WIDTH * (circleIndex + 1)}`)

        path.setAttribute('d', d.join(' '))
        svg.append(path)
      } else {
        outputSwimlaneIndex++
      }
    } else {
      // Not the current commit
      if (
        outputSwimlaneIndex < outputSwimlanes.length &&
        inputSwimlanes[index].id === outputSwimlanes[outputSwimlaneIndex].id
      ) {
        if (index === outputSwimlaneIndex) {
          // Draw |
          svg.append(drawVerticalLine(SWIMLANE_WIDTH * (index + 1), 0, SWIMLANE_HEIGHT, color))
        } else {
          const d: string[] = []
          const path = createPath(color)

          // Draw |
          d.push(`M ${SWIMLANE_WIDTH * (index + 1)} 0`)
          d.push(`V 6`)

          // Draw /
          d.push(
            `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 1 ${SWIMLANE_WIDTH * (index + 1) - SWIMLANE_CURVE_RADIUS} ${SWIMLANE_HEIGHT / 2}`,
          )

          // Draw -
          d.push(`H ${SWIMLANE_WIDTH * (outputSwimlaneIndex + 1) + SWIMLANE_CURVE_RADIUS}`)

          // Draw /
          d.push(
            `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 0 ${SWIMLANE_WIDTH * (outputSwimlaneIndex + 1)} ${SWIMLANE_HEIGHT / 2 + SWIMLANE_CURVE_RADIUS}`,
          )

          // Draw |
          d.push(`V ${SWIMLANE_HEIGHT}`)

          path.setAttribute('d', d.join(' '))
          svg.append(path)
        }

        outputSwimlaneIndex++
      }
    }
  }

  // Add remaining parent(s)
  for (let i = 1; i < historyItem.parentIds.length; i++) {
    const parentOutputIndex = findLastLaneIndex(outputSwimlanes, historyItem.parentIds[i])
    if (parentOutputIndex === -1) {
      continue
    }

    // Draw -\
    const d: string[] = []
    const path = createPath(outputSwimlanes[parentOutputIndex].color)

    // Draw \
    d.push(`M ${SWIMLANE_WIDTH * parentOutputIndex} ${SWIMLANE_HEIGHT / 2}`)
    d.push(`A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * (parentOutputIndex + 1)} ${SWIMLANE_HEIGHT}`)

    // Draw -
    d.push(`M ${SWIMLANE_WIDTH * parentOutputIndex} ${SWIMLANE_HEIGHT / 2}`)
    d.push(`H ${SWIMLANE_WIDTH * (circleIndex + 1)}`)

    path.setAttribute('d', d.join(' '))
    svg.append(path)
  }

  // Draw | to *
  if (inputIndex !== -1) {
    svg.append(
      drawVerticalLine(SWIMLANE_WIDTH * (circleIndex + 1), 0, SWIMLANE_HEIGHT / 2, inputSwimlanes[inputIndex].color),
    )
  }

  // Draw | from *
  if (historyItem.parentIds.length > 0) {
    svg.append(drawVerticalLine(SWIMLANE_WIDTH * (circleIndex + 1), SWIMLANE_HEIGHT / 2, SWIMLANE_HEIGHT, circleColor))
  }

  // Draw *
  if (viewModel.kind === 'HEAD') {
    // HEAD
    svg.append(drawCircle(circleIndex, CIRCLE_RADIUS + 3, CIRCLE_STROKE_WIDTH, circleColor))
    svg.append(drawCircle(circleIndex, CIRCLE_STROKE_WIDTH, CIRCLE_RADIUS))
  } else if (viewModel.kind === 'incoming-changes' || viewModel.kind === 'outgoing-changes') {
    // Incoming/Outgoing changes
    svg.append(drawCircle(circleIndex, CIRCLE_RADIUS + 3, CIRCLE_STROKE_WIDTH, circleColor))
    svg.append(drawCircle(circleIndex, CIRCLE_RADIUS + 1, CIRCLE_STROKE_WIDTH + 1))
    svg.append(drawDashedCircle(circleIndex, CIRCLE_STROKE_WIDTH - 1, circleColor))
  } else {
    if (historyItem.parentIds.length > 1) {
      // Multi-parent node
      svg.append(drawCircle(circleIndex, CIRCLE_RADIUS + 2, CIRCLE_STROKE_WIDTH, circleColor))
      svg.append(drawCircle(circleIndex, CIRCLE_RADIUS - 1, CIRCLE_STROKE_WIDTH, circleColor))
    } else {
      // Node
      svg.append(drawCircle(circleIndex, CIRCLE_RADIUS + 1, CIRCLE_STROKE_WIDTH, circleColor))
    }
  }

  // Set dimensions
  svg.style.height = `${SWIMLANE_HEIGHT}px`
  svg.style.width = `${SWIMLANE_WIDTH * (Math.max(inputSwimlanes.length, outputSwimlanes.length, 1) + 1)}px`

  return svg
}

/** Compact relative-time units, matching the density of a narrow column. */
const UNITS: readonly { seconds: number; suffix: string }[] = [
  { seconds: 31_536_000, suffix: 'y' },
  { seconds: 2_592_000, suffix: 'mo' },
  { seconds: 604_800, suffix: 'w' },
  { seconds: 86_400, suffix: 'd' },
  { seconds: 3_600, suffix: 'h' },
  { seconds: 60, suffix: 'm' },
]

/**
 * Describe how long ago a commit was authored.
 * @param iso - the author date, ISO 8601.
 * @param now - the instant to measure against, so a render stays pure.
 * @returns a compact label such as `3d`, or the empty string when unparseable.
 */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  for (const unit of UNITS) {
    if (seconds >= unit.seconds) return `${Math.floor(seconds / unit.seconds)}${unit.suffix}`
  }
  return 'now'
}
