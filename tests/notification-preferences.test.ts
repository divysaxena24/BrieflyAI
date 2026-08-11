/**
 * Phase 6D STEP 8 — user preferences tests.
 */
import { describe, expect, it } from "vitest";
import { createNotificationPreferenceEngine } from "@/lib/notifications/preferences";
import {
  createNotificationPreference,
  createNotificationSubscription,
  createNotificationPreferenceRule,
} from "@/lib/notifications/types";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T12:00:00.000Z";
const MUTE_UNTIL = "2026-08-12T00:00:00.000Z";

/** Build a preference engine with one user's preferences. */
function engineWithUser() {
  const engine = createNotificationPreferenceEngine();
  engine.setPreference("user-1", { updatedAt: NOW });
  return engine;
}

describe("preference reads", () => {
  it("starts empty", () => {
    const engine = createNotificationPreferenceEngine();
    expect(engine.preferenceCount()).toBe(0);
    expect(engine.getPreference("u")).toBeUndefined();
    expect(engine.hasPreference("u")).toBe(false);
  });

  it("returns a default all-enabled preference when set", () => {
    const engine = engineWithUser();
    const preference = engine.getPreference("user-1");
    expect(preference?.muted).toBe(false);
    expect(preference?.digestMode).toBe(false);
    expect(preference?.categories.digest).toBe(true);
    expect(preference?.priorities.critical).toBe(true);
    expect(preference?.channelConfig.email.enabled).toBe(true);
  });

  it("upserts a full preference", () => {
    const engine = createNotificationPreferenceEngine();
    engine.setPreference("user-1", {
      muted: true,
      digestMode: true,
      updatedAt: NOW,
    });
    expect(engine.getPreference("user-1")?.muted).toBe(true);
    engine.setPreference("user-1", { muted: false, updatedAt: LATER });
    expect(engine.getPreference("user-1")?.muted).toBe(false);
    expect(engine.preferenceCount()).toBe(1);
  });

  it("returns detached copies", () => {
    const engine = engineWithUser();
    const preference = engine.getPreference("user-1");
    if (preference !== undefined) {
      (preference as { muted: boolean }).muted = true;
    }
    expect(engine.getPreference("user-1")?.muted).toBe(false);
  });

  it("updatePreference creates a preference when absent", () => {
    const engine = createNotificationPreferenceEngine();
    const { engine: next } = engine.updatePreference("new-user", { muted: true }, NOW);
    expect(next.hasPreference("new-user")).toBe(true);
    expect(next.getPreference("new-user")?.muted).toBe(true);
  });
});

