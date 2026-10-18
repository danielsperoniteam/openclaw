import { buildAgentMainSessionKey } from "../../routing/session-key.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { inheritSessionGitContributorProfileIds } from "./session-entry-provenance.js";

type ContributorSource = {
  agentId: string;
  config: OpenClawConfig;
  sessionKey: string;
  /** Host-verified contributors to the admitted request, not model-supplied profile IDs. */
  requesterProfileIds?: readonly string[];
};

export function isMainGitContributorScope(source: ContributorSource): boolean {
  return (
    source.sessionKey ===
      buildAgentMainSessionKey({
        agentId: source.agentId,
        mainKey: source.config.session?.mainKey,
      }) ||
    (source.config.session?.scope === "global" && source.sessionKey === "global")
  );
}

/** A routing hub's lifetime roster is not evidence of contribution to its next task. */
export function selectSessionGitContributorProfileIds(
  parent: Parameters<typeof inheritSessionGitContributorProfileIds>[0],
  source: ContributorSource,
): string[] | undefined {
  if (!parent || parent.incognito) {
    return undefined;
  }
  if (isMainGitContributorScope(source)) {
    const ids = [...new Set(source.requesterProfileIds ?? [])];
    return ids.length ? ids : undefined;
  }
  return inheritSessionGitContributorProfileIds(parent);
}
