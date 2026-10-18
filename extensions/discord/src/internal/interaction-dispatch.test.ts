import {
  ApplicationCommandOptionType,
  ComponentType,
  InteractionResponseType,
  InteractionType,
} from "discord-api-types/v10";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { Command, CommandWithSubcommands, type CommandOptions } from "./commands.js";
import type { AutocompleteInteraction, CommandInteraction } from "./interactions.js";
import {
  attachRestMock,
  createInternalComponentInteractionPayload,
  createInternalInteractionPayload,
  createInternalTestClient,
} from "./test-builders.test-support.js";

const identity = { id: "interaction1", token: "token1" };

function createThrowingCommandClient(run: (interaction: CommandInteraction) => unknown) {
  return createInternalTestClient([
    new (class extends Command {
      override name = "boom";
      override description = "Throwing command";
      override defer = true;
      run = run;
    })(),
  ]);
}

function dispatchTestCommand(client: ReturnType<typeof createInternalTestClient>) {
  return client.handleInteraction(
    createInternalInteractionPayload({
      ...identity,
      data: { id: "command1", name: "boom", type: 1 },
    }),
  );
}

describe("dispatchInteraction", () => {
  it("reports a visible failure when a deferred command handler throws", async () => {
    // #77716: resolve the deferred spinner visibly, but keep exception details private.
    const run = vi.fn(async () => {
      throw new Error("prepared model catalog owner config was replaced during the read");
    });
    const client = createThrowingCommandClient(run);
    const { patch } = attachRestMock(client, {});

    await expect(dispatchTestCommand(client)).rejects.toThrow(
      "prepared model catalog owner config was replaced",
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(
      "/webhooks/app1/token1/messages/%40original",
      expect.objectContaining({
        body: expect.objectContaining({
          content: expect.stringContaining("failed"),
          allowed_mentions: { parse: [] },
        }),
      }),
    );
    // The exception text must not reach the channel; it carries the agent dir.
    expect(patch).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({
          content: expect.stringContaining("prepared model catalog"),
        }),
      }),
    );
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
    const client = createThrowingCommandClient(run);
    attachRestMock(client, { post, patch });

    const handled = dispatchTestCommand(client);
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
    class OptionAutocompleteCommand extends Command {
      override name = "choose";
      override description = "Choose";
      override options: CommandOptions = [
        {
          name: "model",
          description: "Model",
          type: ApplicationCommandOptionType.String,
          autocomplete: optionAutocomplete,
        },
      ];
      run() {}
    }
    const client = createInternalTestClient([new OptionAutocompleteCommand()]);
    const { post } = attachRestMock(client, {});

    await client.handleInteraction(
      createInternalInteractionPayload({
        ...identity,
        type: InteractionType.ApplicationCommandAutocomplete,
        data: {
          id: "command1",
          name: "choose",
          type: 1,
          options: [
            {
              name: "model",
              type: ApplicationCommandOptionType.String,
              value: "a",
              focused: true,
            },
          ],
        },
      }),
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
    class JoinCommand extends Command {
      override name = "join";
      override description = "Join";
      override defer = true;
      override ephemeral = true;
      run = run;
    }
    class VoiceCommand extends CommandWithSubcommands {
      override name = "vc";
      override description = "Voice";
      subcommands = [new JoinCommand()];
    }
    const client = createInternalTestClient([new VoiceCommand()]);
    const { post, patch } = attachRestMock(client, {});

    await client.handleInteraction(
      createInternalInteractionPayload({
        ...identity,
        data: {
          id: "command1",
          name: "vc",
          type: 1,
          options: [{ name: "join", type: ApplicationCommandOptionType.Subcommand }],
        },
      }),
    );

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
