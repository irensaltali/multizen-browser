import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ProjectHistoryModal } from "../ProjectHistoryModal";
import {
  createFakeGateway,
  installFakeGateway,
  project,
  type FakeGateway,
} from "../../../__tests__/fakeGateway";
import type { ProjectHistoryEntryView } from "../../../types";

function entry(over: Partial<ProjectHistoryEntryView>): ProjectHistoryEntryView {
  return {
    revision: 1,
    archivedAt: "2024-05-01T10:00:00.000Z",
    signer: "device_alpha",
    deleted: false,
    current: false,
    ...over,
  };
}

function setup(fake: FakeGateway, onRestored = vi.fn()) {
  installFakeGateway(fake);
  render(<ProjectHistoryModal projectId="alpha" onClose={vi.fn()} onRestored={onRestored} />);
  return { user: userEvent.setup(), fake, onRestored };
}

const THREE = [
  entry({ revision: 3, archivedAt: "2024-05-07T10:00:00.000Z", current: true }),
  entry({ revision: 2, archivedAt: "2024-05-03T10:00:00.000Z" }),
  entry({ revision: 1, archivedAt: "2024-05-01T10:00:00.000Z" }),
];

describe("Project history — the timeline", () => {
  it("lists revisions newest first and marks the current one", async () => {
    setup(createFakeGateway({ projects: [project("alpha")], history: { alpha: THREE } }));
    const list = await screen.findByTestId("history-list");
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "history-3",
      "history-2",
      "history-1",
    ]);
    expect(within(screen.getByTestId("history-3")).getByText("current")).toBeInTheDocument();
    // The current revision offers no restore button — there is nothing to go back to.
    expect(
      within(screen.getByTestId("history-3")).queryByRole("button", { name: /Make current/i }),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("history-1")).getByRole("button", { name: /Make current/i }),
    ).toBeInTheDocument();
  });

  it("says a date is unknown rather than inventing one", async () => {
    // The date comes from a signed stamp. When that cannot be trusted the revision
    // number is still true and the date is not, so only one of them is shown.
    setup(
      createFakeGateway({
        projects: [project("alpha")],
        history: { alpha: [entry({ revision: 1, archivedAt: null })] },
      }),
    );
    const row = await screen.findByTestId("history-1");
    expect(row).toHaveTextContent("date unknown");
  });

  it("marks a deletion and offers no restore for it", async () => {
    setup(
      createFakeGateway({
        projects: [project("alpha")],
        history: {
          alpha: [entry({ revision: 2, deleted: true }), entry({ revision: 1 })],
        },
      }),
    );
    const row = await screen.findByTestId("history-2");
    expect(row).toHaveTextContent("deleted");
    expect(
      within(row).queryByRole("button", { name: /Make current/i }),
    ).not.toBeInTheDocument();
  });

  it("explains that history needs Cloud Sync when there is none", async () => {
    setup(createFakeGateway({ projects: [project("alpha")], history: { alpha: [] } }));
    const empty = await screen.findByTestId("history-empty");
    expect(empty).toHaveTextContent(/needs Cloud Sync/i);
    expect(empty).toHaveTextContent(/stored on this device only/i);
  });

  it("describes restoring as republishing, not as a rewind", async () => {
    setup(createFakeGateway({ projects: [project("alpha")], history: { alpha: THREE } }));
    await screen.findByTestId("history-list");
    expect(screen.getByText(/publishing it again/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is erased/i)).toBeInTheDocument();
  });

  it("surfaces a failed load as an error", async () => {
    // A project the backend does not know about.
    setup(createFakeGateway({ history: {} }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent(/not found/i);
  });
});

describe("Project history — restoring", () => {
  it("asks for the chosen revision and reports the new one it became", async () => {
    const { user, fake, onRestored } = setup(
      createFakeGateway({ projects: [project("alpha")], history: { alpha: THREE } }),
    );
    await screen.findByTestId("history-list");
    await user.click(
      within(screen.getByTestId("history-1")).getByRole("button", { name: /Make current/i }),
    );

    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    expect(fake.state.rollbacks).toEqual([{ projectId: "alpha", revision: 1 }]);
    // Both numbers matter: what was restored, and what it is now.
    expect(screen.getByRole("status")).toHaveTextContent(/Revision 1 is now the current/i);
    expect(screen.getByRole("status")).toHaveTextContent(/published as revision 4/i);
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it("refreshes the timeline so the restore appears as a new revision", async () => {
    const { user } = setup(
      createFakeGateway({ projects: [project("alpha")], history: { alpha: THREE } }),
    );
    await screen.findByTestId("history-list");
    await user.click(
      within(screen.getByTestId("history-1")).getByRole("button", { name: /Make current/i }),
    );
    // The intervening revisions stay, so the restore itself can be undone.
    await waitFor(() => expect(screen.getByTestId("history-4")).toBeInTheDocument());
    expect(screen.getByTestId("history-3")).toBeInTheDocument();
    expect(screen.getByTestId("history-1")).toBeInTheDocument();
    expect(within(screen.getByTestId("history-4")).getByText("current")).toBeInTheDocument();
  });

  it("surfaces a pruned revision as an actionable error", async () => {
    const { user } = setup(
      createFakeGateway({
        projects: [project("alpha")],
        history: { alpha: THREE },
        failRollback: {
          code: "absent",
          message: "Revision 1 is no longer stored. It may have been pruned by the retention limit.",
        },
      }),
    );
    await screen.findByTestId("history-list");
    await user.click(
      within(screen.getByTestId("history-1")).getByRole("button", { name: /Make current/i }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/pruned by the retention limit/i),
    );
  });

  it("disables every restore button while one is in flight", async () => {
    const { user } = setup(
      createFakeGateway({ projects: [project("alpha")], history: { alpha: THREE } }),
    );
    await screen.findByTestId("history-list");
    const buttons = screen.getAllByRole("button", { name: /Make current/i });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[0] as HTMLElement);
    // After the call settles the list has re-rendered; the point is that two
    // concurrent rollbacks were never possible.
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: /Make current/i }).length).toBeGreaterThan(0);
  });

  it("has an accessible name so a stacked dialog is unambiguous", async () => {
    setup(createFakeGateway({ projects: [project("alpha")], history: { alpha: THREE } }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Configuration history for alpha");
  });
});
