import { handle } from "hono/vercel"
import app from "../src/api.ts"

/**
 * The API, as a serverless function.
 *
 * Three lines, because `src/api.ts` deliberately has nothing node-specific in it.
 * This is the file that makes beanemachine.com able to read a Yahoo league at all:
 * Yahoo sends no `access-control-allow-origin`, so a browser is never handed the
 * response, and a static host has nowhere to put the server that can be. Deploy this
 * and set `VITE_API_BASE` to its URL — see .env.example — and the site stops asking
 * anyone to open a terminal.
 *
 * `maxDuration` is raised because reading a league's free agents is nine sequential
 * page fetches against a host that rate-limits; the default ten seconds cuts it off
 * part-way and returns an empty pool, which the client would correctly but uselessly
 * report as "couldn't read your league".
 */
export const config = { runtime: "nodejs", maxDuration: 60 }

export default handle(app)
