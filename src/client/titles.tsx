import * as React from 'react'
import type { DiffNavigation } from '../shared/routes.ts'

/** Props the title seats receive: the tab whose chip is being drawn. */
interface TitleProps {
  useTabInfo: () => { tab: { navigation?: { params?: Partial<DiffNavigation> } } }
}

/** The Source Control chip: the view's own glyph and its name. */
export function SourceControlTitle(): React.ReactElement {
  return (
    <span className="dsh-scm-title">
      <i className="codicon codicon-source-control" />
      <span>Source Control</span>
    </span>
  )
}

/** The diff chip: the glyph plus the file currently being compared. */
export function DiffTitle({ useTabInfo }: TitleProps): React.ReactElement {
  const { tab } = useTabInfo()
  const path = tab.navigation?.params?.path ?? ''
  const name = path === '' ? 'Diff' : (path.split('/').pop() ?? path)
  return (
    <span className="dsh-scm-title">
      <i className="codicon codicon-diff" />
      <span>{name}</span>
    </span>
  )
}
