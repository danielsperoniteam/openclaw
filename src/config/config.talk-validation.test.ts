import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadConfig,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
} from "./config.js";
import { withTempHomeConfig } from "./test-helpers.js";

describe("talk config validation fail-closed behavior", () => {
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("can load an unpinned runtime config without replacing the process snapshot", async () => {
    await withTempHomeConfig({ gateway: { port: 19002 } }, async () => {
      const unpinned = loadConfig({ skipPluginValidation: true, pin: false });
      expect(unpinned.gateway?.port).toBe(19002);
      expect(getRuntimeConfigSnapshot()).toBeNull();
      const pinned = loadConfig();
      expect(pinned.gateway?.port).toBe(19002);
      expect(getRuntimeConfigSnapshot()).toBe(pinned);
    });
  });

  it("loads an opt-in consult profile with the selected model and direct tools", async () => {
    const consultProfile = { provider: "test-provider", model: "fast-model", directTools: true };
    await withTempHomeConfig({ talk: { consultProfile } }, async () => {
      expect(loadConfig({ skipPluginValidation: true }).talk?.consultProfile).toEqual(
        consultProfile,
      );
    });
  });

  it.each([
    {
      name: "blank consult model",
      talk: { consultProfile: { provider: "test-provider", model: "  " } },
      message: /talk\.consultProfile\.model/i,
    },
    {
      name: "missing consult provider",
      talk: { consultProfile: { model: "fast-model" } },
      message: /talk\.consultProfile\.provider/i,
    },
    {
      name: "non-boolean consult directTools",
      talk: {
        consultProfile: { provider: "test-provider", model: "fast-model", directTools: "yes" },
      },
      message: /talk\.consultProfile\.directTools/i,
    },
    {
      name: "provider absent from providers",
      talk: { provider: "acme", providers: { elevenlabs: { voiceId: "voice-123" } } },
      message: /talk\.provider|talk\.providers|acme/i,
    },
    {
      name: "ambiguous provider selection",
      talk: {
        providers: { acme: { voiceId: "voice-acme" }, elevenlabs: { voiceId: "voice-eleven" } },
      },
      message: /talk\.provider|required/i,
    },
  ])("rejects $name during config load", async ({ talk, message }) => {
    await withTempHomeConfig({ agents: { entries: { main: {} } }, talk }, async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      let thrown: unknown;
      try {
        loadConfig();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).toMatchObject({
        code: "INVALID_CONFIG",
        message: expect.stringMatching(message),
      });
      expect(consoleSpy).toHaveBeenCalled();
    });
  });
});
