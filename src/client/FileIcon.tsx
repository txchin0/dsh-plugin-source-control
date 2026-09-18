import * as React from 'react'
import { fileIconClasses } from './fileIcons.ts'

/**
 * The icon in front of one file row.
 *
 * The element carries *every* class the path produces, not the winning one:
 * which icon that is falls out of the CSS cascade, because the class list is
 * how VS Code encodes the precedence — a name outranks the longest extension,
 * which outranks the language. Handing the browser the whole list is the port;
 * picking a winner here would be a re-derivation of it.
 *
 * The rules only apply inside a `.show-file-icons` ancestor, which is VS Code's
 * own opt-in for a container whose rows want file icons. `SourceControlBody`
 * puts it on the panel root.
 * @param props - the repository-relative path the icon is for.
 * @returns the icon element, or nothing when the path names no file.
 */
export function FileIcon({ path }: { path: string }): React.ReactElement {
  return <span className={`dsh-scm-row-icon ${fileIconClasses(path).join(' ')}`} aria-hidden="true" />
}
