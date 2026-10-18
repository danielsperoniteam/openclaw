import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginChannelCatalogEntry } from "../../plugins/channel-catalog-registry.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { findBundledChannelCatalogMetadata } from "../bundled-channel-catalog-read.js";
import { normalizeChatChannelId } from "../ids.js";

const listChannelCatalogEntriesMock = vi.hoisted(() =>
  vi.fn<() => PluginChannelCatalogEntry[]>(() => []),
);

vi.mock("../../plugins/channel-catalog-registry.js", () => ({
  listChannelCatalogEntries: listChannelCatalogEntriesMock,
}));

vi.mock("../../plugins/bundled-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/bundled-dir.js")>()),
  resolveBundledPluginsDir: () => undefined,
}));

import { getChannelPluginCatalogEntry } from "./catalog.js";

const tempDirs: string[] = [];

function makeRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-catalog-")));
  tempDirs.push(root);
  return root;
}

function catalogEntry(
  id: string,
  label: string,
  overrides: Omit<Partial<PluginChannelCatalogEntry>, "channel"> & {
    channel?: Partial<PluginChannelCatalogEntry["channel"]>;
  } = {},
): PluginChannelCatalogEntry {
  const { channel, ...fields } = overrides;
  return {
    pluginId: id,
    origin: "bundled",
    rootDir: `/tmp/${id}`,
    packageName: `@example/${id}`,
    channel: { id, label, docsPath: `/channels/${id}`, blurb: id, ...channel },
    install: { npmSpec: `@example/${id}` },
    ...fields,
  };
}

function generatedCatalog() {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
  vi.spyOn(process, "cwd").mockReturnValue(root);
  return { root, catalogPath: path.join(root, "dist", "channel-catalog.json") };
}

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  listChannelCatalogEntriesMock.mockReset().mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function writeChannelCatalog(
  catalogPath: string,
  id: string,
  label: string,
  defaultChoice?: string,
): void {
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(
    catalogPath,
    JSON.stringify({
      entries: [
        {
          name: `@example/${id}`,
          openclaw: {
            channel: { id, label, selectionLabel: label, docsPath: `/channels/${id}`, blurb: id },
            install: { npmSpec: `@example/${id}`, ...(defaultChoice ? { defaultChoice } : {}) },
          },
        },
      ],
    }),
  );
}

