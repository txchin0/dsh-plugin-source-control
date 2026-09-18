/*
 * A port of VS Code's file icon theme stylesheet generator.
 *
 * Source: `src/vs/workbench/services/themes/browser/fileIconThemeData.ts`,
 * `FileIconThemeLoader.processIconThemeDocument` (MIT, © Microsoft
 * Corporation), together with the `cssValue` helpers it calls.
 *
 * It is ported rather than re-derived for the reason AGENTS.md gives for the
 * graph: the whole behaviour of a file icon theme is a CSS cascade, and the
 * cascade is decided by class *counts*. A `.name-file-icon` rule carries one
 * more class than a `.ext-file-icon` rule, which carries one more than a
 * `.lang-file-icon` rule, so the browser picks the name over the extension over
 * the language — and the longest extension over a shorter one. Rewriting that
 * as a lookup table means re-deriving the precedence by hand, which is how the
 * first version of the graph got its lanes wrong.
 *
 * Two adaptations, both deliberate, and the port is otherwise line for line:
 *
 *   - The qualifier is the caller's. VS Code roots every rule at
 *     `.show-file-icons` and qualifies the light theme's copy with `.vs`, one
 *     class more, so both sets match in a light theme and the light one wins.
 *     This plugin's light scheme is an attribute on the panel
 *     (`.dsh-scm[data-scheme='light']`), which is likewise one step more
 *     specific than the unqualified dark root — the same trick, expressed in
 *     the markup this panel already has.
 *   - The font is inlined. VS Code resolves each `fonts[].src[].path` against
 *     the extension's directory; the plugin ships the one font its theme needs
 *     inside the bundle, so the data URL stands in for every source path.
 *
 * Not ported, each because `vs-seti-icon-theme.json` never reaches it:
 *
 *   - the `folder`, `folderExpanded`, `rootFolder`, `folderNames` and
 *     `rootFolderNames` associations. Seti declares none of them, and the panel
 *     is a list, not a tree, so there are no folder rows to draw.
 *   - the `highContrast` associations, which Seti does not declare.
 *   - the `iconPath` definition form (`theme-modern-icons` uses it), which
 *     needs a path to resolve against and a `mask` to follow the text colour.
 *   - the trailing language-mode fallback, which asks the language registry for
 *     an icon per language. This plugin has no such registry; Seti covers its
 *     languages through `languageIds` and `fileExtensions`.
 */

/** One entry of the theme's `iconDefinitions`. */
export interface FileIconDefinition {
  /** The glyph, as a CSS escape (`"\\E001"`), in the theme's font. */
  fontCharacter?: string
  /** `#rrggbb`, baked into the theme for both schemes. */
  fontColor?: string
  fontId?: string
  fontSize?: string
  /** An SVG or PNG, used by themes that are not font based. */
  iconPath?: string
}

/** The associations one scheme declares. */
export interface FileIconAssociations {
  /** The icon every file falls back to. */
  file?: string
  fileExtensions?: Record<string, string>
  fileNames?: Record<string, string>
  languageIds?: Record<string, string>
}

/** A whole VS Code file icon theme document. */
export interface FileIconThemeDocument extends FileIconAssociations {
  fonts?: {
    id: string
    src: { path: string; format: string }[]
    weight?: string
    style?: string
    size?: string
  }[]
  iconDefinitions?: Record<string, FileIconDefinition>
  /** The overrides a light theme uses, of the same shape as the root. */
  light?: FileIconAssociations
  highContrast?: FileIconAssociations
  showLanguageModeIcons?: boolean
}

/** Where the generated rules are allowed to apply. */
export interface FileIconQualifiers {
  /** The panel root in the default (dark) scheme. */
  dark: string
  /** The panel root in the light scheme — one step more specific, so it wins. */
  light: string
}

/**
 * `CSS.escape`'s algorithm, from CSSOM's "serialize an identifier".
 *
 * VS Code calls the platform `CSS.escape` here. The algorithm is spelled out
 * rather than delegated because these rules are also built under Node, where
 * the browser global does not exist — and a module that behaves differently in
 * a test than it does in the page is not worth having.
 * @param value - the class name to escape for use in a selector.
 * @returns the escaped identifier.
 */
export function cssEscape(value: string): string {
  let out = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const character = value.charAt(index)
    if (code === 0) {
      out += '\uFFFD'
    } else if ((code >= 0x01 && code <= 0x1f) || code === 0x7f) {
      out += `\\${code.toString(16)} `
    } else if (index === 0 && code >= 0x30 && code <= 0x39) {
      out += `\\${code.toString(16)} `
    } else if (index === 1 && code >= 0x30 && code <= 0x39 && value.charCodeAt(0) === 0x2d) {
      out += `\\${code.toString(16)} `
    } else if (index === 0 && code === 0x2d && value.length === 1) {
      out += '\\-'
    } else if (
      code >= 0x80 ||
      code === 0x2d ||
      code === 0x5f ||
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a)
    ) {
      out += character
    } else {
      out += `\\${character}`
    }
  }
  return out
}

