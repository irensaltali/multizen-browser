import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConfirmHost } from "../../atoms";
import { SyncIssuesModal } from "../SyncIssuesModal";
import type { ConflictView, QuarantineView } from "../../../types";
import {
  createFakeGateway,
  installFakeGateway,
  type FakeGateway,
} from "../../../__tests__/fakeGateway";

function setup(fake: FakeGateway) {
  installFakeGateway(fake);
  const onResolved = vi.fn();
  render(
    <>
      <SyncIssuesModal open onClose={vi.fn()} onResolved={onResolved} />
      <ConfirmHost />
    </>,
  );
  return { onResolved, user: userEvent.setup() };
}

const conflict: ConflictView = {
  projectId: "shared",
  attemptedRevision: 2,
  remoteRevision: 4,
  localSigner: "dev_local",
  remoteSigner: "dev_remote",
  detectedAt: "2026-02-01T12:00:00.000Z",
  reason: "cas-lost",
  differences: ["name", "adds server docs"],
};

const refusedWithLocal: QuarantineView = {
  projectId: "mine",
  reason: "signer dev_unknown is not trusted",
  code: "unknown-signer",
  detectedAt: "2026-02-01T12:00:00.000Z",
  localRetained: true,
};

const refusedRemoteOnly: QuarantineView = {
  projectId: "theirs",
  reason: "signature invalid",
  code: "bad-signature",
  detectedAt: "2026-02-01T12:00:00.000Z",
  localRetained: false,
};

describe("Sync issues — empty and loading", () => {
  it("says nothing needs attention when both lists are empty", async () => {
    setup(createFakeGateway());
    expect(await screen.findByText(/nothing needs attention/i)).toBeInTheDocument();
    expect(screen.queryByTestId("conflict-list")).not.toBeInTheDocument();
    expect(screen.queryByTestId("quarantine-list")).not.toBeInTheDocument();
  });

  it("surfaces a load failure", async () => {
    const fake = createFakeGateway();
    fake.api.conflicts = (async () => ({
      ok: false as const,
      error: { code: "io", message: "state file unreadable" },
    })) as typeof fake.api.conflicts;
    setup(fake);
    expect(await screen.findByRole("alert")).toHaveTextContent("state file unreadable");
  });
});

describe("Sync issues — clashing edits", () => {
  it("explains the clash and what keeping the local copy would change", async () => {
    setup(createFakeGateway({ conflicts: [conflict] }));
    const row = await screen.findByTestId("conflict-shared");
    expect(within(row).getByText("needs a choice")).toBeInTheDocument();
    expect(within(row).getByText(/revision 4 while this one was on 2/i)).toBeInTheDocument();
    expect(within(row).getByText(/name, adds server docs/)).toBeInTheDocument();
  });

  it("keeps mine after confirming, and says the cloud copy is replaced", async () => {
    const fake = createFakeGateway({ conflicts: [conflict] });
    const { user, onResolved } = setup(fake);
    await screen.findByTestId("conflict-shared");

    await user.click(screen.getByRole("button", { name: /keep mine/i }));
    const dialog = await screen.findByRole("dialog", { name: /keep this device’s version/i });
    expect(dialog).toHaveTextContent(/published as the newest revision/i);
    await user.click(within(dialog).getByRole("button", { name: /publish my version/i }));

    expect(fake.state.resolutions).toEqual([{ projectId: "shared", keep: "mine" }]);
    expect(onResolved).toHaveBeenCalled();
  });

  it("warns that using theirs is unrecoverable before discarding", async () => {
    const fake = createFakeGateway({ conflicts: [conflict] });
    const { user } = setup(fake);
    await screen.findByTestId("conflict-shared");

    await user.click(screen.getByRole("button", { name: /use theirs/i }));
    const dialog = await screen.findByRole("dialog", { name: /discard this device’s version/i });
    expect(dialog).toHaveTextContent(/cannot be recovered/i);
    await user.click(within(dialog).getByRole("button", { name: /discard my version/i }));

    expect(fake.state.resolutions).toEqual([{ projectId: "shared", keep: "theirs" }]);
  });

  it("decides nothing when the confirmation is cancelled", async () => {
    const fake = createFakeGateway({ conflicts: [conflict] });
    const { user, onResolved } = setup(fake);
    await screen.findByTestId("conflict-shared");

    await user.click(screen.getByRole("button", { name: /keep mine/i }));
    const dialog = await screen.findByRole("dialog", { name: /keep this device’s version/i });
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(fake.state.resolutions).toEqual([]));
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("reports a failed resolution rather than appearing to succeed", async () => {
    const fake = createFakeGateway({ conflicts: [conflict] });
    fake.api.resolveConflicts = (async () => ({
      ok: false as const,
      error: { code: "conflict", message: "the stored local copy could not be read" },
    })) as typeof fake.api.resolveConflicts;
    const { user, onResolved } = setup(fake);
    await screen.findByTestId("conflict-shared");

    await user.click(screen.getByRole("button", { name: /keep mine/i }));
    await user.click(
      within(
        await screen.findByRole("dialog", { name: /keep this device’s version/i }),
      ).getByRole("button", { name: /publish my version/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be read/);
    expect(onResolved).not.toHaveBeenCalled();
    // Still listed, so the operator can see the choice was not made.
    expect(screen.getByTestId("conflict-shared")).toBeInTheDocument();
  });
});

describe("Sync issues — refused records", () => {
  it("says the local copy is unaffected when one was retained", async () => {
    setup(createFakeGateway({ quarantined: [refusedWithLocal] }));
    const row = await screen.findByTestId("quarantine-mine");
    expect(within(row).getByText("unknown-signer")).toBeInTheDocument();
    expect(within(row).getByText("still running here")).toBeInTheDocument();
    expect(within(row).getByText(/own copy is unaffected and still serving/i)).toBeInTheDocument();
    expect(within(row).getByText(/signer dev_unknown is not trusted/)).toBeInTheDocument();
  });

  it("says nothing is running when there was no local copy", async () => {
    setup(createFakeGateway({ quarantined: [refusedRemoteOnly] }));
    const row = await screen.findByTestId("quarantine-theirs");
    expect(within(row).queryByText("still running here")).not.toBeInTheDocument();
    expect(within(row).getByText(/nothing from this record is running/i)).toBeInTheDocument();
  });

  it("dismisses a refused record for re-checking", async () => {
    const fake = createFakeGateway({ quarantined: [refusedRemoteOnly] });
    const { user, onResolved } = setup(fake);
    await screen.findByTestId("quarantine-theirs");

    await user.click(screen.getByRole("button", { name: /dismiss and re-check/i }));

    expect(fake.api.releaseQuarantine).toHaveBeenCalledWith("theirs");
    expect(onResolved).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByTestId("quarantine-theirs")).not.toBeInTheDocument(),
    );
  });

  it("shows both kinds of problem together", async () => {
    setup(
      createFakeGateway({
        conflicts: [conflict],
        quarantined: [refusedWithLocal, refusedRemoteOnly],
      }),
    );
    expect(await screen.findByTestId("conflict-list")).toBeInTheDocument();
    const q = screen.getByTestId("quarantine-list");
    expect(within(q).getByTestId("quarantine-mine")).toBeInTheDocument();
    expect(within(q).getByTestId("quarantine-theirs")).toBeInTheDocument();
  });
});
