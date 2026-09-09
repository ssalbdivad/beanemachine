import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { existsSync } from "node:fs"
import app from "./api.ts"

/**
 * The API, run on this machine.
 *
 * Everything that answers a request lives in `src/api.ts` and has nothing
 * node-specific in it, so the same routes can be deployed to a serverless host —
 * which is what turns "run a terminal command" into "paste your league URL" for the
 * one platform no browser can read. This file is the local adapter and the static
 * server, and nothing else.
 */

/** In dev Vite serves the client and proxies here; in prod we serve its build. */
const DIST = "./dist"
if (existsSync(DIST)) {
	app.use("/*", serveStatic({ root: DIST }))
	app.get("*", serveStatic({ path: `${DIST}/index.html` }))
}

const port = Number(process.argv.find(a => a.startsWith("--port="))?.slice(7) ?? 8000)
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, info => {
	console.log(`beanemachine api → http://localhost:${info.port}`)
	console.log(`leagues           kept in your browser; this only reads them from their URL`)
	console.log(`yahoo             the one platform no browser can read; this is its only route`)
	console.log(`one-off import    node src/cli.ts <league-url>`)
	if (!existsSync(DIST)) console.log(`client            run \`npx vite\` (it serves the client)`)
})

export { app }
export default app
