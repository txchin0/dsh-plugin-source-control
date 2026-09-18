/*
 * The file icons the SCM rows draw, and the stylesheet that backs them.
 *
 * The class list is a port of VS Code's `getIconClasses`
 * (`src/vs/editor/common/services/getIconClasses.ts`, MIT, © Microsoft
 * Corporation); the stylesheet is `fileIconTheme.ts` beside this file. Together
 * they reproduce what VS Code's Source Control view shows, because that view
 * draws its rows with the very same pair: `ResourceRenderer.renderIcon` hands
 * `setFile` a URI, `ResourceLabel` turns it into these classes, and the active
 * file icon theme — `vs-seti`, which is VS Code's default — supplies the rules.
 *
 * One leg is approximated, and it is worth naming. VS Code detects a file's
 * language from the open text model when there is one and from the language
 * registry's path associations otherwise. This plugin has neither: it holds a
 * generated table of the extensions and names VS Code's own built-in
 * extensions declare (`assets/fileicons/vscode-language-ids.json`), and reads
 * the name only — never the file — so the `firstLine` associations a shebang
 * would satisfy do not apply. Everything else is the same resolution, in the
 * same order: an exact name beats the longest extension, and the language is
 * only reached when neither matched.
 */
import languageIds from '../../assets/fileicons/vscode-language-ids.json'
import themeDocument from '../../assets/fileicons/vs-seti-icon-theme.json'
import setiFont from '../../assets/fileicons/seti.woff'
import {
  fileIconSelectorEscape,
  fileIconThemeStylesheet,
  type FileIconThemeDocument,
} from './fileIconTheme.ts'

/**
 * `fileIconDirectoryRegex` from `getIconClasses.ts`: the last path segment, and
 * the directory it sits in, which the theme may key an association off.
 */
const FILE_ICON_DIRECTORY = /(?:\/|^)(?:([^/]+)\/)?([^/]+)$/

/** The panel root, which is where the generated rules are allowed to apply. */
const FILE_ICON_ROOT = '.dsh-scm.show-file-icons'

/**
 * The same root under the light scheme.
 *
 * VS Code qualifies a light theme's copy of the rules with `.vs` — one class
 * more than the dark copy, so that both match and the light one wins on
 * specificity. An attribute selector is this markup's equivalent step, and it
 * buys the same thing without a second stylesheet swap.
 */
const FILE_ICON_ROOT_LIGHT = ".dsh-scm[data-scheme='light'].show-file-icons"

/** The generated rules, built once and handed to the stylesheet installer. */
let stylesheet: string | null = null

/**
 * The language id VS Code's built-in extensions would give this file name.
 *
 * `getAssociationByPath` in `languagesAssociations.ts`, minus the associations
 * this plugin cannot see: an exact file name is taken first, then the longest
 * extension, and each entry in the table is one VS Code's own manifests
 * declare for a language the theme names.
 * @param name - the lowercased final path segment.
 * @returns the language id, or `null` when nothing claims the file.
 */
function detectLanguageId(name: string): string | null {
  if (name === '') return null

  const byName = (languageIds.filenames as Record<string, string>)[name]
  if (byName !== undefined) return byName

  // Longest extension first: `foo.h.in` has to reach `h.in` before `in`, which
  // is what `getAssociationByPath`'s length comparison does over `endsWith`.
  const segments = name.split('.')
  for (let index = 1; index < segments.length; index += 1) {
    const byExtension = (languageIds.extensions as Record<string, string>)[segments.slice(index).join('.')]
    if (byExtension !== undefined) return byExtension
  }
  return null
}

/**
 * The classes one path's icon is drawn from.
 *
 * The class *count* is the resolution — `.name-file-icon` outranks
 * `.ext-file-icon` outranks `-lang-file-icon` — so the caller must put every
 * class on the icon element and let the cascade choose. Returning the winner
 * would mean reimplementing the precedence this avoids.
 * @param path - the repository-relative path, with forward slashes.
 * @returns the classes to place beside `file-icon`.
 */
export function fileIconClasses(path: string): string[] {
  const classes = ['file-icon']
  const match = FILE_ICON_DIRECTORY.exec(path)
  const name = match === null ? '' : fileIconSelectorEscape(match[2].toLowerCase())

  if (match !== null && match[1] !== undefined) {
    classes.push(`${fileIconSelectorEscape(match[1].toLowerCase())}-name-dir-icon`)
  }

  if (name !== '') {
    classes.push(`${name}-name-file-icon`)
    // An extra segment, to raise a name above every extension.
    classes.push('name-file-icon')
    // Long names with many dots explode into an unreasonable number of
    // combinations; nothing a file system accepts reaches 255 characters.
    if (name.length <= 255) {
      const dotSegments = name.split('.')
      for (let index = 1; index < dotSegments.length; index += 1) {
        classes.push(`${dotSegments.slice(index).join('.')}-ext-file-icon`)
      }
    }
    classes.push('ext-file-icon')
  }

  const languageId = detectLanguageId(name)
  if (languageId !== null) classes.push(`${fileIconSelectorEscape(languageId)}-lang-file-icon`)

  return classes
}

/**
 * The generated theme stylesheet, ready to append to the panel's own.
 *
 * Built on first use rather than at module load, so importing this module costs
 * nothing until a row is actually drawn.
 * @returns the rules for the lifted theme.
 */
export function fileIconsStylesheet(): string {
  if (stylesheet === null) {
    stylesheet = fileIconThemeStylesheet(themeDocument as FileIconThemeDocument, `'${setiFont}'`, {
      dark: FILE_ICON_ROOT,
      light: FILE_ICON_ROOT_LIGHT,
    })
  }
  return stylesheet
}
