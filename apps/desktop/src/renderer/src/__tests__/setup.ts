import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * Unmount every rendered tree between tests so one test's DOM (and its pending
 * effects) cannot leak into the next.
 */
afterEach(() => {
  cleanup();
});
