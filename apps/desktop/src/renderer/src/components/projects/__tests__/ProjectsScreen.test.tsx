import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ConfirmHost } from "../../atoms";
import { ProjectsScreen } from "../ProjectsScreen";
import {
  createFakeGateway,
  installFakeGateway,
  project,
  type FakeGateway,
} from "../../../__tests__/fakeGateway";

function setup(fake: FakeGateway): { user: ReturnType<typeof userEvent.setup> } {
  installFakeGateway(fake);
  render(
    <>
      <ProjectsScreen />
      <ConfirmHost />
    </>,
  );
  return { user: userEvent.setup() };
}

describe("Projects screen — load states", () => {
  it("shows a loading state, then the list", async () => {
    const fake = createFakeGateway({ projects: [project("alpha", { label: "Alpha" })] });
    setup(fake);
    expect(screen.getByRole("status")).toHaveTextContent(/loading projects/i);
    expect(await screen.findByRole("button", { name: /Alpha/ })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows an empty state with a create affordance", async () => {
    setup(createFakeGateway());
    expect(await screen.findByText(/no projects yet/i)).toBeInTheDocument();
    // Both the header "New" and the empty-state "New project" can start setup.
    expect(screen.getByRole("button", { name: /^New project$/ })).toBeInTheDocument();
    expect(screen.getByText(/create your first project/i)).toBeInTheDocument();
  });

  it("renders a retryable error when the list fails", async () => {
    const fake = createFakeGateway({ failList: "gateway unavailable" });
    const { user } = setup(fake);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn’t load projects/i);
    expect(alert).toHaveTextContent(/gateway unavailable/);

    await user.click(screen.getByRole("button", { name: /try again/i }));
    // The retry re-invokes the bridge rather than silently giving up.
    expect(fake.api.listProjects).toHaveBeenCalledTimes(2);
  });
});

describe("Projects screen — selection", () => {
  it("starts with nothing selected and a helpful placeholder", async () => {
    setup(createFakeGateway({ projects: [project("alpha", { label: "Alpha" })] }));
    expect(await screen.findByText(/select a project/i)).toBeInTheDocument();
    expect(screen.queryByTestId("project-detail")).not.toBeInTheDocument();
  });

  it("opens the detail pane for the clicked project", async () => {
    const { user } = setup(
      createFakeGateway({
        projects: [project("alpha", { label: "Alpha" }), project("beta", { label: "Beta" })],
      }),
    );
    await user.click(await screen.findByRole("button", { name: /Alpha/ }));
    const detail = screen.getByTestId("project-detail");
    expect(within(detail).getByRole("heading", { name: "Alpha" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Beta/ }));
    expect(
      within(screen.getByTestId("project-detail")).getByRole("heading", { name: "Beta" }),
    ).toBeInTheDocument();
  });

  it("marks the selected row for assistive technology", async () => {
    const { user } = setup(
      createFakeGateway({ projects: [project("alpha", { label: "Alpha" })] }),
    );
    const row = await screen.findByRole("button", { name: /Alpha/ });
    expect(row).not.toHaveAttribute("aria-current");
    await user.click(row);
    expect(screen.getByRole("button", { name: /Alpha/ })).toHaveAttribute("aria-current", "true");
  });
});

describe("Projects screen — list summary", () => {
  it("summarises enable state, server counts, browser binding, and auth", async () => {
    setup(
      createFakeGateway({
        projects: [
          project("alpha", {
            label: "Alpha",
            enabled: true,
            browserProfileId: "prof-1",
            localAuth: { enabled: true, tokenPresent: true },
            servers: [
              {
                transport: "stdio",
                id: "a",
                disabled: false,
                command: "x",
                args: [],
                env: {},
              },
              {
                transport: "stdio",
                id: "b",
                disabled: true,
                command: "y",
                args: [],
                env: {},
              },
            ],
          }),
          project("beta", { label: "Beta", enabled: false }),
        ],
      }),
    );
    const alpha = await screen.findByRole("button", { name: /Alpha/ });
    expect(alpha).toHaveTextContent("on");
    expect(alpha).toHaveTextContent("1/2 servers");
    expect(alpha).toHaveTextContent("browser");
    expect(alpha).toHaveTextContent("auth");

    const beta = screen.getByRole("button", { name: /Beta/ });
    expect(beta).toHaveTextContent("off");
    expect(beta).toHaveTextContent("0/0 servers");
    expect(beta).not.toHaveTextContent("browser");
  });

  it("sorts projects by display name", async () => {
    setup(
      createFakeGateway({
        projects: [
          project("zeta", { label: "Zeta" }),
          project("alpha", { label: "Alpha" }),
          project("mid", { label: "Mid" }),
        ],
      }),
    );
    await screen.findByRole("button", { name: /Alpha/ });
    const labels = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      .filter((t) => /Alpha|Mid|Zeta/.test(t));
    expect(labels[0]).toMatch(/Alpha/);
    expect(labels[1]).toMatch(/Mid/);
    expect(labels[2]).toMatch(/Zeta/);
  });
});

