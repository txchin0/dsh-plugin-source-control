/**
 * Swimlane-model checks for the Graph section.
 *
 * `src/client/graph.ts` is a port of VS Code's `scmHistory.ts`, so these cases
 * pin the ported behaviour: which lane a commit takes, what each row leaves
 * behind for the next one, and where the synthetic Incoming/Outgoing rows land.
 * A wrong swimlane still draws *something*, which is exactly why it is tested.
 *
 * Run with `pnpm test`; the module is bundled on the fly so the test reads the
 * same source the browser half does.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = path.join(here, '..', 'src', 'client', 'graph.ts')
const stage = await mkdtemp(path.join(tmpdir(), 'scm-graph-'))
const bundled = path.join(stage, 'graph.cjs')
await build({
  entryPoints: [source],
  outfile: bundled,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  logLevel: 'error',
})
const {
  toHistoryItemViewModels,
  HISTORY_ITEM_REF_COLOR,
  HISTORY_ITEM_REMOTE_REF_COLOR,
  GRAPH_COLORS,
  INCOMING_CHANGES_ID,
  OUTGOING_CHANGES_ID,
} = await import(pathToFileURL(bundled).href)

/** A commit as the model consumes it. */
const item = (id, parentIds, refIds = []) => ({
  id,
  parentIds,
  subject: id,
  displayId: id.slice(0, 7),
  references: refIds.map((refId) => ({ id: refId, name: refId, revision: id })),
})

/** Just the fields worth asserting, so a failure reads as a diff. */
const lanes = (viewModels) =>
  viewModels.map((vm) => ({
    id: vm.historyItem.id,
    kind: vm.kind,
    in: vm.inputSwimlanes.map((node) => `${node.id}:${node.color}`),
    out: vm.outputSwimlanes.map((node) => `${node.id}:${node.color}`),
    refs: vm.historyItem.references?.map((ref) => `${ref.name}:${ref.color}`) ?? [],
  }))

const MAIN = { id: 'main', name: 'main', kind: 'branch' }
const UPSTREAM = { id: 'upstream', name: 'upstream', kind: 'remote' }

