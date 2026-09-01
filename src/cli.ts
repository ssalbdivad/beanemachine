import { loadConfig, saveConfig } from "./config.ts"
import { ImportError, importLeague } from "./import.ts"

const url = process.argv[2]
if (!url) {
	console.error("usage: nub src/cli.ts <league-url>")
	process.exit(1)
}

try {
	const { key, league } = await importLeague(url)
	const config = await loadConfig()
	config.leagues[key] = league
	config.active_league = key
	await saveConfig(config)

	const { batting, pitching } = league.scoring
	const slots = Object.values(league.roster.slots).reduce((a, b) => a + b, 0)
	console.log(
		`imported ${key} → scoring.json\n` +
			`  ${Object.keys(batting).length} batting · ${Object.keys(pitching).length} pitching · ${slots} roster slots`
	)
	for (const note of league.needs_review) console.log(`  needs review: ${note}`)
} catch (e) {
	console.error(e instanceof ImportError ? `error: ${e.message}` : e)
	process.exit(1)
}
