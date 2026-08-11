/**
 * Phase 5J STEP 8 — delivery production wiring tests.
 */
import { describe, expect, it } from "vitest";
import {
  createProductionChannelPublisher,
  createProductionChannelRegistry,
  getProductionChannelPublisher,
  getProductionChannelRegistry,
} from "@/lib/delivery/production";
import { CHANNEL_SENDER_MISSING } from "@/lib/delivery/channels";
import { createChannelRecipient, type ChannelSender } from "@/lib/delivery/types";

describe("production channel wiring", () => {
  it("creates an empty registry by default (documented stop condition)", () => {
    const registry = createProductionChannelRegistry();
    expect(registry.list()).toEqual([]);
    expect(registry.has("email")).toBe(false);
  });

  it("creates a registry over injected senders", () => {
    const sender: ChannelSender = {
      channel: "email",
      async send() {
        return { ok: true };
      },
    };
    const registry = createProductionChannelRegistry([sender]);
    expect(registry.has("email")).toBe(true);
  });

  it("creates a publisher over injected senders", async () => {
    const calls: string[] = [];
    const sender: ChannelSender = {
      channel: "telegram",
      async send(input) {
        calls.push(input.content);
        return { ok: true, message: "m" };
      },
    };
    const publisher = createProductionChannelPublisher([sender]);
    const summary = await publisher.deliver(
      [createChannelRecipient({ channel: "telegram", address: "@x" })],
      "hello",
    );
    expect(summary.ok).toBe(1);
    expect(calls).toEqual(["hello"]);
  });

  it("singletons are stable", () => {
    expect(getProductionChannelRegistry()).toBe(getProductionChannelRegistry());
    expect(getProductionChannelPublisher()).toBe(getProductionChannelPublisher());
  });

  it("the singleton publisher reports channel_sender_missing (stop condition, never throws)", async () => {
    const publisher = getProductionChannelPublisher();
    const summary = await publisher.deliver(
      [
        createChannelRecipient({ channel: "email", address: "a@x.com" }),
        createChannelRecipient({ channel: "whatsapp", address: "+1" }),
      ],
      "digest",
    );
    expect(summary.total).toBe(2);
    expect(summary.failed).toBe(2);
    expect(summary.ok).toBe(0);
    expect(summary.outcomes.every((o) => o.error?.code === CHANNEL_SENDER_MISSING)).toBe(true);
  });
});
