/**
 * Electron adapter for the gateway IPC.
 *
 * Deliberately thin: everything that can be tested without Electron lives in
 * {@link registerGatewayHandlers}, and this file exists only to supply the real
 * `ipcMain`. Keeping the import isolated here is what lets the node:test suites
 * exercise the wiring at all.
 */

import { ipcMain } from "electron";

import type { GatewayController } from "./GatewayController.ts";
import {
  registerGatewayHandlers,
  type GatewayIpcHost,
} from "./registerGatewayHandlers.ts";

export type { GatewayIpcHost, IpcRegistrar } from "./registerGatewayHandlers.ts";
export { GATEWAY_IPC_CHANNELS } from "./gatewayIpcChannels.ts";

export function registerGatewayIpc(
  controller: GatewayController,
  host: GatewayIpcHost,
): void {
  // Electron types `handle`'s listener with a concrete event and `any[]` rest
  // args. Under strictFunctionTypes that cannot be reconciled with a registrar
  // precise enough to typecheck the handlers themselves, so the adaptation is
  // done here — one cast, at the boundary, instead of loosening every handler.
  registerGatewayHandlers(
    {
      handle: (channel, listener) =>
        ipcMain.handle(channel, listener as Parameters<typeof ipcMain.handle>[1]),
    },
    controller,
    host,
  );
}
