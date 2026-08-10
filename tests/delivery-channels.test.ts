/**
 * Phase 5J STEP 8 — delivery channel tests.
 */
import { describe, expect, it } from "vitest";
import {
  CHANNEL_SENDER_MISSING,
  ChannelPublisher,
  ChannelPublisherRegistry,
} from "@/lib/delivery/channels";
import {
  cloneChannelRecipient,
  createChannelRecipient,
  DELIVERY_CHANNELS,
  hashChannelRecipient,
  type ChannelRecipient,
  type ChannelSender,
  type ChannelSendInput,
  type ChannelSendOutput,
} from "@/lib/delivery/types";
import { createDigest, createDigestDelivery, createSection } from "@/lib/digest/types";

const NOW = "2026-08-10T08:00:00.000Z";

/** A controllable fake sender. */
function fakeSender(
  channel: ChannelSender["channel"],
  output: (input: ChannelSendInput) => ChannelSendOutput = () => ({ ok: true, message: "sent" }),
): ChannelSender & { calls: ChannelSendInput[] } {
  const calls: ChannelSendInput[] = [];
  return {
    channel,
    calls,
    async send(input: ChannelSendInput): Promise<ChannelSendOutput> {
      calls.push(input);
      return output(input);
    },
  };
}

describe("createChannelRecipient / helpers", () => {
  it("builds immutable recipients with deterministic ids", () => {
    const a = createChannelRecipient({ channel: "email", address: "a@x.com" });
    const b = createChannelRecipient({ channel: "email", address: "a@x.com" });
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^recipient-[0-9a-f]{8}$/);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it("ids differ across channels and addresses", () => {
    const a = createChannelRecipient({ channel: "email", address: "a@x.com" });
    const b = createChannelRecipient({ channel: "telegram", address: "a@x.com" });
    const c = createChannelRecipient({ channel: "email", address: "b@x.com" });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it("clones detach and hash is stable", () => {
    const recipient = createChannelRecipient({ channel: "whatsapp", address: "+1", label: "Me" });
    const clone = cloneChannelRecipient(recipient);
    expect(clone).toEqual(recipient);
    expect(Object.isFrozen(clone)).toBe(false);
    expect(hashChannelRecipient(recipient)).toBe(hashChannelRecipient(clone));
  });

  it("lists every delivery channel", () => {
    expect(DELIVERY_CHANNELS).toEqual(["email", "discord", "telegram", "whatsapp"]);
  });
});

describe("ChannelPublisherRegistry", () => {
  it("registers senders immutably and looks them up", () => {
    const email = fakeSender("email");
    const registry = new ChannelPublisherRegistry([email]);
    expect(registry.has("email")).toBe(true);
    expect(registry.get("email")).toBe(email);
    expect(registry.has("discord")).toBe(false);
    expect(registry.get("discord")).toBeUndefined();
  });

  it("register returns a successor without mutating the receiver", () => {
    const registry = new ChannelPublisherRegistry();
    const next = registry.register(fakeSender("telegram"));
    expect(registry.has("telegram")).toBe(false);
    expect(next.has("telegram")).toBe(true);
  });

  it("rejects duplicate channels", () => {
    const registry = new ChannelPublisherRegistry([fakeSender("email")]);
    expect(() => registry.register(fakeSender("email"))).toThrow(/already contains sender/);
    expect(() => new ChannelPublisherRegistry([fakeSender("email"), fakeSender("email")])).toThrow(
      /already contains sender/,
    );
  });

  it("unregister removes a channel (successor)", () => {
    const registry = new ChannelPublisherRegistry([fakeSender("email")]).unregister("email");
    expect(registry.has("email")).toBe(false);
  });

  it("lists senders in registration order", () => {
    const registry = new ChannelPublisherRegistry([
      fakeSender("email"),
      fakeSender("discord"),
    ]);
    expect(registry.list().map((sender) => sender.channel)).toEqual(["email", "discord"]);
  });
});

describe("ChannelPublisher", () => {
  it("dispatches each recipient through its channel sender", async () => {
    const email = fakeSender("email");
    const telegram = fakeSender("telegram");
    const publisher = new ChannelPublisher(new ChannelPublisherRegistry([email, telegram]));

    const summary = await publisher.deliver(
      [
        createChannelRecipient({ channel: "email", address: "a@x.com", label: "Daily" }),
        createChannelRecipient({ channel: "telegram", address: "@bot" }),
      ],
      "Morning digest",
    );

    expect(summary.total).toBe(2);
    expect(summary.ok).toBe(2);
    expect(summary.failed).toBe(0);
    expect(email.calls).toHaveLength(1);
    expect(email.calls[0]?.content).toBe("Morning digest");
    expect(email.calls[0]?.subject).toBe("Daily");
    expect(telegram.calls).toHaveLength(1);
  });

  it("formats a Digest payload as plain text before dispatch", async () => {
    const email = fakeSender("email");
    const publisher = new ChannelPublisher(new ChannelPublisherRegistry([email]));
    const digest = createDigest({
      id: "digest-1",
      kind: "morning",
      createdAt: NOW,
      window: { from: NOW, to: NOW },
      sections: [
        createSection({ id: "s1", category: "emails", title: "Emails", items: [] }),
      ],
    });
    await publisher.deliver(
      [createChannelRecipient({ channel: "email", address: "a@x.com" })],
      digest,
    );
    expect(email.calls[0]?.content).toContain("MORNING");
  });

  it("reports channel_sender_missing for unregistered channels (never throws)", async () => {
    const publisher = new ChannelPublisher(new ChannelPublisherRegistry([]));
    const summary = await publisher.deliver(
      [createChannelRecipient({ channel: "email", address: "a@x.com" })],
      "x",
    );
    expect(summary.total).toBe(1);
    expect(summary.ok).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.outcomes[0]?.error?.code).toBe(CHANNEL_SENDER_MISSING);
    expect(summary.outcomes[0]?.attemptsMade).toBe(0);
  });

  it("isolates a failing recipient — others still deliver", async () => {
    const email = fakeSender("email", () => ({ ok: false, error: { code: "nope", message: "nope" } }));
    const telegram = fakeSender("telegram");
    const publisher = new ChannelPublisher(new ChannelPublisherRegistry([email, telegram]));
    const summary = await publisher.deliver(
      [
        createChannelRecipient({ channel: "email", address: "a@x.com" }),
        createChannelRecipient({ channel: "telegram", address: "@b" }),
      ],
      "x",
    );
    expect(summary.failed).toBe(1);
    expect(summary.ok).toBe(1);
    expect(summary.outcomes[0]?.error?.code).toBe("nope");
    expect(telegram.calls).toHaveLength(1);
  });

  it("isolates a throwing sender", async () => {
    const throwing: ChannelSender = {
      channel: "discord",
      async send(): Promise<ChannelSendOutput> {
        throw new Error("discord down");
      },
    };
    const publisher = new ChannelPublisher(new ChannelPublisherRegistry([throwing]));
    const summary = await publisher.deliver(
      [createChannelRecipient({ channel: "discord", address: "guild" })],
      "x",
    );
    expect(summary.outcomes[0]?.ok).toBe(false);
    expect(summary.outcomes[0]?.error?.code).toBe("send_threw");
    expect(summary.outcomes[0]?.error?.message).toBe("discord down");
  });

  it("does not retry by default", async () => {
    let calls = 0;
    const sender = fakeSender("email", () => {
      calls += 1;
      return { ok: false, error: { code: "e", message: "e" } };
    });
    const publisher = new ChannelPublisher(new ChannelPublisherRegistry([sender]));
    await publisher.deliver([createChannelRecipient({ channel: "email", address: "a" })], "x");
    expect(calls).toBe(1);
  });

  it("retries only when configured", async () => {
    let calls = 0;
    const sender = fakeSender("email", () => {
      calls += 1;
      return calls < 3 ? { ok: false, error: { code: "e", message: "e" } } : { ok: true, message: "finally" };
    });
    const publisher = new ChannelPublisher(new ChannelPublisherRegistry([sender]), {
      maxRetries: 2,
      retryDelayMs: 1,
      sleep: async () => undefined,
    });
    const summary = await publisher.deliver([createChannelRecipient({ channel: "email", address: "a" })], "x");
    expect(calls).toBe(3);
    expect(summary.outcomes[0]?.ok).toBe(true);
    expect(summary.outcomes[0]?.attemptsMade).toBe(3);
  });

  it("reports the final failure after exhausting retries", async () => {
    let calls = 0;
    const sender = fakeSender("email", () => {
      calls += 1;
      return { ok: false, error: { code: "still", message: "down" } };
    });
    const publisher = new ChannelPublisher(new ChannelPublisherRegistry([sender]), {
      maxRetries: 2,
      retryDelayMs: 1,
      sleep: async () => undefined,
    });
    const summary = await publisher.deliver([createChannelRecipient({ channel: "email", address: "a" })], "x");
    expect(calls).toBe(3);
    expect(summary.outcomes[0]?.ok).toBe(false);
    expect(summary.outcomes[0]?.error?.code).toBe("still");
  });

  it("publish (DigestPublisher contract) never throws and resolves digest recipients", async () => {
    const email = fakeSender("email");
    const publisher = new ChannelPublisher(new ChannelPublisherRegistry([email]), {
      resolveRecipients: (recipient) => [
        createChannelRecipient({ channel: "email", address: recipient.address }),
      ],
    });
    const delivery = createDigestDelivery({
      format: "plain",
      recipients: [{ address: "a@x.com" }],
    });
    await expect(publisher.publish(delivery, "x")).resolves.toBeUndefined();
    expect(email.calls).toHaveLength(1);
    expect(email.calls[0]?.recipient.address).toBe("a@x.com");
  });

  it("delivers to every recipient even when some lack senders", async () => {
    const telegram = fakeSender("telegram");
    const publisher = new ChannelPublisher(new ChannelPublisherRegistry([telegram]));
    const summary = await publisher.deliver(
      [
        createChannelRecipient({ channel: "email", address: "a@x.com" }),
        createChannelRecipient({ channel: "telegram", address: "@b" }),
      ],
      "x",
    );
    expect(summary.total).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.ok).toBe(1);
  });
});
