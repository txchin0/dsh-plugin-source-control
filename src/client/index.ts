import * as React from 'react'
import '@vscode/codicons/dist/codicon.css'
import './scm.css'
import {
  DIFF_ADDRESS,
  DIFF_ID,
  DIFF_KIND,
  DIFF_PATTERN,
  PANEL_ID,
  PANEL_KIND,
} from '../shared/routes.ts'
import { DiffBody } from './DiffBody.tsx'
import type { OpenDiffRequest } from './SourceControlBody.tsx'
import { SourceControlBody } from './SourceControlBody.tsx'
import { DiffTitle, SourceControlTitle } from './titles.tsx'

/**
 * The stylesheet installer the client bundle wraps around this module.
 *
 * `build.mjs` emits the bundled CSS as a string and provides this symbol, so
 * the stylesheet is owned by the same effect that owns everything else and
 * leaves with the plugin.
 */
declare const __dshInstallStyles: (() => () => void) | undefined

/** Client services this plugin cannot work without. */
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'theme']

/** The host service faces this module calls, read lazily so a late mount works. */
interface ClientContext {
  get(name: string): unknown
  on(name: string, listener: () => void): () => void
  effect(callback: () => () => void, label?: string): () => void
  sidebarRightTabs: { register(definition: TabDefinition): () => void }
  slots: {
    inject(key: string, callback: () => () => void): () => void
    register(options: SlotRegistration, component: React.ComponentType<never>): () => void
  }
}

/** One tab type's static declaration. */
interface TabDefinition {
  id: string
  kind: string
  patterns?: readonly string[]
  priority?: 'extension' | 'builtin' | 'fallback'
  title: (address: string) => string
  guide?: readonly {
    order: number
    title: () => string
    description?: () => string
  }[]
}

/** One keyed seat registration. */
interface SlotRegistration {
  name: string
  key: string
  /**
   * The Slot-standard injected-face factory: the runtime calls it with the
   * seat's session and bound actions, and its result is merged into the
   * component's props.
   */
  inject?: (sessionId: string, actions: unknown) => Record<string, unknown>
}

/** The right Sidebar's navigation controller, as this plugin uses it. */
interface SidebarRightFace {
  openResource(
    address: string,
    options?: { kind?: string; paneId?: string; params?: Record<string, unknown> },
  ): void
  openTab(kind: string, options?: { paneId?: string }): void
  close(tabId: string): void
  split(paneId?: string): string | undefined
}

/** The theme service, as this plugin uses it. */
interface ThemeFace {
  getTheme(): { active: { colorScheme: string } }
}

/** Read the active colour scheme without subscribing. */
function readScheme(ctx: ClientContext): 'light' | 'dark' {
  const theme = ctx.get('theme') as ThemeFace | undefined
  if (theme === undefined) return 'dark'
  try {
    return theme.getTheme().active.colorScheme === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/** A hook the panel bodies call to follow the active colour scheme. */
function createColorSchemeHook(ctx: ClientContext): () => 'light' | 'dark' {
  return function useColorScheme(): 'light' | 'dark' {
    const [scheme, setScheme] = React.useState(() => readScheme(ctx))
    React.useEffect(() => ctx.on('theme/change', () => setScheme(readScheme(ctx))), [])
    return scheme
  }
}

/**
 * Build the callback the panel uses to reveal a file's diff.
 *
 * Every diff is recorded at the same address, so a click on a second file
 * re-navigates the tab already on screen with the new file's parameters instead
 * of opening another tab. The first click arranges the column: the panel moves
 * into a new pane to the right and the diff takes the pane the panel came from,
 * so the comparison always sits to the left of the file list.
 * @param ctx - the client context.
 * @returns the opener the panel body calls.
 */
function createDiffOpener(ctx: ClientContext): (request: OpenDiffRequest) => void {
  const leftPaneBySession = new Map<string, string>()

  return (request: OpenDiffRequest): void => {
    const sidebar = ctx.get('sidebarRight') as SidebarRightFace | undefined
    if (sidebar === undefined) return
    const params = {
      path: request.path,
      name: request.name,
      kind: request.kind,
      group: request.group,
      hasIndexChange: request.hasIndexChange,
      ...(request.commit === undefined ? {} : { commit: request.commit }),
    }

    const known = leftPaneBySession.get(request.sessionId)
    if (known !== undefined) {
      try {
        sidebar.openResource(DIFF_ADDRESS, { kind: DIFF_KIND, paneId: known, params })
        return
      } catch {
        leftPaneBySession.delete(request.sessionId)
      }
    }

    const right = sidebar.split(request.paneId)
    if (right !== undefined) {
      try {
        sidebar.openTab(PANEL_KIND, { paneId: right })
        sidebar.openResource(DIFF_ADDRESS, { kind: DIFF_KIND, paneId: request.paneId, params })
        sidebar.close(request.tabId)
        leftPaneBySession.set(request.sessionId, request.paneId)
        return
      } catch {
        // The column refused the arrangement; fall back to a tab beside the panel.
      }
    }

    sidebar.openResource(DIFF_ADDRESS, { kind: DIFF_KIND, paneId: request.paneId, params })
  }
}

/**
 * Register both tab types and their seats.
 * @param ctx - the client context.
 */
export function apply(ctx: ClientContext): void {
  if (typeof __dshInstallStyles === 'function') {
    ctx.effect(() => __dshInstallStyles(), 'source-control: stylesheet')
  }

  const openDiff = createDiffOpener(ctx)
  const useColorScheme = createColorSchemeHook(ctx)

  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: PANEL_ID,
        kind: PANEL_KIND,
        priority: 'extension',
        title: () => 'Source Control',
        guide: [
          {
            order: 20,
            title: () => 'Source Control',
            description: () => 'Review, stage, and commit changes in this workspace.',
          },
        ],
      }),
    'source-control: panel tab type',
  )

  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: DIFF_ID,
        kind: DIFF_KIND,
        patterns: [DIFF_PATTERN],
        priority: 'extension',
        // The chip's live text comes from the title seat below; this is only
        // the fallback captured when the tab is first recorded.
        title: () => 'Diff',
      }),
    'source-control: diff tab type',
  )

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: PANEL_ID,
            inject: () => ({ openDiff, useColorScheme }),
          },
          SourceControlBody as unknown as React.ComponentType<never>,
        ),
      ),
    'source-control: panel body',
  )

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: DIFF_ID,
            inject: () => ({ useColorScheme }),
          },
          DiffBody as unknown as React.ComponentType<never>,
        ),
      ),
    'source-control: diff body',
  )

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab.title', () =>
        ctx.slots.register(
          { name: 'sidebar.right.pane.tab.title', key: PANEL_ID },
          SourceControlTitle as unknown as React.ComponentType<never>,
        ),
      ),
    'source-control: panel title',
  )

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab.title', () =>
        ctx.slots.register(
          { name: 'sidebar.right.pane.tab.title', key: DIFF_ID },
          DiffTitle as unknown as React.ComponentType<never>,
        ),
      ),
    'source-control: diff title',
  )
}
