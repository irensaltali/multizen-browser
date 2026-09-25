import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { CredentialBackupSection } from "../CredentialBackupSection";
import {
  createFakeGateway,
  installFakeGateway,
  type FakeGateway,
} from "../../../__tests__/fakeGateway";

function setup(fake: FakeGateway) {
  installFakeGateway(fake);
  render(<CredentialBackupSection />);
  return { user: userEvent.setup(), fake };
}

describe("Credential backup — default state and the stated trade", () => {
  it("is off by default and says so", async () => {
    setup(createFakeGateway());
    expect(await screen.findByTestId("credential-backup-state")).toHaveTextContent("Off");
  });

  it("states both costs plainly rather than selling the feature", async () => {
    setup(createFakeGateway());
    await screen.findByTestId("credential-backup-state");
    // The two things an operator must understand before opting in.
    expect(
      screen.getByText(/another place they can be stolen from/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/if you forget the passphrase nobody can recover the backup/i),
    ).toBeInTheDocument();
    // And what is never included, so declining is an informed choice either way.
    expect(
      screen.getByText(/bucket credentials and your encryption\s+password are never included/i),
    ).toBeInTheDocument();
  });

  it("explains that a separate passphrase is involved, not the encryption password", async () => {
    setup(createFakeGateway());
    await screen.findByTestId("credential-backup-state");
    expect(screen.getByText(/second passphrase/i)).toBeInTheDocument();
  });

  it("blocks opting in until Cloud Sync exists, and says why", async () => {
    const { user } = setup(createFakeGateway({ credentialBackup: { syncing: false } }));
    await screen.findByTestId("credential-backup-state");
    expect(screen.getByText(/Set up Cloud Sync above first/i)).toBeInTheDocument();
    await user.type(
      screen.getByLabelText("Credential passphrase"),
      "a long enough passphrase",
    );
    await user.type(
      screen.getByLabelText("Repeat credential passphrase"),
      "a long enough passphrase",
    );
    expect(screen.getByRole("button", { name: /Turn on credential backup/i })).toBeDisabled();
  });

  it("refreshes the state when the window regains focus", async () => {
    const fake = createFakeGateway({ credentialBackup: { syncing: false } });
    setup(fake);
    await screen.findByText(/Set up Cloud Sync above first/i);
    fake.state.credentialBackup = {
      ...fake.state.credentialBackup,
      syncing: true,
      remotePresent: true,
    };

    window.dispatchEvent(new Event("focus"));

    expect(
      await screen.findByLabelText("Credential passphrase to restore"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Set up Cloud Sync above first/i)).not.toBeInTheDocument();
  });

  it("renders nothing when the bridge has no credential channel", () => {
    // An older/partial preload must not break the settings screen.
    const fake = createFakeGateway();
    installFakeGateway(fake);
    const w = window as unknown as { multizen: { gateway: Record<string, unknown> } };
    delete w.multizen.gateway.credentialBackup;
    const { container } = render(<CredentialBackupSection />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Credential backup — the passphrase gate", () => {
  it("reports the minimum from the backend, not a hard-coded number", async () => {
    const { user } = setup(
      createFakeGateway({ credentialBackup: { minPassphraseLength: 20 } }),
    );
    await screen.findByTestId("credential-backup-state");
    const field = screen.getByLabelText("Credential passphrase");
    expect(field).toHaveAttribute("placeholder", "At least 20 characters");
    await user.type(field, "sixteencharacter");
    expect(screen.getByTestId("passphrase-verdict")).toHaveTextContent(
      /At least 20 characters/,
    );
  });

  it("will not submit a passphrase below the minimum", async () => {
    const { user, fake } = setup(createFakeGateway());
    await screen.findByTestId("credential-backup-state");
    await user.type(screen.getByLabelText("Credential passphrase"), "tooshort");
    await user.type(screen.getByLabelText("Repeat credential passphrase"), "tooshort");
    expect(screen.getByRole("button", { name: /Turn on credential backup/i })).toBeDisabled();
    expect(fake.api.enableCredentialBackup).not.toHaveBeenCalled();
  });

  it("requires the two entries to match, and says when they do not", async () => {
    const { user, fake } = setup(createFakeGateway());
    await screen.findByTestId("credential-backup-state");
    await user.type(screen.getByLabelText("Credential passphrase"), "a long enough passphrase");
    await user.type(screen.getByLabelText("Repeat credential passphrase"), "a long enough passphras");
    expect(screen.getByTestId("passphrase-mismatch")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Turn on credential backup/i })).toBeDisabled();
    expect(fake.api.enableCredentialBackup).not.toHaveBeenCalled();
  });

  it("warns about a long but repetitive passphrase while still allowing it", async () => {
    const { user } = setup(createFakeGateway());
    await screen.findByTestId("credential-backup-state");
    await user.type(screen.getByLabelText("Credential passphrase"), "aaaaaaaaaaaaaaaa");
    await user.type(screen.getByLabelText("Repeat credential passphrase"), "aaaaaaaaaaaaaaaa");
    expect(screen.getByTestId("passphrase-verdict")).toHaveTextContent(/Weak/);
    // Advice, not obstruction: the floor is the only hard rule.
    expect(screen.getByRole("button", { name: /Turn on credential backup/i })).toBeEnabled();
  });
});

describe("Credential backup — enabling, disabling, restoring", () => {
  it("sends the typed passphrase once and reflects the new state", async () => {
    const { user, fake } = setup(createFakeGateway());
    await screen.findByTestId("credential-backup-state");
    await user.type(screen.getByLabelText("Credential passphrase"), "a long enough passphrase");
    await user.type(
      screen.getByLabelText("Repeat credential passphrase"),
      "a long enough passphrase",
    );
    await user.click(screen.getByRole("button", { name: /Turn on credential backup/i }));

    await waitFor(() =>
      expect(screen.getByTestId("credential-backup-state")).toHaveTextContent("On"),
    );
    expect(fake.api.enableCredentialBackup).toHaveBeenCalledTimes(1);
    expect(fake.state.passphrases).toEqual([
      { op: "enable", passphrase: "a long enough passphrase" },
    ]);
    expect(screen.getByRole("status")).toHaveTextContent(/Store the passphrase somewhere safe/i);
  });

  it("clears the passphrase fields from the DOM after submitting", async () => {
    const { user } = setup(createFakeGateway());
    await screen.findByTestId("credential-backup-state");
    await user.type(screen.getByLabelText("Credential passphrase"), "a long enough passphrase");
    await user.type(
      screen.getByLabelText("Repeat credential passphrase"),
      "a long enough passphrase",
    );
    await user.click(screen.getByRole("button", { name: /Turn on credential backup/i }));

    // Once enabled the inputs are gone entirely, so nothing lingers in the DOM.
    await waitFor(() =>
      expect(screen.queryByLabelText("Credential passphrase")).not.toBeInTheDocument(),
    );
  });

  it("keeps the passphrase out of the DOM when enabling fails", async () => {
    const { user } = setup(
      createFakeGateway({
        failEnableCredentialBackup: {
          code: "wrong-passphrase",
          message: "A credential backup already exists and this passphrase does not open it.",
        },
      }),
    );
    await screen.findByTestId("credential-backup-state");
    const secret = "a long enough passphrase";
    await user.type(screen.getByLabelText("Credential passphrase"), secret);
    await user.type(screen.getByLabelText("Repeat credential passphrase"), secret);
    await user.click(screen.getByRole("button", { name: /Turn on credential backup/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent(/does not open it/i);
    // Still off, and the field was wiped rather than left populated on failure.
    expect(screen.getByTestId("credential-backup-state")).toHaveTextContent("Off");
    expect(screen.getByLabelText("Credential passphrase")).toHaveValue("");
    expect(document.body.innerHTML).not.toContain(secret);
  });

  it("turning off says local credentials were not deleted", async () => {
    const { user, fake } = setup(
      createFakeGateway({ credentialBackup: { enabled: true, remotePresent: true } }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("credential-backup-state")).toHaveTextContent("On"),
    );
    await user.click(screen.getByRole("button", { name: /Turn off and clear the backup/i }));
    await waitFor(() =>
      expect(screen.getByTestId("credential-backup-state")).toHaveTextContent("Off"),
    );
    expect(fake.api.disableCredentialBackup).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      /credentials on this device are untouched/i,
    );
  });

  it("offers restore when a backup exists even though this device has not opted in", async () => {
    // A brand-new machine is exactly the case that needs this, and it has not
    // enabled anything yet.
    const { user, fake } = setup(
      createFakeGateway({
        credentialBackup: { enabled: false, remotePresent: true },
        restoreResult: { restored: 3, projects: ["alpha", "beta"] },
      }),
    );
    await screen.findByTestId("credential-backup-state");
    await user.type(
      screen.getByLabelText("Credential passphrase to restore"),
      "a long enough passphrase",
    );
    await user.click(screen.getByRole("button", { name: /^Restore$/i }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /Restored 3 credentials for alpha, beta\./i,
      ),
    );
    expect(fake.state.passphrases).toEqual([
      { op: "restore", passphrase: "a long enough passphrase" },
    ]);
  });

  it("does not offer restore when nothing is stored", async () => {
    setup(createFakeGateway({ credentialBackup: { remotePresent: false } }));
    await screen.findByTestId("credential-backup-state");
    expect(
      screen.queryByLabelText("Credential passphrase to restore"),
    ).not.toBeInTheDocument();
  });

  it("explains when device trust blocks the stored backup", async () => {
    setup(
      createFakeGateway({
        credentialBackup: {
          remotePresent: null,
          remoteIssue: {
            code: "unknown-signer",
            message: "Unknown signer dev_pending",
          },
        },
      }),
    );

    const warning = await screen.findByTestId("credential-backup-remote-issue");
    expect(warning).toHaveTextContent(/Unknown signer dev_pending/i);
    expect(warning).toHaveTextContent(/Projects.*Devices.*approve this device/i);
    expect(
      screen.queryByLabelText("Credential passphrase to restore"),
    ).not.toBeInTheDocument();
  });

  it("surfaces a wrong restore passphrase as an actionable error", async () => {
    const { user } = setup(
      createFakeGateway({
        credentialBackup: { remotePresent: true },
        failRestoreCredentials: {
          code: "wrong-passphrase",
          message: "That passphrase does not open the stored backup.",
        },
      }),
    );
    await screen.findByTestId("credential-backup-state");
    await user.type(screen.getByLabelText("Credential passphrase to restore"), "wrong guess");
    await user.click(screen.getByRole("button", { name: /^Restore$/i }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/does not open the stored backup/i),
    );
  });

  it("shows how many credentials are involved on each side", async () => {
    setup(
      createFakeGateway({ credentialBackup: { localCount: 4, remotePresent: true } }),
    );
    const counts = await screen.findByTestId("credential-backup-counts");
    expect(counts).toHaveTextContent("4 credentials on this device");
    expect(counts).toHaveTextContent(/a backup is stored in your bucket/i);
  });
});

describe("Credential backup — the bridge is write-only", () => {
  it("exposes no method that returns a passphrase", async () => {
    const fake = createFakeGateway();
    installFakeGateway(fake);
    render(<CredentialBackupSection />);
    await screen.findByTestId("credential-backup-state");

    // A structural check on the contract itself: any future "getPassphrase" style
    // accessor would have to appear here, and there must never be one.
    const names = Object.keys(fake.api);
    expect(names.filter((n) => /passphrase/i.test(n))).toEqual([]);

    // And the state view carries no secret material of any kind.
    const res = await fake.api.credentialBackup();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Object.keys(res.value).sort()).toEqual([
      "enabled",
      "localCount",
      "minPassphraseLength",
      "remoteIssue",
      "remotePresent",
      "syncing",
    ]);
  });
});
