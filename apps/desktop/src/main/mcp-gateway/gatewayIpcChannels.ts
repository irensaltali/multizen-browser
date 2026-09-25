/**
 * The complete list of MCP-gateway IPC channel names.
 *
 * Kept in its own Electron-free module so it can be read by the preload
 * allowlist, by teardown code, and by tests, none of which should have to import
 * `ipcMain` to find out what the channels are.
 *
 * It is not decoration: `registerGatewayIpc` accepts an injectable registrar, and
 * a test asserts that the channels actually registered are exactly this list. A
 * handler added without listing it here — or listed without being added — fails.
 * That matters most for the credential channels, where the security property is
 * precisely that no *reading* channel exists.
 */
export const GATEWAY_IPC_CHANNELS: readonly string[] = [
  "gateway:listProjects",
  "gateway:getProject",
  "gateway:createProject",
  "gateway:updateProject",
  "gateway:deleteProject",
  "gateway:setupProject",
  "gateway:bindProfile",
  "gateway:bindableProfiles",
  "gateway:addServer",
  "gateway:updateServer",
  "gateway:removeServer",
  "gateway:setServerEnabled",
  "gateway:restartServer",
  "gateway:testServer",
  "gateway:setAuthEnabled",
  "gateway:generateToken",
  "gateway:authStatus",
  "gateway:secretRefs",
  "gateway:approveEnvName",
  "gateway:revokeEnvName",
  "gateway:saveManagedSecret",
  "gateway:deleteManagedSecret",
  "gateway:endpoints",
  "gateway:runtime",
  "gateway:logs",
  "gateway:trustList",
  "gateway:approveDevice",
  "gateway:revokeDevice",
  "gateway:conflicts",
  "gateway:resolveConflicts",
  "gateway:quarantine",
  "gateway:releaseQuarantine",
  "gateway:syncStatus",
  "gateway:syncRetry",
  "gateway:projectHistory",
  "gateway:restoreProjectRevision",
  "gateway:setupFromBackup",
  "gateway:credentialBackup",
  "gateway:enableCredentialBackup",
  "gateway:disableCredentialBackup",
  "gateway:restoreCredentials",
  "gateway:pickDirectory",
  "gateway:directories",
  "gateway:setDirectoryAgents",
  "gateway:removeDirectory",
  "gateway:reconcileDirectories",
  "gateway:retryDirectoryAgent",
  "gateway:revealPath",
];

/**
 * Push channel for live setup progress. Not in {@link GATEWAY_IPC_CHANNELS},
 * which lists invoke/handle channels: this one flows main → renderer.
 */
export const GATEWAY_SETUP_PROGRESS_CHANNEL = "gateway:setupProgress";
