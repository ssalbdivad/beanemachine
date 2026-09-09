import { defineConfig } from "vite"

/**
 * The command line, compiled, because `npx` cannot run TypeScript.
 *
 * `bin` pointed at `src/cli.ts` and node refused it outright:
 * `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` — node strips types by default
 * since 22.18, but never for files under `node_modules`, which is exactly where npx
 * puts a package. So the one command beanemachine.com prints for a Yahoo user
 * failed on the first line, for everyone, always. It was verified by running it
 * rather than by reading the docs, which is the only reason this file exists.
 *
 * The shebang comes from `src/cli.ts` itself and rolldown preserves it — adding a
 * banner here produced two, which is a syntax error rather than a runnable file.
 *
 * `publicDir: false` because the default build copies `public/` — CNAME, the
 * favicon, a 2.2 MB snapshot — into the CLI's own output, where none of it belongs.
 * The snapshot the CLI actually reads is `data/snapshot.json`, resolved from the
 * package root at runtime and shipped through `files` in package.json.
 */
export default defineConfig({
	publicDir: false,
	build: {
		ssr: "src/cli.ts",
		outDir: "dist-cli",
		emptyOutDir: true,
		// node runs this, not a browser; leave it legible so a stack trace means something
		minify: false,
		target: "node22"
	}
})
