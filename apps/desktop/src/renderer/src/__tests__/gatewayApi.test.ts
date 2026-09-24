import { describe, expect, it } from "vitest";

import {
  binding,
  createFakeGateway,
  installFakeGateway,
  project,
} from "./fakeGateway";
import type { MultizenApi } from "../types";

/**
 * These tests pin the renderer's contract with the preload bridge. Components
 * are written against `window.multizen.gateway`, so this is the surface that
 * must stay stable — and the surface that must never hand back a secret.
 */

function gateway(): MultizenApi["gateway"] {
  return window.multizen.gateway;
}

describe("the gateway preload surface", () => {
  it("exposes every method the Projects UI depends on", () => {
    installFakeGateway(createFakeGateway());
    const api = gateway();
    for (const method of [
      // projects
      "listProjects",
      "getProject",
      "createProject",
      "updateProject",
      "deleteProject",
      "setupProject",
      // exclusive profile binding
      "bindProfile",
      "bindableProfiles",
      // servers
      "addServer",
      "updateServer",
      "removeServer",
      "setServerEnabled",
      "restartServer",
      // auth
      "setAuthEnabled",
      "authStatus",
      "generateToken",
      // endpoints + runtime
      "endpoints",
      "runtime",
      // references
      "secretRefs",
      "approveEnvName",
      "revokeEnvName",
      "saveManagedSecret",
      "deleteManagedSecret",
      // directories + agents
      "pickDirectory",
      "directories",
      "setDirectoryAgents",
      "removeDirectory",
      "reconcileDirectories",
      "retryDirectoryAgent",
      "revealPath",
    ] as const) {
      expect(typeof api[method], `gateway.${method}`).toBe("function");
    }
  });

  it("has no method that reads a managed secret back", () => {
    installFakeGateway(createFakeGateway());
    const names = Object.keys(gateway());
    // Write-only by construction: a "get/read/reveal" counterpart must not exist.
    expect(names).toContain("saveManagedSecret");
    expect(names).not.toContain("getManagedSecret");
    expect(names).not.toContain("readManagedSecret");
    expect(names).not.toContain("revealManagedSecret");
  });
});

describe("result envelopes", () => {
  it("returns a discriminated ok envelope that carries the value", async () => {
    installFakeGateway(createFakeGateway({ projects: [project("alpha")] }));
    const res = await gateway().getProject("alpha");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.id).toBe("alpha");
  });

  it("returns a structured error envelope instead of throwing", async () => {
    installFakeGateway(createFakeGateway());
    const res = await gateway().getProject("missing");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("not-found");
      expect(typeof res.error.message).toBe("string");
    }
  });

  it("surfaces a list failure as an error envelope the UI can render", async () => {
    installFakeGateway(createFakeGateway({ failList: "disk exploded" }));
    const res = await gateway().listProjects();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toBe("disk exploded");
  });
});

describe("arguments reach the bridge unchanged", () => {
  it("forwards project id, directory, and agent selection verbatim", async () => {
    const fake = createFakeGateway({ projects: [project("alpha")] });
    installFakeGateway(fake);
    await gateway().setDirectoryAgents("alpha", "/abs/work", ["codex", "kiro-cli"]);
    expect(fake.api.setDirectoryAgents).toHaveBeenCalledWith("alpha", "/abs/work", [
      "codex",
      "kiro-cli",
    ]);
  });

  it("forwards a stdio server input including its ${NAME} env references", async () => {
    const fake = createFakeGateway({ projects: [project("alpha")] });
    installFakeGateway(fake);
    const input = {
      transport: "stdio" as const,
      id: "srv",
      command: "npx",
      args: ["-y", "some-mcp"],
      env: { API_TOKEN: "${API_TOKEN}" },
    };
    const res = await gateway().addServer("alpha", input);
    expect(fake.api.addServer).toHaveBeenCalledWith("alpha", input);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const server = res.value.servers[0];
      expect(server?.transport).toBe("stdio");
      if (server?.transport === "stdio") {
        // The view carries the REFERENCE, never an expanded value.
        expect(server.env.API_TOKEN).toBe("${API_TOKEN}");
      }
    }
  });
});

