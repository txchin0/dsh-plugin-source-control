/**
 * Build all three artifacts this plugin ships.
 *
 *   1. `lib/index.js`   — the Host half, bundled ESM for Node.
 *   2. `lib/client.js`  — the browser half, wrapped in the client module
 *                         system's `__ModuleLoader__.load` envelope with the
 *                         component stylesheet embedded and injected through
 *                         the plugin's own effect.
 *   3. `lib/monaco-editor.worker.js` — Monaco's editor worker, served by the
 *                         Host half at `/source-control/monaco/editor.worker.js`.
 */
import { build } from 'esbuild'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const libDir = path.join(root, 'lib')
const stageDir = path.join(root, 'node_modules', '.dsh-build')
const packageId = 'dsh-plugin-source-control'

/** Modules the browser module table already provides. */
const platformModules = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']

/** Loaders that turn binary assets referenced from CSS into inline data URLs. */
const assetLoaders = {
  '.ttf': 'dataurl',
  '.woff': 'dataurl',
  '.woff2': 'dataurl',
  '.svg': 'dataurl',
  '.png': 'dataurl',
}

const shared = {
  bundle: true,
  sourcemap: false,
  logLevel: 'warning',
  legalComments: 'eof',
}

await rm(libDir, { recursive: true, force: true })
await rm(stageDir, { recursive: true, force: true })
await mkdir(libDir, { recursive: true })
await mkdir(stageDir, { recursive: true })

// 1. Host half.
await build({
  ...shared,
  entryPoints: [path.join(root, 'src', 'index.ts')],
  outfile: path.join(libDir, 'index.js'),
  format: 'esm',
  platform: 'node',
  target: 'node22',
  minify: false,
})

// 2. Browser half: the module body plus its stylesheet.
await build({
  ...shared,
  entryPoints: [path.join(root, 'src', 'client', 'index.ts')],
  outfile: path.join(stageDir, 'client.js'),
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: platformModules,
  loader: assetLoaders,
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
})

const clientBody = await readFile(path.join(stageDir, 'client.js'), 'utf8')
const clientCss = await readFile(path.join(stageDir, 'client.css'), 'utf8').catch(() => '')

/** Indent every line of the bundled module body to sit inside the factory. */
function indent(text) {
  return text
    .split('\n')
    .map((line) => (line === '' ? line : `\t\t${line}`))
    .join('\n')
}

const clientBundle = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(packageId)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var __dshStyle = null;
		function __dshInstallStyles(extra) {
			if (__dshStyle !== null) return function () {};
			__dshStyle = document.createElement("style");
			__dshStyle.setAttribute("data-dsh-plugin", ${JSON.stringify(packageId)});
			__dshStyle.textContent = ${JSON.stringify(clientCss)} + (extra || "");
			document.head.appendChild(__dshStyle);
			return function () {
				if (__dshStyle !== null && __dshStyle.parentNode !== null) __dshStyle.parentNode.removeChild(__dshStyle);
				__dshStyle = null;
			};
		}
${indent(clientBody)}
		module.exports.installStyles = __dshInstallStyles;
		return module.exports;
	}
});
`

await writeFile(path.join(libDir, 'client.js'), clientBundle)

// 3. Monaco's editor worker.
await build({
  ...shared,
  entryPoints: [path.join(root, 'src', 'client', 'editor.worker.ts')],
  outfile: path.join(libDir, 'monaco-editor.worker.js'),
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
})

await rm(stageDir, { recursive: true, force: true })

const sizes = await Promise.all(
  ['index.js', 'client.js', 'monaco-editor.worker.js'].map(async (name) => {
    const bytes = (await readFile(path.join(libDir, name))).byteLength
    return `${name} ${(bytes / 1024).toFixed(0)} KiB`
  }),
)
console.log(`built ${sizes.join(', ')}`)
