import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LeftRail, type Section } from "../LeftRail";

function setup(active: Section = "profiles") {
  const onChange = vi.fn();
  const onCmdK = vi.fn();
  render(<LeftRail active={active} onChange={onChange} onCmdK={onCmdK} />);
  return { onChange, onCmdK, user: userEvent.setup() };
}

describe("LeftRail", () => {
  it("offers Profiles, Projects, MCP, and Settings in that order", () => {
    setup();
    const labels = ["Profiles", "Projects", "MCP", "Settings"];
    for (const label of labels) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    // Order matters: Projects sits between Profiles and the MCP activity screen.
    const rendered = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"))
      .filter((l): l is string => labels.includes(l ?? ""));
    expect(rendered).toEqual(labels);
  });

  it("advertises the ⌘1 / ⌘2 / ⌘3 / ⌘, accelerators", () => {
    setup();
    expect(screen.getByRole("button", { name: "Profiles" })).toHaveAttribute(
      "title",
      "Profiles · ⌘1",
    );
    expect(screen.getByRole("button", { name: "Projects" })).toHaveAttribute(
      "title",
      "Projects · ⌘2",
    );
    expect(screen.getByRole("button", { name: "MCP" })).toHaveAttribute("title", "MCP · ⌘3");
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute(
      "title",
      "Settings · ⌘,",
    );
  });

  it("reports the clicked section", async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole("button", { name: "Projects" }));
    expect(onChange).toHaveBeenCalledWith("projects");
  });

  it("marks the active section for assistive technology", () => {
    setup("projects");
    expect(screen.getByRole("button", { name: "Projects" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Profiles" })).not.toHaveAttribute("aria-current");
  });

  it("still exposes the command palette", async () => {
    const { onCmdK, user } = setup();
    await user.click(screen.getByRole("button", { name: /command palette/i }));
    expect(onCmdK).toHaveBeenCalled();
  });
});