describe("secret handling through the bridge", () => {
  it("saveManagedSecret takes a value and returns only presence metadata", async () => {
    const secret = "sk-live-do-not-leak";
    const fake = createFakeGateway({
      projects: [project("alpha")],
      secretRefs: {
        alpha: [
          { name: "API_TOKEN", source: null, present: false, approved: false, managed: false },
        ],
      },
    });
    installFakeGateway(fake);

    const res = await gateway().saveManagedSecret("alpha", "API_TOKEN", secret);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value[0]?.managed).toBe(true);
      expect(res.value[0]?.present).toBe(true);
      expect(res.value[0]?.source).toBe("managed");
      // The returned payload must not echo the value back.
      expect(JSON.stringify(res.value)).not.toContain(secret);
    }
    // Nor may any subsequent read expose it.
    const refs = await gateway().secretRefs("alpha");
    expect(JSON.stringify(refs)).not.toContain(secret);
  });

  it("generateToken is the only method that returns a token, and only once", async () => {
    const fake = createFakeGateway({ projects: [project("alpha")] });
    installFakeGateway(fake);

    const generated = await gateway().generateToken("alpha");
    expect(generated.ok).toBe(true);
    const token = generated.ok ? generated.value.token : "";
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // Every other surface reports presence only.
    const status = await gateway().authStatus("alpha");
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.value.tokenPresent).toBe(true);
      expect(JSON.stringify(status.value)).not.toContain(token);
    }
    const p = await gateway().getProject("alpha");
    expect(JSON.stringify(p)).not.toContain(token);
  });
});

describe("guided setup through the bridge", () => {
  it("creates disabled, installs, then enables — in that order", async () => {
    const fake = createFakeGateway();
    installFakeGateway(fake);

    const res = await gateway().setupProject({
      id: "zabit",
      label: "Zabit",
      server: { transport: "stdio", id: "docs", command: "npx", args: ["-y", "docs-mcp"] },
      directories: [{ directory: "/abs/work", agents: ["cursor", "codex"] }],
      enableWhenReady: true,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.project.id).toBe("zabit");
      expect(res.value.enabled).toBe(true);
      expect(res.value.reconcile.allCurrent).toBe(true);
      expect(res.value.reconcile.bindings[0]?.directory).toBe("/abs/work");
    }
    // The project was created DISABLED; enabling came afterwards.
    expect(fake.api.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: "zabit", enabled: false }),
    );
    expect(fake.api.updateProject).toHaveBeenCalledWith("zabit", { enabled: true });
  });

  it("refuses a duplicate id without touching anything else", async () => {
    const fake = createFakeGateway({ projects: [project("taken")] });
    installFakeGateway(fake);
    const res = await gateway().setupProject({ id: "taken" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("conflict");
    expect(fake.api.setDirectoryAgents).not.toHaveBeenCalled();
  });
});

describe("exclusive profile binding through the bridge", () => {
  it("reports the conflicting project in a machine-readable code", async () => {
    const fake = createFakeGateway({
      projects: [project("beta")],
      profiles: [
        { profileId: "prof-a", name: "Profile A", boundToProjectId: "alpha", available: false },
      ],
    });
    installFakeGateway(fake);

    const res = await gateway().bindProfile("beta", "prof-a");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("profile-bound:alpha");
  });

  it("marks a profile held by another project unavailable, naming the holder", async () => {
    installFakeGateway(
      createFakeGateway({
        profiles: [
          { profileId: "prof-a", name: "A", boundToProjectId: "alpha", available: false },
          { profileId: "prof-b", name: "B", available: true },
        ],
      }),
    );
    const res = await gateway().bindableProfiles("beta");
    expect(res.ok).toBe(true);
    if (res.ok) {
      const byId = new Map(res.value.map((p) => [p.profileId, p]));
      expect(byId.get("prof-a")?.available).toBe(false);
      expect(byId.get("prof-a")?.boundToProjectId).toBe("alpha");
      expect(byId.get("prof-b")?.available).toBe(true);
    }
  });
});

describe("directory + agent state through the bridge", () => {
  it("round-trips a binding with per-agent status and config paths", async () => {
    installFakeGateway(
      createFakeGateway({
        projects: [project("alpha")],
        directories: { alpha: [binding("alpha", "/abs/work", ["cursor", "codex"])] },
      }),
    );
    const res = await gateway().directories("alpha");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toHaveLength(1);
      expect(res.value[0]?.agents.map((a) => a.agent)).toEqual(["cursor", "codex"]);
      for (const agent of res.value[0]?.agents ?? []) {
        expect(agent.status).toBe("current");
        expect(typeof agent.configPath).toBe("string");
      }
    }
  });

  it("pickDirectory can return null when the operator cancels", async () => {
    installFakeGateway(createFakeGateway({ pickResult: null }));
    expect(await gateway().pickDirectory()).toBeNull();
  });
});
