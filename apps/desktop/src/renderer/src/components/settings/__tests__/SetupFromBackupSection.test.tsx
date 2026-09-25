import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { SetupFromBackupSection } from "../SetupFromBackupSection";
import {
  createFakeGateway,
  installFakeGateway,
  type FakeGateway,
} from "../../../__tests__/fakeGateway";

function setup(fake: FakeGateway) {
  installFakeGateway(fake);
  render(<SetupFromBackupSection />);
  return { user: userEvent.setup(), fake };
}

/** Fill the mandatory fields; the form refuses to run without them. */
async function fillRequired(
  user: ReturnType<typeof userEvent.setup>,
  over: { credentialPassphrase?: string } = {},
): Promise<void> {
  await user.type(screen.getByLabelText("Bucket"), "my-bucket");
  await user.type(screen.getByLabelText("S3 access key ID"), "AKIA-test");
  await user.type(screen.getByLabelText("S3 secret access key"), "s3-secret-test");
  await user.type(screen.getByLabelText("Encryption password"), "repo-password");
  if (over.credentialPassphrase !== undefined) {
    await user.type(
      screen.getByLabelText("Credential passphrase (optional)"),
      over.credentialPassphrase,
    );
  }
}

describe("Set up from backup — the form", () => {
  it("explains what it does and that re-running is safe", () => {
    setup(createFakeGateway());
    expect(screen.getByText(/For a new or rebuilt machine/i)).toBeInTheDocument();
    expect(screen.getByText(/Safe to run more than once/i)).toBeInTheDocument();
  });

  it("renders nothing when the bridge lacks the channel", () => {
    const fake = createFakeGateway();
    installFakeGateway(fake);
    const w = window as unknown as { multizen: { gateway: Record<string, unknown> } };
    delete w.multizen.gateway.setupFromBackup;
    const { container } = render(<SetupFromBackupSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("will not start without the bucket and both secrets", async () => {
    const { user, fake } = setup(createFakeGateway());
    await user.click(screen.getByRole("button", { name: /Set up this device from a backup/i }));
    expect(screen.getByRole("button", { name: /Start setup/i })).toBeDisabled();

    await user.type(screen.getByLabelText("Bucket"), "my-bucket");
    expect(screen.getByRole("button", { name: /Start setup/i })).toBeDisabled();

    await user.type(screen.getByLabelText("S3 access key ID"), "AKIA-test");
    await user.type(screen.getByLabelText("S3 secret access key"), "s3-secret-test");
    expect(screen.getByRole("button", { name: /Start setup/i })).toBeDisabled();

    await user.type(screen.getByLabelText("Encryption password"), "repo-password");
    expect(screen.getByRole("button", { name: /Start setup/i })).toBeEnabled();
    expect(fake.api.setupFromBackup).not.toHaveBeenCalled();
  });

  it("omits the credential passphrase rather than sending an empty one", async () => {
    // An empty string would make the backend try and fail; omitting it is what
    // makes the backend skip the stage instead.
    const { user, fake } = setup(createFakeGateway());
    await user.click(screen.getByRole("button", { name: /Set up this device from a backup/i }));
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: /Start setup/i }));

    await waitFor(() => expect(fake.state.setupRuns).toHaveLength(1));
    const sent = fake.state.setupRuns[0];
    expect(sent).toBeDefined();
    expect("credentialPassphrase" in (sent as object)).toBe(false);
    expect(sent?.storage.s3Bucket).toBe("my-bucket");
    expect(sent?.secrets.kopiaPassword).toBe("repo-password");
  });

  it("passes the credential passphrase through when one is given", async () => {
    const { user, fake } = setup(createFakeGateway());
    await user.click(screen.getByRole("button", { name: /Set up this device from a backup/i }));
    await fillRequired(user, { credentialPassphrase: "a long enough passphrase" });
    await user.click(screen.getByRole("button", { name: /Start setup/i }));

    await waitFor(() => expect(fake.state.setupRuns).toHaveLength(1));
    expect(fake.state.setupRuns[0]?.credentialPassphrase).toBe("a long enough passphrase");
  });

  it("clears the secret fields after a run but keeps the bucket for a retry", async () => {
    const { user } = setup(createFakeGateway());
    await user.click(screen.getByRole("button", { name: /Set up this device from a backup/i }));
    await fillRequired(user, { credentialPassphrase: "a long enough passphrase" });
    await user.click(screen.getByRole("button", { name: /Start setup/i }));

    await waitFor(() => expect(screen.getByTestId("setup-summary")).toBeInTheDocument());
    expect(screen.getByLabelText("S3 secret access key")).toHaveValue("");
    expect(screen.getByLabelText("Encryption password")).toHaveValue("");
    expect(screen.getByLabelText("Credential passphrase (optional)")).toHaveValue("");
    // Retrying after approval should not mean retyping coordinates.
    expect(screen.getByLabelText("Bucket")).toHaveValue("my-bucket");
    expect(document.body.innerHTML).not.toContain("s3-secret-test");
    expect(document.body.innerHTML).not.toContain("repo-password");
  });
});

