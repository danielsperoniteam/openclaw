import { describe, expect, it } from "vitest";
import {
  isMainGitContributorScope,
  selectSessionGitContributorProfileIds,
} from "./session-git-contributors.js";

const parent = {
  inheritedGitContributorProfileIds: ["prior-inherited"],
  participants: ["unrelated-a", "unrelated-b"].map((id) => ({
    identity: { type: "profile" as const, id },
    contributionCount: 1,
    firstPromptedAt: 1,
    lastPromptedAt: 1,
  })),
};

describe("Git contributor source scope", () => {
  it("uses the verified request, not a multiplexed main roster, for delegation", () => {
    const source = {
      agentId: "work",
      config: { session: { mainKey: "home" } },
      sessionKey: "agent:work:home",
    };
    expect(
      selectSessionGitContributorProfileIds(parent, {
        ...source,
        requesterProfileIds: ["requester-c"],
      }),
    ).toEqual(["requester-c"]);
    expect(selectSessionGitContributorProfileIds(parent, source)).toBeUndefined();
    expect(
      selectSessionGitContributorProfileIds(parent, {
        ...source,
        requesterProfileIds: ["requester-d"],
      }),
    ).toEqual(["requester-d"]);
    expect(isMainGitContributorScope({ ...source, sessionKey: "agent:other:home" })).toBe(false);
    expect(
      isMainGitContributorScope({
        agentId: "work",
        config: { session: { scope: "global" } },
        sessionKey: "global",
      }),
    ).toBe(true);
  });

  it("preserves authorized collaborative task and nested-delegation credit", () => {
    const source = { agentId: "work", config: {}, sessionKey: "agent:work:dashboard:task" };
    const inheritedGitContributorProfileIds = selectSessionGitContributorProfileIds(parent, source);
    expect(inheritedGitContributorProfileIds).toEqual([
      "prior-inherited",
      "unrelated-a",
      "unrelated-b",
    ]);
    expect(
      selectSessionGitContributorProfileIds(
        { inheritedGitContributorProfileIds },
        { ...source, sessionKey: "agent:work:subagent:child" },
      ),
    ).toEqual(inheritedGitContributorProfileIds);
    expect(
      selectSessionGitContributorProfileIds({ ...parent, incognito: true }, source),
    ).toBeUndefined();
  });
});
