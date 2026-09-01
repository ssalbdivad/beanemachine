import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { arktypeValidator } from "@hono/arktype-validator"
import { type } from "arktype"
import { Hono } from "hono"
import { existsSync } from "node:fs"
import { CONFIG_PATH, ConfigError, loadConfig, saveConfig } from "./config.ts"
import { ImportError, importLeague } from "./import.ts"
import { League } from "./schema.ts"

/**
 * The same ArkType schemas that guard scoring.json also validate every request
 * body, so a malformed edit is rejected at the edge with a real error message
 * rather than reaching the file.
 */
const LeagueKey = type("string > 0")

const SaveBody = type({ key: LeagueKey, league: League })
const ImportBody = type({ url: "string > 0" })
const KeyBody = type({ key: LeagueKey })
const NewBody = type({
	key: type("string").narrow((s, ctx) =>
		/^[A-Za-z0-9_:.-]+$/.test(s) ||
		ctx.mustBe("non-empty, using only letters, digits, and : _ - .")
	),
	"template?": "string"
})

const app = new Hono()

/** Our own errors are guidance; anything else is a bug and stays a 500. */
app.onError((e, c) => {
	if (e instanceof ImportError || e instanceof ConfigError)
		return c.json({ error: e.message }, 400)
	console.error(e)
	return c.json({ error: `${e.name}: ${e.message}` }, 500)
})

const api = new Hono()
	.get("/config", async c => c.json(await loadConfig()))

	.post("/import", arktypeValidator("json", ImportBody), async c => {
		const { url } = c.req.valid("json")
		const { key, league } = await importLeague(url)
		const config = await loadConfig()
		config.leagues[key] = league
		config.active_league = key
		return c.json({ key, config: await saveConfig(config) })
	})

	.post("/save", arktypeValidator("json", SaveBody), async c => {
		const { key, league } = c.req.valid("json")
		const config = await loadConfig()
		config.leagues[key] = league
		config.active_league = key
		return c.json({ key, config: await saveConfig(config) })
	})

	.post("/activate", arktypeValidator("json", KeyBody), async c => {
		const { key } = c.req.valid("json")
		const config = await loadConfig()
		if (!(key in config.leagues)) throw new ConfigError(`No league "${key}".`)
		config.active_league = key
		return c.json({ key, config: await saveConfig(config) })
	})

	.post("/new", arktypeValidator("json", NewBody), async c => {
		const { key, template = "custom" } = c.req.valid("json")
		const config = await loadConfig()
		if (key in config.leagues) throw new ConfigError(`"${key}" already exists.`)
		const draft = structuredClone(
			config.platform_templates[template] ?? config.platform_templates.custom
		) as Record<string, unknown>
		delete draft.description
		const league = League(draft)
		if (league instanceof type.errors)
			throw new ConfigError(`Template "${template}" is not a valid league:\n${league}`)
		config.leagues[key] = league
		config.active_league = key
		return c.json({ key, config: await saveConfig(config) })
	})

	.post("/delete", arktypeValidator("json", KeyBody), async c => {
		const { key } = c.req.valid("json")
		const config = await loadConfig()
		if (!(key in config.leagues)) throw new ConfigError(`No league "${key}".`)
		delete config.leagues[key]
		if (config.active_league === key)
			config.active_league = Object.keys(config.leagues)[0] ?? null
		return c.json({ config: await saveConfig(config) })
	})

app.route("/api", api)

/** In dev Vite serves the client and proxies here; in prod we serve its build. */
const DIST = "./dist"
if (existsSync(DIST)) {
	app.use("/*", serveStatic({ root: DIST }))
	app.get("*", serveStatic({ path: `${DIST}/index.html` }))
}

export type Api = typeof api
export default app

const port = Number(process.argv.find(a => a.startsWith("--port="))?.slice(7) ?? 8000)
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, info => {
	console.log(`beanecounter api → http://localhost:${info.port}`)
	console.log(`config            ${CONFIG_PATH}`)
	if (!existsSync(DIST)) console.log(`client            run \`nub run dev\` (Vite serves it)`)
})
