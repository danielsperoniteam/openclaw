import fs from "node:fs";
import path from "node:path";
import { registerPluginCliCommandsFromValidatedConfig } from "./cli.js";

export const writeJson = (file: string, value: unknown) =>
  fs.writeFileSync(file, JSON.stringify(value));

export const cliEnv = (root: string) => ({
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
});

export function registerCli(
  program: Parameters<typeof registerPluginCliCommandsFromValidatedConfig>[0],
  {
    env,
    ...options
  }: NonNullable<Parameters<typeof registerPluginCliCommandsFromValidatedConfig>[3]> & {
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  return registerPluginCliCommandsFromValidatedConfig(program, env, undefined, options);
}
