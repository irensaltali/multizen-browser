import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DeleteProfileDialog } from "../DeleteProfileDialog";
const syncedStatus = {
  globalEnabled: true,
  syncEnabled: true,
  cloudAvailable: true,
};

function setup(status = syncedStatus) {
  const getStatus = vi.fn(async () => status);
  const deleteProfile = vi.fn(async (_id: string, _deleteCloudBackup?: boolean) => {});
  Object.defineProperty(window, "multizen", {
    configurable: true,
    value: { profiles: { deleteStatus: getStatus, delete: deleteProfile } },
  });
  const onDeleted = vi.fn();
  render(
    <DeleteProfileDialog
      profileId="profile-1"
      profileName="Work"
      onCancel={vi.fn()}
      onDeleted={onDeleted}
    />,
  );
  return { user: userEvent.setup(), getStatus, deleteProfile, onDeleted };
}

describe("DeleteProfileDialog", () => {
  it("requires the profile name before deleting a synced profile and its cloud backup", async () => {
    const { user, deleteProfile, onDeleted } = setup();
    const button = await screen.findByRole("button", { name: "Delete cloud backup and profile" });
    expect(button).toBeDisabled();
    await user.type(screen.getByRole("textbox"), "Work");
    await user.click(button);
    await waitFor(() => expect(deleteProfile).toHaveBeenCalledWith("profile-1", true));
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it("keeps the dialog open and shows an error when cloud deletion fails", async () => {
    const { user, deleteProfile, onDeleted } = setup();
    deleteProfile.mockRejectedValueOnce(new Error("Cloud backup deletion failed"));
    await screen.findByRole("button", { name: "Delete cloud backup and profile" });
    await user.type(screen.getByRole("textbox"), "Work");
    await user.click(screen.getByRole("button", { name: "Delete cloud backup and profile" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cloud backup deletion failed");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("deletes an unsynced profile without requesting cloud deletion", async () => {
    const { user, deleteProfile, onDeleted } = setup({
      syncEnabled: false,
      globalEnabled: false,
      cloudAvailable: false,
    });
    await user.click(await screen.findByRole("button", { name: "Delete profile" }));
    await waitFor(() => expect(deleteProfile).toHaveBeenCalledWith("profile-1", false));
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it("blocks cloud deletion while Cloud Sync is off", async () => {
    const { user, deleteProfile } = setup({ ...syncedStatus, globalEnabled: false });
    await screen.findByText(/turn on Cloud Sync in Settings/i);
    await user.type(screen.getByRole("textbox"), "Work");
    expect(screen.getByRole("button", { name: "Delete cloud backup and profile" })).toBeDisabled();
    expect(deleteProfile).not.toHaveBeenCalled();
  });
});