/**
 * `fileIconSelectorEscape` from `getIconClasses.ts`: HTML class names cannot
 * hold whitespace, and `/` cannot appear in a file name, so it stands in.
 * @param value - the raw name, extension or language id.
 * @returns the class-name-safe form.
 */
export function fileIconSelectorEscape(value: string): string {
  return value.replace(/[\s]/g, '/')
}

/** `css.className`: a class name as it appears in a selector. */
export function classSelectorPart(value: string): string {
  return cssEscape(fileIconSelectorEscape(value))
}

/** `css.stringValue`: a single-quoted CSS string. */
function stringValue(value: string): string {
  return `'${value.replaceAll("'", '\\000027')}'`
}

/** `css.sizeValue`: everything a font size may contain, and nothing else. */
function sizeValue(value: string): string {
  return value.replaceAll(/[^\w.%+-]/gi, '')
}

/** `css.identValue`: everything a font family or weight may contain. */
function identValue(value: string): string {
  return value.replaceAll(/[^_\-a-z0-9]/gi, '')
}

/** `css.hexColorValue`: everything a hex colour may contain, and nothing else. */
function hexColorValue(value: string): string {
  return value.replaceAll(/[^0-9a-fA-F#]/gi, '')
}

/** `fontColorRegex` from `iconRegistry.ts`. */
const FONT_COLOR = /^#[0-9a-fA-F]{0,6}$/

/** `fontSizeRegex` from `iconRegistry.ts`. */
const FONT_SIZE = /^([\w_.%+-]+)$/

/** The pixel size `tryNormalizeFontSize` converts absolute sizes against. */
const DEFAULT_FONT_SIZE_IN_PX = 13

/**
 * Turn an absolute font size into a relative one, as `tryNormalizeFontSize`
 * does: VS Code's `13px` baseline is the workbench font size, so a theme that
 * writes pixels is expressed as a percentage of whatever the text is.
 * @param size - the size the theme declared, if any.
 * @returns the size to emit, or `undefined` when there is nothing to emit.
 */
function tryNormalizeFontSize(size: string | undefined): string | undefined {
  if (size === undefined || size === '') return undefined
  if (size.endsWith('px')) {
    const value = Number.parseInt(size, 10)
    if (!Number.isNaN(value)) return `${Math.round((value / DEFAULT_FONT_SIZE_IN_PX) * 100)}%`
  }
  return size
}

/**
 * Build the stylesheet for one theme.
 *
 * The rules come out in VS Code's order — the font face, the font family rule,
 * then one rule per icon definition whose selectors are joined in the order the
 * associations were collected (language ids before extensions before names) —
 * and that order is load-bearing for the one case specificity does not settle:
 * when two rules carry the same number of classes, the later one wins.
 * @param theme - the theme document, as shipped.
 * @param fontUrl - the `url()` value for the theme's font.
 * @param qualifiers - the panel selectors the rules apply within.
 * @returns the stylesheet text.
 */
export function fileIconThemeStylesheet(
  theme: FileIconThemeDocument,
  fontUrl: string,
  qualifiers: FileIconQualifiers,
): string {
  const definitions = theme.iconDefinitions
  if (definitions === undefined) return ''

  /** Every selector that reaches one definition, in collection order. */
  const selectorsByDefinition = new Map<string, string[]>()
  let hasFileIcons = false
  let hasSpecificFileIcons = false

  const addSelector = (selector: string, definitionId: string | undefined): void => {
    if (definitionId === undefined || definitionId === '') return
    const selectors = selectorsByDefinition.get(definitionId)
    if (selectors === undefined) selectorsByDefinition.set(definitionId, [selector])
    else selectors.push(selector)
  }

  const collect = (associations: FileIconAssociations | undefined, qualifier: string): void => {
    if (associations === undefined) return

    if (associations.file !== undefined) {
      addSelector(`${qualifier} .file-icon::before`, associations.file)
      hasFileIcons = true
    }

    // Language ids come before extensions come before names, which is the
    // order VS Code collects them in and therefore the order ties are broken.
    for (const [languageId, definitionId] of Object.entries(associations.languageIds ?? {})) {
      addSelector(`${qualifier} .${classSelectorPart(languageId)}-lang-file-icon.file-icon::before`, definitionId)
      hasFileIcons = true
      hasSpecificFileIcons = true
    }

    for (const [extension, definitionId] of Object.entries(associations.fileExtensions ?? {})) {
      const selectors: string[] = []
      const name = handleParentFolder(extension.toLowerCase(), selectors)
      const segments = name.split('.')
      for (let index = 0; index < segments.length; index += 1) {
        selectors.push(`.${classSelectorPart(segments.slice(index).join('.'))}-ext-file-icon`)
      }
      // An extra segment, to raise the rule above a shorter extension's.
      selectors.push('.ext-file-icon')
      addSelector(`${qualifier} ${selectors.join('')}.file-icon::before`, definitionId)
      hasFileIcons = true
      hasSpecificFileIcons = true
    }

    for (const [fileName, definitionId] of Object.entries(associations.fileNames ?? {})) {
      const selectors: string[] = []
      const name = handleParentFolder(fileName.toLowerCase(), selectors)
      selectors.push(`.${classSelectorPart(name)}-name-file-icon`)
      // An extra segment, to raise the rule above an extension's.
      selectors.push('.name-file-icon')
      const segments = name.split('.')
      for (let index = 1; index < segments.length; index += 1) {
        selectors.push(`.${classSelectorPart(segments.slice(index).join('.'))}-ext-file-icon`)
      }
      selectors.push('.ext-file-icon')
      addSelector(`${qualifier} ${selectors.join('')}.file-icon::before`, definitionId)
      hasFileIcons = true
      hasSpecificFileIcons = true
    }
  }

  collect(theme, qualifiers.dark)
  collect(theme.light, qualifiers.light)

  if (!hasFileIcons) return ''

  // Seti does not set this flag, so it takes the same branch VS Code takes for
  // it: the language-mode icons are considered shown. That matters here only
  // for the `background-image: unset` each definition carries, which clears a
  // background a language contribution may have set.
  const showLanguageModeIcons = theme.showLanguageModeIcons === true || (hasSpecificFileIcons && theme.showLanguageModeIcons !== false)

  const rules: string[] = []

  const fonts = theme.fonts
  const fontSizes = new Map<string, string>()
  if (Array.isArray(fonts) && fonts.length > 0) {
    const defaultFontSize = tryNormalizeFontSize(fonts[0].size) ?? '150%'
    for (const font of fonts) {
      const sources = font.src.map((source) => `url(${fontUrl}) format(${stringValue(source.format)})`).join(', ')
      rules.push(
        `@font-face { src: ${sources}; font-family: ${stringValue(font.id)}; ` +
          `font-weight: ${identValue(font.weight ?? 'normal')}; font-style: ${identValue(font.style ?? 'normal')}; ` +
          `font-display: block; }`,
      )
      const fontSize = tryNormalizeFontSize(font.size)
      if (fontSize !== undefined && fontSize !== defaultFontSize) fontSizes.set(font.id, fontSize)
    }
    rules.push(
      `${qualifiers.dark} .file-icon::before { font-family: ${stringValue(fonts[0].id)}; ` +
        `font-size: ${sizeValue(defaultFontSize)}; }`,
    )
  }

  for (const [definitionId, selectors] of selectorsByDefinition) {
    const definition = definitions[definitionId]
    if (definition === undefined) continue
    // A definition with an `iconPath` and neither of the font fields is the
    // form `theme-modern-icons` uses; see the note at the top of the module.
    if (definition.fontCharacter === undefined && definition.fontColor === undefined) continue

    const body: string[] = []
    if (definition.fontColor !== undefined && FONT_COLOR.test(definition.fontColor)) {
      body.push(`color: ${hexColorValue(definition.fontColor)};`)
    }
    if (definition.fontCharacter !== undefined) body.push(`content: ${stringValue(definition.fontCharacter)};`)
    const fontSize = definition.fontSize ?? (definition.fontId === undefined ? undefined : fontSizes.get(definition.fontId))
    if (fontSize !== undefined && FONT_SIZE.test(fontSize)) body.push(`font-size: ${sizeValue(fontSize)};`)
    if (definition.fontId !== undefined) body.push(`font-family: ${stringValue(definition.fontId)};`)
    if (showLanguageModeIcons) body.push('background-image: unset;')

    rules.push(`${selectors.join(', ')} { ${body.join(' ')} }`)
  }

  return rules.join('\n')
}

/**
 * `handleParentFolder`: a theme may qualify an association with the folder it
 * sits in (`folder//name`), which becomes an extra class on the selector.
 * @param key - the association key, lowercased.
 * @param selectors - the selector parts collected so far, appended to.
 * @returns the key with its folder prefix removed.
 */
function handleParentFolder(key: string, selectors: string[]): string {
  const lastIndexOfSlash = key.lastIndexOf('/')
  if (lastIndexOfSlash < 0) return key
  selectors.push(`.${classSelectorPart(key.substring(0, lastIndexOfSlash))}-name-dir-icon`)
  return key.substring(lastIndexOfSlash + 1)
}
