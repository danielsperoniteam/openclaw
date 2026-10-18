import {
  ApplicationCommandOptionType,
  ComponentType,
  InteractionResponseType,
  InteractionType,
} from "discord-api-types/v10";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { Command, CommandWithSubcommands, type CommandOptions } from "./commands.js";
import type {
  AutocompleteInteraction,
  CommandInteraction,
  RawInteraction,
} from "./interactions.js";
import {
  attachRestMock,
  createInternalComponentInteractionPayload,
  createInternalInteractionPayload,
  createInternalTestClient,
} from "./test-builders.test-support.js";

const identity = { id: "interaction1", token: "token1" };

function command(
  name: string,
  run: (interaction: CommandInteraction) => unknown,
  options?: CommandOptions,
  defer = false,
  ephemeral = false,
) {
  return new (class extends Command {
    name = name;
    override description = name;
    override options = options;
    override defer = defer;
    override ephemeral = ephemeral;
    run = run;
  })();
}

function dispatch(
  client: ReturnType<typeof createInternalTestClient>,
  name = "boom",
  options?: NonNullable<RawInteraction["data"]>["options"],
  type = InteractionType.ApplicationCommand,
) {
  return client.handleInteraction(
    createInternalInteractionPayload({
      ...identity,
      type,
      data: { id: "command1", name, type: 1, options },
    }),
  );
}

function throwingClient(run: (interaction: CommandInteraction) => unknown) {
  return createInternalTestClient([command("boom", run, undefined, true)]);
}

describe("dispatchInteraction", () => {
  it("reports a visible failure when a deferred command handler throws", async () => {
    // #77716: resolve the deferred spinner visibly, but keep exception details private.
    const run = vi.fn(async () => {
      throw new Error("prepared model catalog owner config was replaced during the read");
    });
    const client = throwingClient(run);
    const { patch } = attachRestMock(client, {});

    await expect(dispatch(client)).rejects.toThrow(
      "prepared model catalog owner config was replaced",
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls).toMatchObject([
      [
        "/webhooks/app1/token1/messages/%40original",
        { body: { content: expect.stringContaining("failed"), allowed_mentions: { parse: [] } } },
      ],
    ]);
    expect(JSON.stringify(patch.mock.calls)).not.toContain("prepared model catalog");
  });

  it("does not touch the original response when a component acknowledgement fails", async () => {
    // DeferredMessageUpdate owns existing channel content, not an unanswered spinner.
    const run = vi.fn(async () => {
      throw new Error("approval resolution exploded");
    });
    const client = createInternalTestClient([]);
    client.componentHandler.register({
      customId: "component1",
      type: ComponentType.Button,
      defer: true,
      ephemeral: false,
      run,
      customIdParser: (id: string) => ({ data: { id } }),
    } as never);
    const { patch } = attachRestMock(client, {});

    await expect(
      client.handleInteraction(createInternalComponentInteractionPayload(identity)),
    ).rejects.toThrow("approval resolution exploded");

    expect(run).toHaveBeenCalledTimes(1);
    expect(patch).not.toHaveBeenCalled();
  });

  it("does not overwrite a follow-up that was still in flight when the handler threw", async () => {
    // Hold only the follow-up; the deferred callback must settle before the handler runs.
    const followUp = createDeferred<undefined>();
    const post = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => followUp.promise);
    const patch = vi.fn(async () => undefined);
    const run = vi.fn((interaction: CommandInteraction) => {
      void interaction.followUp("progress").catch(() => undefined);
      return Promise.reject(new Error("failed with a follow-up in flight"));
    });
    const client = throwingClient(run);
    attachRestMock(client, { post, patch });

    const handled = dispatch(client);
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    followUp.resolve(undefined);

    await expect(handled).rejects.toThrow("failed with a follow-up in flight");
    expect(post).toHaveBeenCalledTimes(2);
    expect(patch).not.toHaveBeenCalled();
  });

  it("dispatches the focused option autocomplete handler", async () => {
    const optionAutocomplete = vi.fn(async (interaction: AutocompleteInteraction) => {
      await interaction.respond([{ name: "alpha", value: "alpha" }]);
    });
    const client = createInternalTestClient([
      command("choose", () => {}, [
        {
          name: "model",
          description: "Model",
          type: ApplicationCommandOptionType.String,
          autocomplete: optionAutocomplete,
        },
      ]),
    ]);
    const { post } = attachRestMock(client, {});
    await dispatch(
      client,
      "choose",
      [{ name: "model", type: ApplicationCommandOptionType.String, value: "a", focused: true }],
      InteractionType.ApplicationCommandAutocomplete,
    );

    expect(optionAutocomplete).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/interactions/interaction1/token1/callback", {
      body: {
        type: InteractionResponseType.ApplicationCommandAutocompleteResult,
        data: { choices: [{ name: "alpha", value: "alpha" }] },
      },
    });
  });

  it("defers selected subcommands before running them", async () => {
    const run = vi.fn(async (interaction: CommandInteraction) => {
      await interaction.reply("joined");
    });
    class VoiceCommand extends CommandWithSubcommands {
      override name = "vc";
      override description = "Voice";
      subcommands = [command("join", run, undefined, true, true)];
    }
    const client = createInternalTestClient([new VoiceCommand()]);
    const { post, patch } = attachRestMock(client, {});
    await dispatch(client, "vc", [{ name: "join", type: ApplicationCommandOptionType.Subcommand }]);

    expect(post).toHaveBeenNthCalledWith(1, "/interactions/interaction1/token1/callback", {
      body: {
        type: InteractionResponseType.DeferredChannelMessageWithSource,
        data: { flags: 64 },
      },
    });
    expect(patch).toHaveBeenCalledWith("/webhooks/app1/token1/messages/%40original", {
      body: { content: "joined" },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
