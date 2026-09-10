/**
 * The one command a visitor could actually run, in exactly one place.
 *
 * It lived in `panels.tsx` as an exported constant AND, separately, as a
 * hand-written copy inside the Yahoo refusal in `api.ts`. The copy said
 * `node --experimental-strip-types src/cli.ts <your league URL>`: a flag node has
 * not required since 22.18, in front of a path that only resolves inside a checkout
 * of this repository, shown to somebody who is on beanemachine.com precisely because
 * they were not going to clone anything. test/leagues.mjs has forbidden that string
 * since the constant was written — and the copy escaped the check by being a copy.
 *
 * `bin` in package.json is what makes this form real: it points at a compiled bundle
 * rather than at src/cli.ts, because node refuses to strip types under node_modules,
 * which is exactly where npx puts it. See `RUN` in src/cli.ts, which prints the local
 * form when it IS running from a clone.
 *
 * Its own module rather than panels.tsx so that api.ts — which has no business
 * importing a file full of React components — can read the same string.
 */
export const IMPORT_COMMAND = "npx --yes github:ssalbdivad/beanemachine <your league URL>"
