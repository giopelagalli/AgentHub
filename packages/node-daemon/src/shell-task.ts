// The implementation moved to `@agenthub/shared/shell` so the hub's workspace tools run shell
// commands with the same process-group discipline. Re-exported here to keep daemon call sites stable.
export { resolveWorkspace, runShellTask } from '@agenthub/shared/shell';
