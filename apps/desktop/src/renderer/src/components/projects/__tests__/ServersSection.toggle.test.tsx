import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ServersSection } from "../ServersSection";
import {
  createFakeGateway,
  installFakeGateway,
  project,
  type FakeGateway,
} from "../../../__tests__/fakeGateway";
import type { ProjectRuntimeView, ProjectView, ServerView } from "../../../types";

/**
 * The server row's on/off control, and the rule that a server which is OFF is not
 * "waiting" for anything.
 */

const REF = "MULTIZEN_FAL_AI_AUTHORIZATION_49EF54";

function httpServer(over: Partial<ServerView> = {}): ServerView {
  return {
    transport: "http",
    id: "fal-ai",
    label: "fal-ai",
    url: "https://mcp.fal.ai/mcp",
    headers: { Authorization: `\${${REF}}` },
    disabled: false,
    ...over,
  } as ServerView;
}

function withServer(server: ServerView, enabled = true): ProjectView {
  return { ...project("alpha", { enabled }), servers: [server] } as ProjectView;
}

async function setup(fake: FakeGateway, proj: ProjectView) {
  installFakeGateway(fake);
  const onChanged = vi.fn();
  const res = await fake.api.runtime(proj.id);
  render(
    <ServersSection
      project={proj}
      runtime={res.ok ? (res.value as ProjectRuntimeView) : null}
      managedRefNames={[]}
      onChanged={onChanged}
      onError={vi.fn()}
    />,
  );
  return { user: userEvent.setup(), fake, onChanged };
}

describe("Server row — the on/off control", () => {
  it("is a switch that reports its state, not a checkbox", async () => {
    // A ticked box beside the word "on" reads as a question. A switch reads as a
    // fact, and assistive tech announces on/off rather than checked/unchecked.
    const fake = createFakeGateway({ projects: [withServer(httpServer())] });
    await setup(fake, withServer(httpServer()));

    const sw = screen.getByRole("switch", { name: /fal-ai enabled/i });
    expect(sw).toBeInTheDocument();
    expect(sw).toHaveAttribute("aria-checked", "true");
    // No checkbox is left behind.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    // The switch carries no visible caption: the status pill beside it already
    // says "off"/"running", and duplicating it made the row read "off … off".
    expect(sw).toHaveTextContent("");
  });

  it("shows off when the server is disabled", async () => {
    const proj = withServer(httpServer({ disabled: true }));
    const fake = createFakeGateway({ projects: [proj] });
    await setup(fake, proj);

    const sw = screen.getByRole("switch", { name: /fal-ai enabled/i });
    expect(sw).toHaveAttribute("aria-checked", "false");
    // The state is announced through aria-checked, and shown visually by the pill.
    expect(screen.getAllByText("off")).toHaveLength(1);
  });

  it("toggles the server through the backend", async () => {
    const proj = withServer(httpServer());
    const fake = createFakeGateway({ projects: [proj] });
    const { user, onChanged } = await setup(fake, proj);

    await user.click(screen.getByRole("switch", { name: /fal-ai enabled/i }));
    await waitFor(() => expect(fake.api.setServerEnabled).toHaveBeenCalledTimes(1));
    expect(fake.api.setServerEnabled).toHaveBeenCalledWith("alpha", "fal-ai", false);
    expect(onChanged).toHaveBeenCalled();
  });

  it("can be operated from the keyboard", async () => {
    const proj = withServer(httpServer());
    const fake = createFakeGateway({ projects: [proj] });
    const { user } = await setup(fake, proj);

    // Focus it directly rather than counting Tab stops — the surrounding section
    // has its own controls, so tab order is not this component's contract. What
    // matters is that the switch is focusable and Space activates it, which is
    // what using a real <button> buys.
    const sw = screen.getByRole("switch", { name: /fal-ai enabled/i });
    sw.focus();
    expect(sw).toHaveFocus();
    await user.keyboard(" ");
    await waitFor(() => expect(fake.api.setServerEnabled).toHaveBeenCalledTimes(1));
  });
});

describe("Server row — a server that is off is not waiting for anything", () => {
  it("does not ask for a secret when the server is switched off", async () => {
    // The reported bug: an amber "Waiting for … — provide a value" line on a
    // server the operator had deliberately turned off.
    const proj = withServer(httpServer({ disabled: true }));
    const fake = createFakeGateway({ projects: [proj], unresolvedRefs: [REF] });
    await setup(fake, proj);

    expect(screen.queryByText(new RegExp(`Waiting for.*${REF}`))).not.toBeInTheDocument();
    expect(screen.queryByText(/provide a value in References/i)).not.toBeInTheDocument();
  });

  it("does ask once the server is switched on", async () => {
    // The warning is real and must not be suppressed in general — only for a
    // server that is off.
    const proj = withServer(httpServer({ disabled: false }));
    const fake = createFakeGateway({ projects: [proj], unresolvedRefs: [REF] });
    await setup(fake, proj);

    expect(screen.getByText(new RegExp(`Waiting for.*${REF}`))).toBeInTheDocument();
    expect(screen.getByText(/provide a value in References/i)).toBeInTheDocument();
  });

  it("does not ask when the whole project is off", async () => {
    const proj = withServer(httpServer({ disabled: false }), false);
    const fake = createFakeGateway({ projects: [proj], unresolvedRefs: [REF] });
    await setup(fake, proj);

    expect(screen.queryByText(/provide a value in References/i)).not.toBeInTheDocument();
  });

  it("still reports a genuine runtime error on an enabled server", async () => {
    // Suppressing the env warning must not have suppressed real failures.
    const proj = withServer(httpServer());
    const fake = createFakeGateway({ projects: [proj] });
    installFakeGateway(fake);
    render(
      <ServersSection
        project={proj}
        runtime={
          {
            projectId: "alpha",
            enabled: true,
            bootstrapped: true,
            servers: [
              {
                projectId: "alpha",
                serverId: "fal-ai",
                transport: "http",
                phase: "error",
                restarts: 2,
                consecutiveFailures: 2,
                missingEnv: [],
                sessions: 0,
                lastError: "upstream refused the connection",
              },
            ],
          } as unknown as ProjectRuntimeView
        }
        managedRefNames={[]}
        onChanged={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(screen.getByText(/upstream refused the connection/i)).toBeInTheDocument();
  });
});