describe("Projects screen — search", () => {
  it("filters by label and by id, and explains an empty result", async () => {
    const { user } = setup(
      createFakeGateway({
        projects: [
          project("alpha", { label: "Alpha" }),
          project("beta-two", { label: "Beta" }),
        ],
      }),
    );
    await screen.findByRole("button", { name: /Alpha/ });
    const search = screen.getByLabelText("Search projects");

    await user.type(search, "beta");
    expect(screen.queryByRole("button", { name: /Alpha/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Beta/ })).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "alph");
    expect(screen.getByRole("button", { name: /Alpha/ })).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "nothing-matches");
    expect(screen.getByText(/no project matches/i)).toBeInTheDocument();
    // The empty-state for "no projects at all" must NOT appear here.
    expect(screen.queryByText(/no projects yet/i)).not.toBeInTheDocument();
  });
});

describe("Projects screen — enable toggle", () => {
  it("toggles a project and reflects the new state", async () => {
    const fake = createFakeGateway({
      projects: [project("alpha", { label: "Alpha", enabled: false })],
    });
    const { user } = setup(fake);
    await user.click(await screen.findByRole("button", { name: /Alpha/ }));

    const toggle = screen.getByRole("switch", { name: /project enabled/i });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);

    expect(fake.api.updateProject).toHaveBeenCalledWith("alpha", { enabled: true });
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: /project enabled/i })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });
  });

  it("shows an inline error when a mutation fails", async () => {
    const fake = createFakeGateway({ projects: [project("alpha", { label: "Alpha" })] });
    const { user } = setup(fake);
    await user.click(await screen.findByRole("button", { name: /Alpha/ }));

    fake.api.updateProject = (async () => ({
      ok: false as const,
      error: { code: "io", message: "backend said no" },
    })) as typeof fake.api.updateProject;
    installFakeGateway(fake);

    await user.click(screen.getByRole("switch", { name: /project enabled/i }));
    expect(await screen.findByText("backend said no")).toBeInTheDocument();
  });
});

describe("Projects screen — rename", () => {
  it("autosaves the name on blur", async () => {
    const fake = createFakeGateway({ projects: [project("alpha", { label: "Alpha" })] });
    const { user } = setup(fake);
    await user.click(await screen.findByRole("button", { name: /Alpha/ }));

    const nameInput = screen.getByLabelText("Project name");
    await user.clear(nameInput);
    await user.type(nameInput, "Renamed");
    await user.tab();

    expect(fake.api.updateProject).toHaveBeenCalledWith("alpha", { label: "Renamed" });
  });

  it("does not save when the name is unchanged", async () => {
    const fake = createFakeGateway({ projects: [project("alpha", { label: "Alpha" })] });
    const { user } = setup(fake);
    await user.click(await screen.findByRole("button", { name: /Alpha/ }));

    await user.click(screen.getByLabelText("Project name"));
    await user.tab();
    expect(fake.api.updateProject).not.toHaveBeenCalled();
  });
});