describe("mute & quiet hours", () => {
  it("mute suppresses delivery", () => {
    const engine = engineWithUser();
    engine.mute("user-1", NOW);
    const decision = engine.decision({
      userId: "user-1",
      category: "system",
      priority: "normal",
      at: LATER,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("muted");
  });

  it("unmute restores delivery", () => {
    const engine = engineWithUser();
    engine.mute("user-1", NOW, MUTE_UNTIL);
    engine.unmute("user-1", LATER);
    const decision = engine.decision({
      userId: "user-1",
      category: "system",
      priority: "normal",
      at: LATER,
    });
    expect(decision.allowed).toBe(true);
  });

  it("mutedUntil suppresses delivery until the timestamp", () => {
    const engine = engineWithUser();
    engine.mute("user-1", NOW, MUTE_UNTIL);
    const during = engine.decision({
      userId: "user-1",
      category: "system",
      priority: "normal",
      at: "2026-08-11T23:00:00.000Z",
    });
    expect(during.allowed).toBe(false);
    const after = engine.decision({
      userId: "user-1",
      category: "system",
      priority: "normal",
      at: "2026-08-13T09:00:00.000Z",
    });
    expect(after.allowed).toBe(true);
  });

  it("quiet hours suppress non-critical notifications", () => {
    const engine = engineWithUser();
    engine.setQuietHours("user-1", { start: "22:00", end: "07:00" }, NOW);
    const atNight = engine.decision({
      userId: "user-1",
      category: "system",
      priority: "normal",
      at: "2026-08-11T23:00:00.000Z",
    });
    expect(atNight.allowed).toBe(false);
    expect(atNight.reasons).toContain("quiet_hours");
    const inDay = engine.decision({
      userId: "user-1",
      category: "system",
      priority: "normal",
      at: "2026-08-11T12:00:00.000Z",
    });
    expect(inDay.allowed).toBe(true);
  });

  it("critical priority bypasses quiet hours", () => {
    const engine = engineWithUser();
    engine.setQuietHours("user-1", { start: "22:00", end: "07:00" }, NOW);
    const decision = engine.decision({
      userId: "user-1",
      category: "system",
      priority: "critical",
      at: "2026-08-11T23:00:00.000Z",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reasons).not.toContain("quiet_hours");
  });

  it("clearing quiet hours restores delivery", () => {
    const engine = engineWithUser();
    engine.setQuietHours("user-1", { start: "00:00", end: "23:59" }, NOW);
    engine.setQuietHours("user-1", null, LATER);
    const decision = engine.decision({
      userId: "user-1",
      category: "system",
      priority: "normal",
      at: "2026-08-11T23:00:00.000Z",
    });
    expect(decision.allowed).toBe(true);
  });

  it("quietHoursOutcome reports the active window", () => {
    const engine = engineWithUser();
    const outcome = engine.quietHoursOutcome(
      { start: "22:00", end: "07:00" },
      "2026-08-11T23:30:00.000Z",
    );
    expect(outcome.inQuietHours).toBe(true);
    expect(outcome.window).toEqual({ start: "22:00", end: "07:00" });
    expect(engine.quietHoursOutcome(undefined, NOW).inQuietHours).toBe(false);
  });

  it("quiet hours without a window never block", () => {
    const engine = engineWithUser();
    const decision = engine.decision({
      userId: "user-1",
      category: "system",
      priority: "normal",
      at: NOW,
    });
    expect(decision.reasons).not.toContain("quiet_hours");
  });
});

describe("channels & preferences", () => {
  it("preferredChannels reflects the allow-list and enablement", () => {
    const engine = engineWithUser();
    engine.setPreferredChannels("user-1", ["email", "inapp"], NOW);
    engine.setChannelEnabled("user-1", "inapp", false, LATER);
    expect(engine.preferredChannels("user-1")).toEqual(["email"]);
  });

  it("an empty allow-list means every enabled channel", () => {
    const engine = engineWithUser();
    expect(engine.preferredChannels("user-1")).toContain("email");
    expect(engine.preferredChannels("user-1")).toContain("push");
  });

  it("channel enablement filters a decision", () => {
    const engine = engineWithUser();
    engine.setChannelEnabled("user-1", "email", false, NOW);
    const decision = engine.decision({
      userId: "user-1",
      category: "system",
      priority: "normal",
      at: NOW,
      channels: ["email", "inapp"],
    });
    expect(decision.channels).toEqual(["inapp"]);
  });

  it("a decision with no usable channels is blocked", () => {
    const engine = engineWithUser();
    engine.setChannelEnabled("user-1", "email", false, NOW);
    const decision = engine.decision({
      userId: "user-1",
      category: "system",
      priority: "normal",
      at: NOW,
      channels: ["email"],
    });
    expect(decision.allowed).toBe(false);
  });

  it("per-channel address override is stored", () => {
    const engine = engineWithUser();
    engine.setChannelAddress("user-1", "email", "override@example.com", NOW);
    expect(engine.getPreference("user-1")?.channelConfig.email.address).toBe(
      "override@example.com",
    );
  });

  it("clearing the address removes the override", () => {
    const engine = engineWithUser();
    engine.setChannelAddress("user-1", "email", "override@example.com", NOW);
    engine.setChannelAddress("user-1", "email", null, LATER);
    expect(engine.getPreference("user-1")?.channelConfig.email.address).toBeUndefined();
  });
});

describe("category & priority filters", () => {
  it("a disabled category blocks delivery", () => {
    const engine = engineWithUser();
    engine.setCategoryEnabled("user-1", "marketing", false, NOW);
    const decision = engine.decision({
      userId: "user-1",
      category: "marketing",
      priority: "normal",
      at: NOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("category_disabled");
  });

  it("other categories are unaffected", () => {
    const engine = engineWithUser();
    engine.setCategoryEnabled("user-1", "marketing", false, NOW);
    const decision = engine.decision({
      userId: "user-1",
      category: "system",
      priority: "normal",
      at: NOW,
    });
    expect(decision.allowed).toBe(true);
  });

  it("a disabled priority blocks delivery", () => {
    const engine = engineWithUser();
    engine.setPriorityEnabled("user-1", "low", false, NOW);
    const decision = engine.decision({
      userId: "user-1",
      category: "system",
      priority: "low",
      at: NOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("priority_disabled");
  });
});

describe("digest mode", () => {
  it("surfaces the digest flag in the decision", () => {
    const engine = engineWithUser();
    engine.setDigestMode("user-1", true, NOW);
    const decision = engine.decision({
      userId: "user-1",
      category: "digest",
      priority: "normal",
      at: NOW,
    });
    expect(decision.digest).toBe(true);
  });

  it("defaults to immediate delivery", () => {
    const engine = engineWithUser();
    const decision = engine.decision({
      userId: "user-1",
      category: "system",
      priority: "normal",
      at: NOW,
    });
    expect(decision.digest).toBe(false);
  });
});

describe("subscriptions", () => {
  it("subscribes a user to a topic", () => {
    const engine = engineWithUser();
    const { engine: next, subscription } = engine.subscribe("user-1", "digests", ["email"], NOW);
    expect(subscription.topic).toBe("digests");
    expect(next.isSubscribed("user-1", "digests")).toBe(true);
  });

  it("unsubscribes a user", () => {
    const engine = engineWithUser();
    engine.subscribe("user-1", "digests", ["email"], NOW);
    const { engine: next, removed } = engine.unsubscribe("user-1", "digests");
    expect(removed).toBe(true);
    expect(next.isSubscribed("user-1", "digests")).toBe(false);
  });

  it("re-subscribing upserts without duplicating", () => {
    const engine = engineWithUser();
    engine.subscribe("user-1", "digests", ["email"], NOW);
    engine.subscribe("user-1", "digests", ["email", "push"], LATER);
    expect(engine.listSubscriptions("user-1")).toHaveLength(1);
    expect(engine.getSubscription("user-1", "digests")?.channels).toEqual(["email", "push"]);
  });

  it("deactivation disables the subscription", () => {
    const engine = engineWithUser();
    engine.subscribe("user-1", "digests", ["email"], NOW);
    engine.setSubscriptionActive("user-1", "digests", false);
    expect(engine.isSubscribed("user-1", "digests")).toBe(false);
  });

  it("summarizes subscriptions", () => {
    const engine = engineWithUser();
    engine.subscribe("user-1", "a", ["email"], NOW);
    engine.subscribe("user-1", "b", ["email"], NOW);
    engine.subscribe("user-1", "b", ["email"], LATER);
    const summary = engine.subscriptionSummary("user-1");
    expect(summary.total).toBe(2);
    expect(summary.active).toBe(2);
  });

  it("isSubscribed is false for unknown users", () => {
    const engine = engineWithUser();
    expect(engine.isSubscribed("nobody", "x")).toBe(false);
  });
});

describe("rules", () => {
  it("an explicit block rule suppresses delivery", () => {
    const engine = engineWithUser();
    engine.addRule({
      userId: "user-1",
      category: "marketing",
      enabled: false,
      createdAt: NOW,
    });
    const decision = engine.decision({
      userId: "user-1",
      category: "marketing",
      priority: "normal",
      at: NOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("blocked_by_rule");
  });

  it("a block rule scoped to one category leaves others alone", () => {
    const engine = engineWithUser();
    engine.addRule({
      userId: "user-1",
      category: "marketing",
      enabled: false,
      createdAt: NOW,
    });
    const decision = engine.decision({
      userId: "user-1",
      category: "system",
      priority: "normal",
      at: NOW,
    });
    expect(decision.allowed).toBe(true);
  });

  it("rulesFor filters by channel/category/priority", () => {
    const engine = engineWithUser();
    engine.addRule({ userId: "user-1", channel: "email", enabled: false, createdAt: NOW });
    engine.addRule({ userId: "user-1", priority: "critical", enabled: true, createdAt: NOW });
    expect(engine.rulesFor("user-1", { channel: "email" })).toHaveLength(1);
    expect(engine.rulesFor("user-1", { priority: "critical" })).toHaveLength(1);
    expect(engine.rulesFor("user-1", { category: "digest" })).toHaveLength(0);
  });

  it("removeRule deletes a rule", () => {
    const engine = engineWithUser();
    const { rule } = engine.addRule({
      userId: "user-1",
      category: "marketing",
      enabled: false,
      createdAt: NOW,
    });
    engine.removeRule(rule.id);
    expect(engine.listRules("user-1")).toHaveLength(0);
  });

  it("duplicate rule ids throw", () => {
    const engine = engineWithUser();
    engine.addRule({ userId: "user-1", channel: "email", enabled: false, createdAt: NOW });
    expect(() =>
      engine.addRule({ userId: "user-1", channel: "email", enabled: false, createdAt: NOW }),
    ).toThrow(/already exists/);
  });
});

describe("default decision behavior", () => {
  it("unknown users are allowed with the requested channels", () => {
    const engine = createNotificationPreferenceEngine();
    const decision = engine.decision({
      userId: "nobody",
      category: "system",
      priority: "normal",
      at: NOW,
      channels: ["email"],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.channels).toEqual(["email"]);
  });

  it("decisions are frozen", () => {
    const engine = engineWithUser();
    const decision = engine.decision({
      userId: "user-1",
      category: "system",
      priority: "normal",
      at: NOW,
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.reasons)).toBe(true);
  });

  it("decisions default to preferred channels when none requested", () => {
    const engine = engineWithUser();
    engine.setPreferredChannels("user-1", ["inapp"], NOW);
    const decision = engine.decision({
      userId: "user-1",
      category: "system",
      priority: "normal",
      at: NOW,
    });
    expect(decision.channels).toEqual(["inapp"]);
  });
});

describe("successor semantics & restore", () => {
  it("mutations replace state without touching callers' inputs", () => {
    const engine = engineWithUser();
    const preference = createNotificationPreference({ userId: "other", updatedAt: NOW });
    engine.setPreference("other", { updatedAt: LATER });
    expect(engine.getPreference("other")?.updatedAt).toBe(LATER);
    expect(preference.updatedAt).toBe(NOW);
    expect(Object.isFrozen(preference)).toBe(true);
  });

  it("restoreState rebuilds from persisted collections", () => {
    const engine = engineWithUser();
    engine.subscribe("user-1", "digests", ["email"], NOW);
    engine.addRule({ userId: "user-1", category: "marketing", enabled: false, createdAt: NOW });
    const preferences = engine.listPreferences();
    const subscriptions = engine.listSubscriptions("user-1");
    const rules = engine.listRules("user-1");

    const restored = createNotificationPreferenceEngine();
    restored.restoreState({ preferences, subscriptions, rules });
    expect(restored.preferenceCount()).toBe(1);
    expect(restored.isSubscribed("user-1", "digests")).toBe(true);
    expect(restored.listRules("user-1")).toHaveLength(1);
    expect(restored.getPreference("user-1")?.muted).toBe(false);
  });

  it("subscriptions built from the types module are accepted", () => {
    const engine = createNotificationPreferenceEngine({
      subscriptions: [
        createNotificationSubscription({
          userId: "u1",
          topic: "t",
          channels: ["email"],
          createdAt: NOW,
        }),
      ],
    });
    expect(engine.isSubscribed("u1", "t")).toBe(true);
  });

  it("rules built from the types module are accepted", () => {
    const engine = createNotificationPreferenceEngine({
      rules: [
        createNotificationPreferenceRule({
          userId: "u1",
          category: "marketing",
          enabled: false,
          createdAt: NOW,
        }),
      ],
    });
    const decision = engine.decision({
      userId: "u1",
      category: "marketing",
      priority: "normal",
      at: NOW,
    });
    expect(decision.allowed).toBe(false);
  });
});