describe("channel plugin catalog", () => {
  it("keeps catalog-only channel IDs in the selected metadata owner", () => {
    const { catalogPath } = generatedCatalog();
    writeChannelCatalog(catalogPath, "catalog-original", "Original catalog");
    expect(normalizeChatChannelId("catalog-original")).toBe("catalog-original");

    writeChannelCatalog(catalogPath, "catalog-updated", "Updated catalog");
    expect(
      withPluginCache(createPluginCache(), () => normalizeChatChannelId("catalog-updated")),
    ).toBe("catalog-updated");
    expect(normalizeChatChannelId("catalog-original")).toBe("catalog-original");
    expect(normalizeChatChannelId("catalog-updated")).toBeNull();

    clearPluginMetadataLifecycleCaches();
    expect(normalizeChatChannelId("catalog-updated")).toBe("catalog-updated");
    expect(normalizeChatChannelId("catalog-original")).toBeNull();
  });

  it.each(["missing"] as const)(
    "shares %s generated catalog facts across consumers until the owner changes",
    () => {
      const { root, catalogPath } = generatedCatalog();
      const options = { catalogPaths: [path.join(root, "external.json")], env: {} };
      expect(getChannelPluginCatalogEntry("shared-catalog", options)?.meta.label).toBeUndefined();

      writeChannelCatalog(catalogPath, "shared-catalog", "Updated catalog");
      expect(findBundledChannelCatalogMetadata("shared-catalog")?.label).toBeUndefined();
      expect(
        withPluginCache(
          createPluginCache(),
          () => getChannelPluginCatalogEntry("shared-catalog", options)?.meta.label,
        ),
      ).toBe("Updated catalog");
      expect(getChannelPluginCatalogEntry("shared-catalog", options)?.meta.label).toBeUndefined();

      clearPluginMetadataLifecycleCaches();
      expect(getChannelPluginCatalogEntry("shared-catalog", options)?.meta.label).toBe(
        "Updated catalog",
      );
      expect(findBundledChannelCatalogMetadata("shared-catalog")?.label).toBe("Updated catalog");
    },
  );

  it.each([["spaced", "  See docs:  ", "  See docs:  "]] as const)(
    "preserves %s selection docs prefixes",
    (_label, prefix, expected) => {
      listChannelCatalogEntriesMock.mockReturnValue([
        catalogEntry("custom-chat", "Custom Chat", {
          pluginId: "workspace-chat",
          origin: "workspace",
          rootDir: "/tmp/workspace-chat",
          packageName: "@workspace/chat",
          channel: {
            selectionLabel: "Custom Chat",
            blurb: "workspace",
            ...(prefix !== undefined ? { selectionDocsPrefix: prefix } : {}),
          },
          install: { localPath: "/tmp/workspace-chat" },
        }),
      ]);

      const entry = getChannelPluginCatalogEntry("custom-chat", {
        workspaceDir: "/tmp",
      });

      expect(entry?.meta.selectionDocsPrefix).toBe(expected);
    },
  );

  it("excludes only the rejected origin/plugin pair when resolving fallback copies", () => {
    listChannelCatalogEntriesMock.mockReturnValue([
      catalogEntry("telegram", "Telegram Shadow", {
        origin: "config",
        rootDir: "/tmp/config-telegram",
        packageName: "telegram-shadow",
        channel: {
          selectionLabel: "Telegram Shadow",
          blurb: "shadow",
        },
        install: { localPath: "/tmp/config-telegram" },
      }),
      catalogEntry("telegram", "Telegram", {
        rootDir: "/tmp/bundled-telegram",
        packageName: "@openclaw/telegram",
        channel: {
          selectionLabel: "Telegram",
          blurb: "bundled",
        },
        install: { npmSpec: "@openclaw/telegram@1.0.0" },
      }),
    ]);

    expect(
      getChannelPluginCatalogEntry("telegram", {
        excludePluginRefs: [{ pluginId: "telegram", origin: "config" }],
      })?.origin,
    ).toBe("bundled");
  });

  it.each(["__proto__"])(
    "rejects inherited install default choice %s from external catalog input",
    (defaultChoice) => {
      const root = makeRoot();
      const catalogPath = path.join(root, "catalog.json");
      writeChannelCatalog(catalogPath, "unsafe-choice", "Unsafe Choice", defaultChoice);

      const entry = getChannelPluginCatalogEntry("unsafe-choice", {
        catalogPaths: [catalogPath],
        workspaceDir: root,
        env: {},
      });
      expect(entry?.install.defaultChoice).toBe("npm");
    },
  );

  it("reloads external catalog entries after the explicit plugin metadata lifecycle reset", () => {
    const root = makeRoot();
    const catalogPath = path.join(root, "catalog.json");
    const options = { catalogPaths: [catalogPath], workspaceDir: root, env: {} };

    expect(getChannelPluginCatalogEntry("lifecycle-external", options)).toBeUndefined();
    writeChannelCatalog(catalogPath, "lifecycle-external", "After external install");
    clearPluginMetadataLifecycleCaches();

    expect(getChannelPluginCatalogEntry("lifecycle-external", options)?.meta.label).toBe(
      "After external install",
    );
  });

  it.each([
    { name: "bundled", origin: "bundled", trusted: false, expected: "/channels/fixture" },
    { name: "official config", origin: "config", trusted: true, expected: "/channels/fixture" },
    { name: "untracked official identity", origin: "global", trusted: false },
    { name: "workspace shadow", origin: "workspace", trusted: true },
    {
      name: "third-party package shadow",
      origin: "global",
      trusted: true,
      packageName: "@vendor/fixture",
    },
    { name: "different plugin owner", origin: "global", trusted: true, pluginId: "other-owner" },
  ] as const)("binds docs to official metadata for $name", (scenario) => {
    const root = makeRoot();
    const officialPath = path.join(root, "official.json");
    writeChannelCatalog(officialPath, "fixture", "Fixture");
    listChannelCatalogEntriesMock.mockReturnValue([
      catalogEntry("fixture", "Installed Fixture", {
        pluginId: ("pluginId" in scenario ? scenario.pluginId : undefined) ?? "fixture",
        origin: scenario.origin,
        rootDir: root,
        packageName: "packageName" in scenario ? scenario.packageName : "@example/fixture",
        trustedOfficialInstall: scenario.trusted,
        channel: {
          docsPath:
            scenario.origin === "bundled" ? "/channels/fixture" : "/unverified-installed-guide",
        },
      }),
    ]);
    const entry = getChannelPluginCatalogEntry("fixture", {
      officialCatalogPaths: [officialPath],
      catalogPaths: [path.join(root, "none.json")],
      env: {},
    });
    expect(entry?.officialDocsPath).toBe("expected" in scenario ? scenario.expected : undefined);
    expect(entry?.trustedSourceLinkedOfficialInstall).toBeUndefined();
  });

  it.each([
    "https://attacker.example/setup",
    "//attacker.example/setup",
    "/x/..//attacker.example/setup",
    "/\\attacker.example/setup",
  ])("omits unsafe official docs path %s", (docsPath) => {
    listChannelCatalogEntriesMock.mockReturnValue([
      catalogEntry("fixture", "Fixture", { channel: { docsPath } }),
    ]);
    expect(getChannelPluginCatalogEntry("fixture", { env: {} })?.officialDocsPath).toBeUndefined();
  });
});
