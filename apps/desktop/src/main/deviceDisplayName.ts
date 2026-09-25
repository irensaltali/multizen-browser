import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

const LEGACY_DEVICE_NAME = "This device";
export const MAX_DEVICE_DISPLAY_NAME_LENGTH = 80;

export function normalizeDeviceDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_DEVICE_DISPLAY_NAME_LENGTH);
}

function macComputerName(): string {
  if (process.platform !== "darwin") return "";
  try {
    return execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    });
  } catch {
    return "";
  }
}

/** Use the Mac's user-facing Computer Name, falling back to its network name. */
export function systemDeviceDisplayName(
  computerName = macComputerName(),
  networkName = hostname(),
): string {
  const preferred = normalizeDeviceDisplayName(computerName);
  if (preferred.length > 0) return preferred;
  const fallback = normalizeDeviceDisplayName(networkName.replace(/\.local$/i, ""));
  return fallback || LEGACY_DEVICE_NAME;
}

/** Migrate only the old generated placeholder; never replace a user's choice. */
export function migrateLegacyDeviceDisplayName(current: string): string {
  return current === LEGACY_DEVICE_NAME ? systemDeviceDisplayName() : current;
}
