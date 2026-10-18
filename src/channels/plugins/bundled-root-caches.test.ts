import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../plugins/bundled-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/bundled-dir.js")>();
  return {
    ...actual,
    resolveBundledPluginsDir: (env: NodeJS.ProcessEnv = process.env) =>
      env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? actual.resolveBundledPluginsDir(env),
  };
});

const tempDirs: string[] = [];

function makeBundledRoot(prefix: string): { root: string; pluginsDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  const pluginsDir = path.join(root, "dist", "extensions");
  fs.mkdirSync(pluginsDir, { recursive: true });
  return { root, pluginsDir };
}

function plugin(id: string, label: string) {
  return { id, meta: { id, label }, capabilities: {}, config: {} };
}

function loadBootstrap(scope: string) {
  return importFreshModule<typeof import("./bootstrap-registry.js")>(
    import.meta.url,
    `./bootstrap-registry.js?scope=${scope}`,
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock("../../plugins/channel-catalog-registry.js");
  vi.doUnmock("./bundled.js");
});

describe("bundled root-aware plugin lookups", () => {
  it("reads bundled channel ids from the active bundled root without re-importing", async () => {
    const rootA = makeBundledRoot("openclaw-bundled-ids-a-");
    const rootB = makeBundledRoot("openclaw-bundled-ids-b-");

    vi.doMock("../../plugins/channel-catalog-registry.js", () => ({
      listChannelCatalogEntries: (params?: { env?: NodeJS.ProcessEnv }) => {
        const activeRoot = params?.env?.OPENCLAW_BUNDLED_PLUGINS_DIR;
        if (activeRoot === rootA.pluginsDir) {
          return [{ pluginId: "alpha", channel: { id: "alpha-chat" } }];
        }
        if (activeRoot === rootB.pluginsDir) {
          return [{ pluginId: "beta", channel: { id: "beta-chat" } }];
        }
        return [];
      },
    }));

    const bundledIds = await importFreshModule<typeof import("./bundled-ids.js")>(
      import.meta.url,
      "./bundled-ids.js?scope=root-aware-id-cache",
    );

    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", rootA.pluginsDir);
    expect(bundledIds.listBundledChannelIds()).toEqual(["alpha-chat"]);

    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", rootB.pluginsDir);
    expect(bundledIds.listBundledChannelIds()).toEqual(["beta-chat"]);
  });

  it("reads bootstrap plugins from the active bundled root without re-importing", async () => {
    const rootA = makeBundledRoot("openclaw-bootstrap-a-");
    const rootB = makeBundledRoot("openclaw-bootstrap-b-");
    const suffix = () => {
      const activeRoot = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
      return activeRoot === rootA.pluginsDir
        ? "A"
        : activeRoot === rootB.pluginsDir
          ? "B"
          : "unknown";
    };

    vi.doMock("./bundled.js", () => ({
      getBundledChannelPlugin: (id: string) => plugin(id, `runtime-${id}`),
      getBundledChannelSetupPlugin: (id: string) => plugin(id, `setup-${suffix()}`),
      getBundledChannelSecrets: (id: string) => ({
        secretTargetRegistryEntries: [{ id: `runtime-${id}`, targetType: "channel" }],
      }),
      getBundledChannelSetupSecrets: (id: string) => ({
        secretTargetRegistryEntries: [{ id: `setup-${id}-${suffix()}`, targetType: "channel" }],
      }),
    }));

    const bootstrapRegistry = await loadBootstrap("root-aware-bootstrap-cache");

    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", rootA.pluginsDir);
    expect(bootstrapRegistry.getBootstrapChannelPlugin("alpha")?.meta.label).toBe("setup-A");
    expect(
      bootstrapRegistry.getBootstrapChannelSecrets("alpha")?.secretTargetRegistryEntries?.[0]?.id,
    ).toBe("setup-alpha-A");

    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", rootB.pluginsDir);
    expect(bootstrapRegistry.getBootstrapChannelPlugin("beta")?.meta.label).toBe("setup-B");
    expect(
      bootstrapRegistry.getBootstrapChannelSecrets("beta")?.secretTargetRegistryEntries?.[0]?.id,
    ).toBe("setup-beta-B");
  });

  it("retries bootstrap plugin loading after an error", async () => {
    const getBundledChannelPluginMock = vi.fn(() => {
      throw new Error("Cannot find module 'nostr-tools'");
    });
    const getBundledChannelSecretsMock = vi.fn(() => {
      throw new Error("secrets should not load after plugin is marked missing");
    });

    vi.doMock("./bundled.js", () => ({
      getBundledChannelPlugin: getBundledChannelPluginMock,
      getBundledChannelSetupPlugin: vi.fn(() => undefined),
      getBundledChannelSecrets: getBundledChannelSecretsMock,
      getBundledChannelSetupSecrets: vi.fn(() => undefined),
    }));

    const bootstrapRegistry = await loadBootstrap("bootstrap-plugin-load-guard");

    expect(bootstrapRegistry.getBootstrapChannelPlugin("alpha")).toBeUndefined();
    expect(bootstrapRegistry.getBootstrapChannelPlugin("alpha")).toBeUndefined();
    expect(bootstrapRegistry.getBootstrapChannelSecrets("alpha")).toBeUndefined();
    expect(getBundledChannelPluginMock).toHaveBeenCalledTimes(2);
    expect(getBundledChannelSecretsMock).toHaveBeenCalledTimes(1);
  });

  it("keeps plugin loading independent from bootstrap secrets loading errors", async () => {
    const getBundledChannelSecretsMock = vi.fn(() => {
      throw new Error("Cannot find module '@larksuiteoapi/node-sdk'");
    });
    const getBundledChannelPluginMock = vi.fn(() => plugin("alpha", "Alpha"));

    vi.doMock("./bundled.js", () => ({
      getBundledChannelPlugin: getBundledChannelPluginMock,
      getBundledChannelSetupPlugin: vi.fn(() => undefined),
      getBundledChannelSecrets: getBundledChannelSecretsMock,
      getBundledChannelSetupSecrets: vi.fn(() => undefined),
    }));

    const bootstrapRegistry = await loadBootstrap("bootstrap-secrets-load-guard");

    expect(bootstrapRegistry.getBootstrapChannelSecrets("alpha")).toBeUndefined();
    expect(bootstrapRegistry.getBootstrapChannelSecrets("alpha")).toBeUndefined();
    expect(bootstrapRegistry.getBootstrapChannelPlugin("alpha")).toEqual({
      id: "alpha",
      meta: { id: "alpha", label: "Alpha" },
      capabilities: {},
      config: {},
    });
    expect(getBundledChannelSecretsMock).toHaveBeenCalledTimes(2);
    expect(getBundledChannelPluginMock).toHaveBeenCalledTimes(1);
  });
});
