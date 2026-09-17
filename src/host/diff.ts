import type { ScmDiff, ScmDiffKind, ScmDiffSide, ScmGroupId } from '../shared/protocol.ts'
import type { GitRunner } from './git.ts'
import type { HostFs } from './services.ts'

/** Largest text side handed to the editor, so a huge file cannot hang the page. */
export const TEXT_LIMIT = 4 * 1024 * 1024

/** File extension to Monaco language id, for every basic language worth mapping. */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  abap: 'abap',
  bat: 'bat',
  bicep: 'bicep',
  c: 'c',
  cc: 'cpp',
  clj: 'clojure',
  cljs: 'clojure',
  cls: 'apex',
  cmd: 'bat',
  coffee: 'coffee',
  conf: 'ini',
  cpp: 'cpp',
  cs: 'csharp',
  csh: 'shell',
  css: 'css',
  cxx: 'cpp',
  dart: 'dart',
  dockerfile: 'dockerfile',
  ecl: 'ecl',
  ex: 'elixir',
  exs: 'elixir',
  fs: 'fsharp',
  fsx: 'fsharp',
  go: 'go',
  gradle: 'groovy',
  graphql: 'graphql',
  gql: 'graphql',
  groovy: 'groovy',
  h: 'cpp',
  hbs: 'handlebars',
  hcl: 'hcl',
  hpp: 'cpp',
  hs: 'haskell',
  htm: 'html',
  html: 'html',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'javascript',
  jl: 'julia',
  kt: 'kotlin',
  kts: 'kotlin',
  less: 'less',
  lex: 'lexon',
  lua: 'lua',
  m: 'objective-c',
  md: 'markdown',
  mdx: 'mdx',
  mjs: 'javascript',
  mjsx: 'javascript',
  mm: 'objective-c',
  ms: 'mips',
  mysql: 'mysql',
  pas: 'pascal',
  php: 'php',
  pl: 'perl',
  proto: 'protobuf',
  ps1: 'powershell',
  psm1: 'powershell',
  pug: 'pug',
  py: 'python',
  pyi: 'python',
  qs: 'qsharp',
  r: 'r',
  razor: 'razor',
  rb: 'ruby',
  rs: 'rust',
  rst: 'restructuredtext',
  sass: 'scss',
  scala: 'scala',
  scm: 'scheme',
  scss: 'scss',
  sh: 'shell',
  sol: 'solidity',
  sql: 'sql',
  st: 'st',
  sv: 'systemverilog',
  svelte: 'html',
  swift: 'swift',
  tcl: 'tcl',
  tf: 'hcl',
  toml: 'ini',
  ts: 'typescript',
  tsv: 'plaintext',
  tsx: 'typescript',
  twig: 'twig',
  txt: 'plaintext',
  vb: 'vb',
  vue: 'html',
  wgsl: 'wgsl',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shell',
}

/** Exact file names that select a language regardless of extension. */
const LANGUAGE_BY_NAME: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile',
  'cmakelists.txt': 'plaintext',
  gemfile: 'ruby',
  makefile: 'plaintext',
  rakefile: 'ruby',
}

/**
 * Resolve the Monaco language id for a file name.
 * @param name - the file's last path segment.
 * @returns a Monaco language id, defaulting to plain text.
 */
export function languageFor(name: string): string {
  const lower = name.toLowerCase()
  const byName = LANGUAGE_BY_NAME[lower]
  if (byName !== undefined) return byName
  const dot = lower.lastIndexOf('.')
  if (dot === -1) return 'plaintext'
  return LANGUAGE_BY_EXTENSION[lower.slice(dot + 1)] ?? 'plaintext'
}

/** One file comparison the panel asked for. */
export interface DiffRequest {
  path: string
  name: string
  kind: ScmDiffKind
  group: ScmGroupId
  hasIndexChange: boolean
  /** The commit the comparison is anchored at, for `kind: 'commit'`. */
  commit?: string
}

/** Join a repository-relative path onto the absolute working-tree root. */
export function joinPath(root: string, relative: string): string {
  return `${root.replace(/[\\/]+$/, '')}/${relative}`
}

/** Build one side, capping the text the editor receives. */
function side(label: string, text: string | undefined): ScmDiffSide {
  if (text === undefined) return { label, text: '', exists: false }
  return {
    label,
    text: text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text,
    exists: true,
  }
}

/** Read one git object's content as text, or `undefined` when it does not exist. */
async function readBlob(git: GitRunner, root: string, spec: string): Promise<string | undefined> {
  const result = await git.run(root, ['cat-file', 'blob', spec])
  return result.exitCode === 0 ? result.stdout : undefined
}