describe("Set up from backup — the report", () => {
  it("lists every stage in dependency order with its outcome", async () => {
    const { user } = setup(createFakeGateway());
    await user.click(screen.getByRole("button", { name: /Set up this device from a backup/i }));
    await fillRequired(user, { credentialPassphrase: "a long enough passphrase" });
    await user.click(screen.getByRole("button", { name: /Start setup/i }));

    const list = await screen.findByTestId("setup-stages");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(7);
    // The order is the dependency order, not the order events happened to arrive.
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "stage-storage",
      "stage-trust",
      "stage-settings",
      "stage-projects",
      "stage-bindings",
      "stage-credentials",
      "stage-profiles",
    ]);
    expect(within(list).getByText("Restore MCP projects")).toBeInTheDocument();
    expect(within(list).getByText("2 projects restored.")).toBeInTheDocument();
  });

  it("shows a skipped credential stage as skipped, not as success", async () => {
    // Without a passphrase the operator has NOT got their server secrets back, and
    // the report must not imply otherwise.
    const { user } = setup(createFakeGateway());
    await user.click(screen.getByRole("button", { name: /Set up this device from a backup/i }));
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: /Start setup/i }));

    const row = await screen.findByTestId("stage-credentials");
    expect(row).toHaveTextContent(/No credential passphrase given/i);
    expect(row).not.toHaveTextContent(/credentials restored/i);
  });

  it("reports gaps rather than claiming success when a stage failed", async () => {
    const { user } = setup(
      createFakeGateway({
        setupResult: {
          ok: false,
          stages: [
            { id: "storage", status: "done", detail: "Storage reachable." },
            { id: "trust", status: "done", detail: "Trust registry adopted." },
            { id: "settings", status: "done", detail: null },
            { id: "projects", status: "done", detail: "1 project restored." },
            { id: "bindings", status: "done", detail: null },
            {
              id: "credentials",
              status: "failed",
              detail: "The credential passphrase does not open the stored backup.",
            },
            { id: "profiles", status: "done", detail: "2 profiles restored." },
          ],
          deviceId: "device_fake",
          canPublish: true,
          awaitingApproval: false,
        },
      }),
    );
    await user.click(screen.getByRole("button", { name: /Set up this device from a backup/i }));
    await fillRequired(user, { credentialPassphrase: "wrong" });
    await user.click(screen.getByRole("button", { name: /Start setup/i }));

    await waitFor(() =>
      expect(screen.getByTestId("setup-summary")).toHaveTextContent(/finished with gaps/i),
    );
    expect(screen.getByTestId("stage-credentials")).toHaveTextContent(/does not open/i);
    // Actionable: it says a re-run is the way forward.
    expect(screen.getByTestId("setup-summary")).toHaveTextContent(/run it again/i);
  });

  it("shows stages that never ran as not reached", async () => {
    const { user } = setup(
      createFakeGateway({
        setupResult: {
          ok: false,
          stages: [
            { id: "storage", status: "failed", detail: "Bucket not configured" },
            { id: "trust", status: "pending", detail: null },
            { id: "settings", status: "pending", detail: null },
            { id: "projects", status: "pending", detail: null },
            { id: "bindings", status: "pending", detail: null },
            { id: "credentials", status: "pending", detail: null },
            { id: "profiles", status: "pending", detail: null },
          ],
          deviceId: null,
          canPublish: false,
          awaitingApproval: false,
        },
      }),
    );
    await user.click(screen.getByRole("button", { name: /Set up this device from a backup/i }));
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: /Start setup/i }));

    await waitFor(() =>
      expect(screen.getByTestId("stage-storage")).toHaveTextContent(/Bucket not configured/),
    );
    expect(screen.getByTestId("stage-projects")).toHaveTextContent(/Not reached/i);
  });

  it("explains the read-only consequence when the device awaits approval", async () => {
    const { user } = setup(
      createFakeGateway({
        setupResult: {
          ok: true,
          stages: [{ id: "storage", status: "done", detail: null }],
          deviceId: "device_new",
          canPublish: false,
          awaitingApproval: true,
        },
      }),
    );
    await user.click(screen.getByRole("button", { name: /Set up this device from a backup/i }));
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: /Start setup/i }));

    const note = await screen.findByTestId("setup-awaiting-approval");
    // The operator needs both halves: reading worked, publishing will not until
    // another device approves this one.
    expect(note).toHaveTextContent(/can read everything above/i);
    expect(note).toHaveTextContent(/will not reach your other devices/i);
  });

  it("surfaces a rejected request as an error", async () => {
    const { user } = setup(
      createFakeGateway({
        failSetup: { code: "invalid", message: "Enter the bucket that holds your backup." },
      }),
    );
    await user.click(screen.getByRole("button", { name: /Set up this device from a backup/i }));
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: /Start setup/i }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/Enter the bucket/i),
    );
  });

  it("subscribes to live progress and unsubscribes when the run ends", async () => {
    const { user, fake } = setup(createFakeGateway());
    await user.click(screen.getByRole("button", { name: /Set up this device from a backup/i }));
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: /Start setup/i }));

    await waitFor(() => expect(screen.getByTestId("setup-summary")).toBeInTheDocument());
    expect(fake.api.onSetupProgress).toHaveBeenCalledTimes(1);
    // No listener is left behind to fire after the component moves on.
    expect(fake.state.setupListeners).toHaveLength(0);
  });
});
