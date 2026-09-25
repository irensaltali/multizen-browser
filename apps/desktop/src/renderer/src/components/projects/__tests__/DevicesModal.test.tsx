import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConfirmHost } from "../../atoms";
import { DevicesModal } from "../DevicesModal";
import type { TrustDeviceView } from "../../../types";
import {
  createFakeGateway,
  installFakeGateway,
  type FakeGateway,
} from "../../../__tests__/fakeGateway";

function setup(fake: FakeGateway) {
  installFakeGateway(fake);
  const onTrustChanged = vi.fn();
  const onClose = vi.fn();
  render(
    <>
      <DevicesModal open onClose={onClose} onTrustChanged={onTrustChanged} />
      <ConfirmHost />
    </>,
  );
  return { onTrustChanged, onClose, user: userEvent.setup() };
}

const self: TrustDeviceView = {
  deviceId: "dev_self0000000000000000000000000",
  publicKeyHex: "a".repeat(64),
  role: "trusted",
  isSelf: true,
  name: "This machine",
};

const pending: TrustDeviceView = {
  deviceId: "dev_pend0000000000000000000000000",
  publicKeyHex: "b".repeat(64),
  role: "pending",
  isSelf: false,
  name: "Bea’s laptop",
  announcedAt: "2026-01-05T10:00:00.000Z",
};

const trustedPeer: TrustDeviceView = {
  deviceId: "dev_peer0000000000000000000000000",
  publicKeyHex: "c".repeat(64),
  role: "trusted",
  isSelf: false,
  name: "Studio iMac",
};

describe("Devices — listing", () => {
  it("marks this device and does not offer to revoke it", async () => {
    setup(createFakeGateway({ devices: [self] }));
    const list = await screen.findByTestId("device-list");
    expect(within(list).getByText("This machine")).toBeInTheDocument();
    expect(within(list).getByText("this device")).toBeInTheDocument();
    expect(within(list).getByText("trusted")).toBeInTheDocument();
    // Revoking the machine you are using would lock you out of your own bucket.
    expect(within(list).queryByRole("button", { name: /revoke/i })).not.toBeInTheDocument();
  });

  it("shows a waiting device with its name and first-seen date", async () => {
    setup(createFakeGateway({ devices: [self, pending] }));
    const list = await screen.findByTestId("device-list");
    expect(within(list).getByText("Bea’s laptop")).toBeInTheDocument();
    expect(within(list).getByText("waiting")).toBeInTheDocument();
    expect(within(list).getByText(/first seen/i)).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /^Approve$/ })).toBeInTheDocument();
  });

  it("explains what a waiting device can and cannot do", async () => {
    setup(createFakeGateway({ devices: [self, pending] }));
    expect(
      await screen.findByText(/can read your projects but cannot change them/i),
    ).toBeInTheDocument();
  });

  it("offers revoke for another trusted device", async () => {
    setup(createFakeGateway({ devices: [self, trustedPeer] }));
    const list = await screen.findByTestId("device-list");
    const row = within(list).getByTestId(`device-${trustedPeer.deviceId}`);
    expect(within(row).getByRole("button", { name: /revoke/i })).toBeInTheDocument();
  });

  it("offers re-approval for a revoked device", async () => {
    setup(
      createFakeGateway({
        devices: [self, { ...trustedPeer, role: "revoked" }],
      }),
    );
    const list = await screen.findByTestId("device-list");
    expect(within(list).getByText("revoked")).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /re-approve/i })).toBeInTheDocument();
  });

  it("says so when there is nothing to show", async () => {
    setup(createFakeGateway({ devices: [] }));
    expect(await screen.findByText(/no devices yet/i)).toBeInTheDocument();
  });

  it("surfaces a listing failure", async () => {
    const fake = createFakeGateway();
    fake.api.trustList = (async () => ({
      ok: false as const,
      error: { code: "store", message: "bucket unreachable" },
    })) as typeof fake.api.trustList;
    setup(fake);
    expect(await screen.findByRole("alert")).toHaveTextContent("bucket unreachable");
  });
});

describe("Devices — approval", () => {
  it("approves a waiting device and re-runs sync", async () => {
    const fake = createFakeGateway({ devices: [self, pending] });
    const { user, onTrustChanged } = setup(fake);
    await screen.findByTestId("device-list");

    await user.click(screen.getByRole("button", { name: /^Approve$/ }));

    expect(fake.api.approveDevice).toHaveBeenCalledWith(
      pending.deviceId,
      pending.publicKeyHex,
    );
    // Records the device already published can now be accepted, so a fresh pass
    // has to run — otherwise the approval appears to do nothing.
    expect(onTrustChanged).toHaveBeenCalled();
    await waitFor(() => {
      const row = within(screen.getByTestId("device-list")).getByTestId(
        `device-${pending.deviceId}`,
      );
      expect(within(row).getByText("trusted")).toBeInTheDocument();
    });
  });

  it("reports a refused approval instead of appearing to succeed", async () => {
    const fake = createFakeGateway({ devices: [self, pending] });
    fake.api.approveDevice = (async () => ({
      ok: false as const,
      error: { code: "trust", message: "device dev_x is not an active trusted admin" },
    })) as typeof fake.api.approveDevice;
    const { user, onTrustChanged } = setup(fake);
    await screen.findByTestId("device-list");

    await user.click(screen.getByRole("button", { name: /^Approve$/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/not an active trusted admin/);
    expect(onTrustChanged).not.toHaveBeenCalled();
    // Still listed as waiting, so the operator can see nothing changed.
    expect(screen.getByText("waiting")).toBeInTheDocument();
  });
});

describe("Devices — revocation", () => {
  it("confirms, explains the consequence, and revokes", async () => {
    const fake = createFakeGateway({ devices: [self, trustedPeer] });
    const { user, onTrustChanged } = setup(fake);
    await screen.findByTestId("device-list");

    await user.click(screen.getByRole("button", { name: /revoke/i }));
    const dialog = await screen.findByRole("dialog", { name: /revoke Studio iMac/i });
    expect(dialog).toHaveTextContent(/refused on every other device/i);
    expect(dialog).toHaveTextContent(/Anything it already published stays/i);

    await user.click(within(dialog).getByRole("button", { name: /revoke device/i }));
    expect(fake.api.revokeDevice).toHaveBeenCalledWith(trustedPeer.deviceId);
    expect(onTrustChanged).toHaveBeenCalled();
  });

  it("does nothing when the confirmation is cancelled", async () => {
    const fake = createFakeGateway({ devices: [self, trustedPeer] });
    const { user } = setup(fake);
    await screen.findByTestId("device-list");

    await user.click(screen.getByRole("button", { name: /revoke/i }));
    const dialog = await screen.findByRole("dialog", { name: /revoke Studio iMac/i });
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(fake.api.revokeDevice).not.toHaveBeenCalled());
  });
});
