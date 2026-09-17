import * as React from 'react'

/** One entry in a popover menu. */
export interface MenuItem {
  id: string
  label: string
  icon?: string
  /** Renders a separator above this item. */
  separatorBefore?: boolean
  disabled?: boolean
  danger?: boolean
  checked?: boolean
  run: () => void
}

/** A small popover menu anchored to its parent, closed by an outside press. */
export function Menu({
  items,
  onClose,
  align = 'right',
}: {
  items: readonly MenuItem[]
  onClose: () => void
  align?: 'left' | 'right'
}): React.ReactElement {
  const ref = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [onClose])

  return (
    <div className="dsh-scm-menu" data-align={align} ref={ref} role="menu">
      {items.map((item) => (
        <React.Fragment key={item.id}>
          {item.separatorBefore === true ? <div className="dsh-scm-menu-separator" /> : null}
          <button
            type="button"
            role="menuitem"
            className="dsh-scm-menu-item"
            data-danger={item.danger === true ? 'true' : undefined}
            disabled={item.disabled === true}
            onClick={() => {
              onClose()
              item.run()
            }}
          >
            <span className="dsh-scm-menu-check">
              {item.checked === true ? <i className="codicon codicon-check" /> : null}
            </span>
            {item.icon !== undefined ? <i className={`codicon codicon-${item.icon}`} /> : null}
            <span className="dsh-scm-menu-label">{item.label}</span>
          </button>
        </React.Fragment>
      ))}
    </div>
  )
}

/** Wrap a trigger so its menu positions against it. */
export function MenuAnchor({
  children,
  open,
}: {
  children: React.ReactNode
  open: boolean
}): React.ReactElement {
  return (
    <div className="dsh-scm-menu-anchor" data-open={open ? 'true' : undefined}>
      {children}
    </div>
  )
}
