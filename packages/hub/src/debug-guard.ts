/**
 * Turns off simple-git's `debug` namespaces before anything that uses them is loaded.
 *
 * simple-git logs each spawn through `debug`, including the argv and the environment it was handed
 * — which for this hub is the environment carrying the owner's GitHub token as an
 * `http.extraHeader` (0028). `DEBUG=*` in a unit file or a shell would print that credential to the
 * hub's log, where it long outlives the command.
 *
 * `debug` decides whether a namespace is enabled when the logger is *created*, at module load, so
 * this has to run before `server.js` (and through it simple-git) is evaluated. `main.ts` imports it
 * first for that reason: it is a side effect with no exports, and moving it below another import
 * would silently stop it working. A trailing `-simple-git*` wins over any earlier match, so a
 * `DEBUG` set for something else keeps working.
 */
const SILENCED = '-simple-git,-simple-git:*';

const existing = process.env.DEBUG;
process.env.DEBUG = existing ? `${existing},${SILENCED}` : SILENCED;

export {};
