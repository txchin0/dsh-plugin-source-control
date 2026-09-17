/**
 * Values the Host half and the browser half must agree on.
 *
 * This module is imported by both builds, so it may import nothing.
 */

/** Every route this plugin owns lives under this prefix. */
export const ROUTE_PREFIX = '/source-control'

/** The tab kind of the Source Control panel. */
export const PANEL_KIND = 'sourceControl'

/** The tab kind of the diff pane. */
export const DIFF_KIND = 'sourceControlDiff'

/** The panel type's implementation id, and the key its body registers under. */
export const PANEL_ID = 'dsh-plugin-source-control/source-control'

/** The diff type's implementation id, and the key its body registers under. */
export const DIFF_ID = 'dsh-plugin-source-control/diff'

/** Resource address glob the diff type claims. */
export const DIFF_PATTERN = 'dsh-resource://git-diff/**'

/**
 * The one address every diff is recorded at.
 *
 * A resource tab is identified by its address, and opening an address that is
 * already open re-navigates that tab rather than minting a second one. Keeping
 * the address stable is what makes a later file click re-point the diff that is
 * already on screen instead of stacking a new tab per file and tearing the
 * previous one down; the file being compared travels in the navigation params.
 */
export const DIFF_ADDRESS = 'dsh-resource://git-diff/working'

/** Navigation parameters the panel passes to the diff pane. */
export interface DiffNavigation {
  /** Repository-relative path of the file to compare. */
  path: string
  /** The file's last path segment, for the chip and the header. */
  name: string
  /** Which pair of revisions to compare. */
  kind: string
  /** The group the row came from, which refines a deleted file's base. */
  group: string
  /** Whether the file also carries an index-side change. */
  hasIndexChange: boolean
  /** The commit a `commit` comparison is anchored at. */
  commit?: string
}