/** Read one working-tree file as text, or `undefined` when it cannot be read. */
async function readDisk(fs: HostFs, absolute: string): Promise<string | undefined> {
  try {
    const target = await fs.resolve(absolute)
    const info = await fs.stat(target)
    if (info === undefined || info.type !== 'file') return undefined
    return await fs.readText(target)
  } catch {
    return undefined
  }
}

/** The git revision holding the "before" content, or `undefined` for an untracked file. */
function originalSpec(request: DiffRequest): string | undefined {
  switch (request.kind) {
    case 'untracked':
      return undefined
    case 'merge':
      // Handled alongside its "theirs" side below.
      return undefined
    case 'commit':
      // The commit's own parent, likewise handled below.
      return undefined
    case 'index':
      return `HEAD:${request.path}`
    case 'deleted':
      return request.group === 'index'
        ? `HEAD:${request.path}`
        : `${request.hasIndexChange ? ':0:' : 'HEAD:'}${request.path}`
    case 'workingTree':
      return `${request.hasIndexChange ? ':0:' : 'HEAD:'}${request.path}`
  }
}

/** Whether a side holds binary data rather than text. */
function looksBinary(text: string | undefined): boolean {
  if (text === undefined) return false
  if (text.includes('\u0000')) return true
  const probe = text.slice(0, 8000)
  let suspicious = 0
  for (const character of probe) if (character === '\uFFFD') suspicious += 1
  return probe.length > 0 && suspicious / probe.length > 0.05
}

/**
 * Resolve both sides of one file comparison.
 *
 * The comparison follows VS Code's git provider: a staged change compares HEAD
 * with the index blob, an unstaged change compares the index blob (or HEAD when
 * the file has no staged part) with the working tree, an untracked file has no
 * original side, and a conflict compares "ours" with "theirs".
 * @param git - the runner.
 * @param fs - the filesystem provider.
 * @param root - the absolute working-tree root.
 * @param request - the file and the comparison to make.
 * @returns the comparison the diff editor renders.
 */
export async function readDiff(
  git: GitRunner,
  fs: HostFs,
  root: string,
  request: DiffRequest,
): Promise<ScmDiff> {
  const absolute = joinPath(root, request.path)
  const spec = originalSpec(request)
  const commit = request.commit ?? ''

  let originalText: string | undefined
  if (request.kind === 'merge') {
    originalText = (await readBlob(git, root, `:2:${request.path}`)) ?? (await readBlob(git, root, `:1:${request.path}`))
  } else if (request.kind === 'commit') {
    // A root commit has no parent, so the file reads as newly added.
    originalText = commit === '' ? undefined : await readBlob(git, root, `${commit}^:${request.path}`)
  } else if (spec !== undefined) {
    originalText = await readBlob(git, root, spec)
  }

  let modifiedText: string | undefined
  if (request.kind === 'index') {
    modifiedText = await readBlob(git, root, `:0:${request.path}`)
  } else if (request.kind === 'merge') {
    modifiedText = (await readBlob(git, root, `:3:${request.path}`)) ?? (await readDisk(fs, absolute))
  } else if (request.kind === 'commit') {
    modifiedText = commit === '' ? undefined : await readBlob(git, root, `${commit}:${request.path}`)
  } else if (request.kind === 'deleted') {
    modifiedText = undefined
  } else {
    modifiedText = await readDisk(fs, absolute)
  }

  const short = commit.length > 8 ? commit.slice(0, 8) : commit
  const originalLabel =
    request.kind === 'merge'
      ? 'Ours'
      : request.kind === 'commit'
        ? short === ''
          ? 'Empty'
          : `${short}^`
        : spec === undefined
          ? 'Untracked'
          : request.hasIndexChange && spec.startsWith(':0:')
            ? 'Index'
            : 'HEAD'
  const modifiedLabel =
    request.kind === 'index'
      ? 'Index'
      : request.kind === 'merge'
        ? 'Theirs'
        : request.kind === 'commit'
          ? short
          : 'Working Tree'

  const binary = looksBinary(originalText) || looksBinary(modifiedText)
  return {
    path: request.path,
    name: request.name,
    language: languageFor(request.name),
    original: binary ? side(originalLabel, undefined) : side(originalLabel, originalText),
    modified: binary ? side(modifiedLabel, undefined) : side(modifiedLabel, modifiedText),
    binary,
    truncated:
      (originalText?.length ?? 0) > TEXT_LIMIT || (modifiedText?.length ?? 0) > TEXT_LIMIT,
  }
}