describe("Projects screen — deletion", () => {
  it("asks for confirmation and explains what is and is not removed", async () => {
    const fake = createFakeGateway({ projects: [project("alpha", { label: "Alpha" })] });
    const { user } = setup(fake);
    await user.click(await screen.findByRole("button", { name: /Alpha/ }));
    await user.click(screen.getByRole("button", { name: /^Delete$/ }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/Delete “Alpha”\?/);
    expect(dialog).toHaveTextContent(/remove this project’s MCP entries/i);
    expect(dialog).toHaveTextContent(/browser profile.*left untouched/i);
    // Cancelling deletes nothing.
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(fake.api.deleteProject).not.toHaveBeenCalled();
  });

  it("deletes on confirmation and clears the selection", async () => {
    const fake = createFakeGateway({ projects: [project("alpha", { label: "Alpha" })] });
    const { user } = setup(fake);
    await user.click(await screen.findByRole("button", { name: /Alpha/ }));
    await user.click(screen.getByRole("button", { name: /^Delete$/ }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: /delete project/i,
      }),
    );

    expect(fake.api.deleteProject).toHaveBeenCalledWith("alpha");
    await waitFor(() => {
      expect(screen.queryByTestId("project-detail")).not.toBeInTheDocument();
    });
    expect(await screen.findByText(/no projects yet/i)).toBeInTheDocument();
  });

  it("keeps the project and shows the reason when cleanup fails", async () => {
    const fake = createFakeGateway({ projects: [project("alpha", { label: "Alpha" })] });
    fake.api.deleteProject = (async () => ({
      ok: false as const,
      error: {
        code: "cleanup-failed",
        message: "could not remove entries from cursor — fix the file and delete again",
      },
    })) as typeof fake.api.deleteProject;
    const { user } = setup(fake);
    await user.click(await screen.findByRole("button", { name: /Alpha/ }));
    await user.click(screen.getByRole("button", { name: /^Delete$/ }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: /delete project/i,
      }),
    );

    expect(await screen.findByText(/could not remove entries from cursor/i)).toBeInTheDocument();
    // Still selected, still present.
    expect(screen.getByTestId("project-detail")).toBeInTheDocument();
  });
});

describe("Projects screen — creation", () => {
  /** Walk the wizard's intermediate steps to its final one. */
  async function toLastStep(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      await user.click(screen.getByRole("button", { name: /continue/i }));
    }
  }

  it("creates a project through one setup call and selects it", async () => {
    const fake = createFakeGateway();
    const { user } = setup(fake);
    await screen.findByText(/no projects yet/i);

    await user.click(screen.getByRole("button", { name: /^New project$/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Project name"), "Zabit Docs");
    // The id is derived from the name.
    expect(within(dialog).getByLabelText("Project id")).toHaveValue("zabit-docs");
    await toLastStep(user);
    await user.click(within(dialog).getByRole("button", { name: /create project/i }));

    expect(fake.api.setupProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: "zabit-docs", label: "Zabit Docs", enableWhenReady: true }),
    );
    // The new project appears and is selected.
    expect(
      within(await screen.findByTestId("project-detail")).getByRole("heading", {
        name: "Zabit Docs",
      }),
    ).toBeInTheDocument();
  });

  it("rejects an invalid id before calling the backend", async () => {
    const fake = createFakeGateway();
    const { user } = setup(fake);
    await screen.findByText(/no projects yet/i);
    await user.click(screen.getByRole("button", { name: /^New project$/ }));

    const dialog = await screen.findByRole("dialog");
    const idInput = within(dialog).getByLabelText("Project id");
    await user.type(within(dialog).getByLabelText("Project name"), "Ok");
    await user.clear(idInput);
    await user.type(idInput, "Bad ID!");

    expect(idInput).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByText(/only lower-case letters/i)).toBeInTheDocument();
    // An invalid id blocks the very first step, so setup is unreachable.
    expect(within(dialog).getByRole("button", { name: /continue/i })).toBeDisabled();
    expect(fake.api.setupProject).not.toHaveBeenCalled();
  });

  it("surfaces a duplicate-id conflict from the backend", async () => {
    const fake = createFakeGateway({ projects: [project("taken", { label: "Taken" })] });
    const { user } = setup(fake);
    await screen.findByRole("button", { name: /Taken/ });
    await user.click(screen.getByRole("button", { name: /^New$/ }));

    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Project name"), "taken");
    await toLastStep(user);
    await user.click(within(dialog).getByRole("button", { name: /create project/i }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/already exists/i);
  });
});
