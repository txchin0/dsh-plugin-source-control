/**
 * Source Control for the DeepSeek Harness web client.
 *
 * The Host half owns everything that must touch the repository: it exposes a
 * small JSON surface over the web server and runs git through the subprocess
 * seam. The browser half renders the panel in the right Sidebar and asks this
 * half for every read and every action, so no filesystem or process access is
 * duplicated in the page.
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { installRoutes, type RouteHost } from './host/api.ts'
import type { HostWebServer } from './host/services.ts'
import type { ScmUntrackedMode } from './shared/protocol.ts'

export const name = 'dsh-plugin-source-control'

/** The web carrier is the plugin's whole reason to run. */
export const inject = ['webServer']

/** Plugin configuration, changeable from `cordis.yml`. */
export interface Config {
  /** How untracked files are grouped, mirroring VS Code's `git.untrackedChanges`. */
  untrackedChanges: ScmUntrackedMode
  /** Repository-relative paths never listed. */
  exclude: string[]
}

export const Config: Schema<Config> = Schema.object({
  untrackedChanges: Schema.union(['mixed', 'separate', 'hidden']).default('mixed'),
  exclude: Schema.array(String).default([]),
})

/**
 * Register the plugin's HTTP surface.
 * @param ctx - the Host context; `webServer` is guaranteed by `inject`.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const webServer = ctx.get('webServer') as HostWebServer | undefined
  if (webServer === undefined) return
  ctx.effect(
    () =>
      installRoutes(ctx as unknown as RouteHost, webServer, {
        untrackedChanges: config.untrackedChanges,
        exclude: config.exclude,
      }),
    'source-control: http routes',
  )
}