const cases = [
  {
    name: 'a linear branch keeps one lane, coloured by its label',
    run: () =>
      toHistoryItemViewModels(
        [item('c', ['b'], ['main']), item('b', ['a']), item('a', [])],
        new Map([['main', HISTORY_ITEM_REF_COLOR]]),
        { ...MAIN, revision: 'c' },
        undefined,
        undefined,
        true,
        true,
        undefined,
      ),
    expected: [
      { id: 'c', kind: 'HEAD', in: [], out: [`b:${HISTORY_ITEM_REF_COLOR}`], refs: [`main:${HISTORY_ITEM_REF_COLOR}`] },
      { id: 'b', kind: 'node', in: [`b:${HISTORY_ITEM_REF_COLOR}`], out: [`a:${HISTORY_ITEM_REF_COLOR}`], refs: [] },
      { id: 'a', kind: 'node', in: [`a:${HISTORY_ITEM_REF_COLOR}`], out: [], refs: [] },
    ],
  },
  {
    name: 'a merge gives its second parent a lane of its own',
    run: () =>
      toHistoryItemViewModels(
        [item('m', ['a', 'b'], ['main']), item('a', ['r']), item('b', ['r']), item('r', [])],
        new Map([['main', HISTORY_ITEM_REF_COLOR]]),
        { ...MAIN, revision: 'm' },
        undefined,
        undefined,
        true,
        true,
        undefined,
      ),
    expected: [
      {
        id: 'm',
        kind: 'HEAD',
        in: [],
        out: [`a:${HISTORY_ITEM_REF_COLOR}`, `b:${GRAPH_COLORS[0]}`],
        refs: [`main:${HISTORY_ITEM_REF_COLOR}`],
      },
      {
        id: 'a',
        kind: 'node',
        in: [`a:${HISTORY_ITEM_REF_COLOR}`, `b:${GRAPH_COLORS[0]}`],
        out: [`r:${HISTORY_ITEM_REF_COLOR}`, `b:${GRAPH_COLORS[0]}`],
        refs: [],
      },
      {
        id: 'b',
        kind: 'node',
        in: [`r:${HISTORY_ITEM_REF_COLOR}`, `b:${GRAPH_COLORS[0]}`],
        out: [`r:${HISTORY_ITEM_REF_COLOR}`, `r:${GRAPH_COLORS[0]}`],
        refs: [],
      },
      {
        id: 'r',
        kind: 'node',
        in: [`r:${HISTORY_ITEM_REF_COLOR}`, `r:${GRAPH_COLORS[0]}`],
        out: [],
        refs: [],
      },
    ],
  },
  {
    name: 'commits ahead of the upstream gain an Outgoing Changes row above HEAD',
    run: () =>
      toHistoryItemViewModels(
        [item('c', ['b'], ['main']), item('b', ['a']), item('a', [])],
        new Map([['main', HISTORY_ITEM_REF_COLOR]]),
        { ...MAIN, revision: 'c' },
        { ...UPSTREAM, revision: 'a' },
        undefined,
        true,
        true,
        'a',
      ),
    expected: [
      { id: OUTGOING_CHANGES_ID, kind: 'outgoing-changes', in: [], out: [`c:${HISTORY_ITEM_REF_COLOR}`], refs: [] },
      // HEAD keeps its own (empty) input lanes: the outgoing row above it already
      // drew the edge down to it, and the original does not rewrite this row.
      {
        id: 'c',
        kind: 'HEAD',
        in: [],
        out: [`b:${HISTORY_ITEM_REF_COLOR}`],
        refs: [`main:${HISTORY_ITEM_REF_COLOR}`],
      },
      { id: 'b', kind: 'node', in: [`b:${HISTORY_ITEM_REF_COLOR}`], out: [`a:${HISTORY_ITEM_REF_COLOR}`], refs: [] },
      { id: 'a', kind: 'node', in: [`a:${HISTORY_ITEM_REF_COLOR}`], out: [], refs: [] },
    ],
  },
  {
    name: 'being behind inserts an Incoming Changes row at the merge base',
    run: () =>
      // What the Host half actually loads when the branch is behind: HEAD and the
      // upstream named together, so the upstream tip is in the window.
      toHistoryItemViewModels(
        [
          item('z', ['b'], ['origin/main']),
          item('c', ['b'], ['main']),
          item('b', ['a']),
          item('a', []),
        ],
        new Map([
          ['main', HISTORY_ITEM_REF_COLOR],
          ['origin/main', HISTORY_ITEM_REMOTE_REF_COLOR],
        ]),
        { id: 'main', name: 'main', revision: 'c', kind: 'branch' },
        { id: 'origin/main', name: 'origin/main', revision: 'z', kind: 'remote' },
        undefined,
        true,
        true,
        'b',
      ),
    // Diverged: ahead of the merge base and behind the upstream, so both
    // synthetic rows appear, each anchored on a lane the real rows computed.
    expected: [
      {
        id: 'z',
        kind: 'node',
        in: [],
        out: [`b:${HISTORY_ITEM_REMOTE_REF_COLOR}`],
        refs: [`origin/main:${HISTORY_ITEM_REMOTE_REF_COLOR}`],
      },
      {
        id: OUTGOING_CHANGES_ID,
        kind: 'outgoing-changes',
        in: [`${INCOMING_CHANGES_ID}:${HISTORY_ITEM_REMOTE_REF_COLOR}`],
        out: [`${INCOMING_CHANGES_ID}:${HISTORY_ITEM_REMOTE_REF_COLOR}`, `c:${HISTORY_ITEM_REF_COLOR}`],
        refs: [],
      },
      {
        id: 'c',
        kind: 'HEAD',
        // The merge-base lane re-pointed at the incoming row, which is what lets
        // that row take the lane over below.
        in: [`${INCOMING_CHANGES_ID}:${HISTORY_ITEM_REMOTE_REF_COLOR}`],
        out: [`${INCOMING_CHANGES_ID}:${HISTORY_ITEM_REMOTE_REF_COLOR}`, `b:${HISTORY_ITEM_REF_COLOR}`],
        refs: [`main:${HISTORY_ITEM_REF_COLOR}`],
      },
      {
        id: INCOMING_CHANGES_ID,
        kind: 'incoming-changes',
        in: [`${INCOMING_CHANGES_ID}:${HISTORY_ITEM_REMOTE_REF_COLOR}`, `b:${HISTORY_ITEM_REF_COLOR}`],
        out: [`b:${HISTORY_ITEM_REMOTE_REF_COLOR}`, `b:${HISTORY_ITEM_REF_COLOR}`],
        refs: [],
      },
      {
        id: 'b',
        kind: 'node',
        in: [`b:${HISTORY_ITEM_REMOTE_REF_COLOR}`, `b:${HISTORY_ITEM_REF_COLOR}`],
        // The two lanes waiting for b collapse into the first parent's lane; the
        // surrender is drawn as the row's "base commit" curve, not as an extra lane.
        out: [`a:${HISTORY_ITEM_REMOTE_REF_COLOR}`],
        refs: [],
      },
      {
        id: 'a',
        kind: 'node',
        in: [`a:${HISTORY_ITEM_REMOTE_REF_COLOR}`],
        out: [],
        refs: [],
      },
    ],
  },
  {
    name: 'a branch in step with its upstream gains no synthetic row',
    run: () =>
      toHistoryItemViewModels(
        [item('a', [], ['main'])],
        new Map([['main', HISTORY_ITEM_REF_COLOR]]),
        { ...MAIN, revision: 'a' },
        { ...UPSTREAM, revision: 'a' },
        undefined,
        true,
        true,
        'a',
      ),
    expected: [{ id: 'a', kind: 'HEAD', in: [], out: [], refs: [`main:${HISTORY_ITEM_REF_COLOR}`] }],
  },
  {
    name: 'a remote-tracking label is rendered in the remote colour',
    run: () =>
      toHistoryItemViewModels(
        [item('c', ['b'], ['main']), item('b', ['a'], ['origin/main']), item('a', [])],
        new Map([
          ['main', HISTORY_ITEM_REF_COLOR],
          ['origin/main', HISTORY_ITEM_REMOTE_REF_COLOR],
        ]),
        { ...MAIN, revision: 'c' },
        undefined,
        undefined,
        true,
        true,
        undefined,
      ),
    expected: [
      {
        id: 'c',
        kind: 'HEAD',
        in: [],
        out: [`b:${HISTORY_ITEM_REF_COLOR}`],
        refs: [`main:${HISTORY_ITEM_REF_COLOR}`],
      },
      {
        id: 'b',
        kind: 'node',
        in: [`b:${HISTORY_ITEM_REF_COLOR}`],
        // b carries the remote label, so its first parent's lane takes the remote
        // colour from here on.
        out: [`a:${HISTORY_ITEM_REMOTE_REF_COLOR}`],
        refs: [`origin/main:${HISTORY_ITEM_REMOTE_REF_COLOR}`],
      },
      { id: 'a', kind: 'node', in: [`a:${HISTORY_ITEM_REMOTE_REF_COLOR}`], out: [], refs: [] },
    ],
  },
  {
    name: 'an empty history produces no rows',
    run: () => toHistoryItemViewModels([], new Map(), undefined, undefined, undefined, true, true, undefined),
    expected: [],
  },
]

let failed = 0
for (const testCase of cases) {
  try {
    assert.deepEqual(lanes(testCase.run()), testCase.expected)
    console.log(`ok    ${testCase.name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${testCase.name}\n${error.message}`)
  }
}

// A row must never carry more swimlanes than the SVG reserves space for.
for (const testCase of cases) {
  for (const vm of testCase.run()) {
    const reserved = Math.max(vm.inputSwimlanes.length, vm.outputSwimlanes.length, 1)
    try {
      assert.ok(
        vm.inputSwimlanes.length <= reserved && vm.outputSwimlanes.length <= reserved,
        `${vm.historyItem.id} overflows its swimlanes`,
      )
    } catch (error) {
      failed += 1
      console.log(`FAIL  ${testCase.name}: ${error.message}`)
    }
  }
}

// The synthetic ids must stay the ones the ported model recognises.
assert.equal(INCOMING_CHANGES_ID, 'scm-graph-incoming-changes')
assert.equal(OUTGOING_CHANGES_ID, 'scm-graph-outgoing-changes')

await rm(stage, { recursive: true, force: true })
console.log(failed === 0 ? '\nall graph cases pass' : `\n${failed} graph check(s) failed`)
process.exitCode = failed === 0 ? 0 : 1
