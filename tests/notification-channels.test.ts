/**
 * Phase 6D STEP 5 — delivery channels tests.
 */
import { describe, expect, it } from "vitest";
import {
  createEmailChannel,
  createDiscordChannel,
  createTelegramChannel,
  createWhatsAppChannel,
  createWebhookChannel,
  createPushChannel,
  createInAppChannel,
  createMockChannel,
  createNotificationChannel,
  createNotificationChannelRegistry,
  createDefaultNotificationChannels,
  createMockTransport,
  channelRegistryHash,
} from "@/lib/notifications/channels";
import {
  createNotificationRecipient,
  createNotificationAttachment,
} from "@/lib/notifications/types";
import type { NotificationChannelSendInput } from "@/lib/notifications/types";

const NOW = "2026-08-11T09:00:00.000Z";

const input = (overrides: Partial<NotificationChannelSendInput> = {}): NotificationChannelSendInput => ({
  recipient: createNotificationRecipient({ channel: "email", address: "user@example.com" }),
  subject: "Hi",
  content: "Hello",
  ...overrides,
});

describe("built-in channel construction", () => {
  it("creates every built-in channel with the right type", () => {
    expect(createEmailChannel().channel).toBe("email");
    expect(createDiscordChannel().channel).toBe("discord");
    expect(createTelegramChannel().channel).toBe("telegram");
    expect(createWhatsAppChannel().channel).toBe("whatsapp");
    expect(createWebhookChannel().channel).toBe("webhook");
    expect(createPushChannel().channel).toBe("push");
    expect(createInAppChannel().channel).toBe("inapp");
    expect(createMockChannel().channel).toBe("mock");
  });

  it("exposes deterministic capabilities per channel", () => {
    expect(createEmailChannel().capabilities.supportsHtml).toBe(true);
    expect(createEmailChannel().capabilities.supportsBatch).toBe(true);
    expect(createTelegramChannel().capabilities.supportsBatch).toBe(false);
    expect(createWhatsAppChannel().capabilities.supportsHtml).toBe(false);
    expect(createPushChannel().capabilities.supportsAttachments).toBe(false);
    expect(createWebhookChannel().capabilities.supportsAttachments).toBe(false);
  });

  it("exposes a rate limit", () => {
    const channel = createNotificationChannel("email", { rateLimit: { windowMs: 1000, maxSends: 5 } });
    expect(channel.rateLimit).toEqual({ windowMs: 1000, maxSends: 5 });
    expect(createEmailChannel().rateLimit?.maxSends).toBe(100);
  });
});

describe("validation", () => {
  it("rejects invalid email addresses", () => {
    const validation = createEmailChannel().validate(input({ recipient: createNotificationRecipient({ channel: "email", address: "nope" }) }));
    expect(validation.ok).toBe(false);
    expect(validation.errors[0]).toContain("Invalid email address");
  });

  it("requires a subject on email", () => {
    const validation = createEmailChannel().validate(input({ subject: undefined }));
    expect(validation.ok).toBe(false);
    expect(validation.errors.some((error) => error.includes("requires a subject"))).toBe(true);
  });

  it("accepts valid email input", () => {
    expect(createEmailChannel().validate(input()).ok).toBe(true);
  });

  it("validates telegram chat ids", () => {
    expect(createTelegramChannel().validate(input({ recipient: createNotificationRecipient({ channel: "telegram", address: "12345" }) })).ok).toBe(true);
    expect(createTelegramChannel().validate(input({ recipient: createNotificationRecipient({ channel: "telegram", address: "abc" }) })).ok).toBe(false);
  });

  it("validates whatsapp phones", () => {
    expect(createWhatsAppChannel().validate(input({ recipient: createNotificationRecipient({ channel: "whatsapp", address: "+15551234567" }) })).ok).toBe(true);
    expect(createWhatsAppChannel().validate(input({ recipient: createNotificationRecipient({ channel: "whatsapp", address: "not-a-phone" }) })).ok).toBe(false);
  });

  it("validates webhook urls", () => {
    expect(createWebhookChannel().validate(input({ recipient: createNotificationRecipient({ channel: "webhook", address: "https://hooks.example.com/x" }) })).ok).toBe(true);
    expect(createWebhookChannel().validate(input({ recipient: createNotificationRecipient({ channel: "webhook", address: "ftp://x" }) })).ok).toBe(false);
  });

  it("rejects attachments on channels that do not support them", () => {
    const attachment = createNotificationAttachment({ name: "a.pdf", mimeType: "application/pdf" });
    const validation = createWebhookChannel().validate(input({ attachments: [attachment] }));
    expect(validation.ok).toBe(false);
    expect(validation.errors.some((error) => error.includes("does not support attachments"))).toBe(true);
  });

  it("accepts attachments on channels that support them", () => {
    const attachment = createNotificationAttachment({ name: "a.pdf", mimeType: "application/pdf" });
    expect(createEmailChannel().validate(input({ attachments: [attachment] })).ok).toBe(true);
  });

  it("rejects oversized attachments", () => {
    const attachment = createNotificationAttachment({ name: "big.bin", mimeType: "application/octet-stream", sizeBytes: 11 * 1024 * 1024 });
    const validation = createEmailChannel().validate(input({ attachments: [attachment] }));
    expect(validation.ok).toBe(false);
  });

  it("rejects empty attachment names", () => {
    const attachment = createNotificationAttachment({ name: "", mimeType: "text/plain" });
    const validation = createEmailChannel().validate(input({ attachments: [attachment] }));
    expect(validation.ok).toBe(false);
  });

  it("rejects unsupported formats", () => {
    const validation = createPushChannel().validate(input({ format: "html" }));
    expect(validation.ok).toBe(false);
  });

  it("enforces the max body length", () => {
    const channel = createNotificationChannel("email", { maxBodyLength: 5 });
    expect(channel.validate(input({ content: "toolong" })).ok).toBe(false);
  });
});

describe("send / sendBatch", () => {
  it("sends through the mock transport deterministically", async () => {
    const channel = createEmailChannel();
    const output = await channel.send(input(), NOW);
    expect(output.ok).toBe(true);
    expect(output.message).toMatch(/^mock-/);
  });

  it("never throws on invalid input — returns a structured failure", async () => {
    const channel = createEmailChannel();
    const output = await channel.send(input({ recipient: createNotificationRecipient({ channel: "email", address: "bad" }) }), NOW);
    expect(output.ok).toBe(false);
    expect(output.error?.code).toBe("validation_failed");
  });

  it("propagates a failing injected transport as a structured failure", async () => {
    const failingTransport = {
      send: async () => ({ ok: false, error: { code: "provider_error", message: "down", retryable: true } }),
    };
    const channel = createEmailChannel({ transport: failingTransport });
    const output = await channel.send(input(), NOW);
    expect(output.ok).toBe(false);
    expect(output.error?.code).toBe("provider_error");
  });

  it("sendBatch sends every input in parallel and preserves order", async () => {
    const channel = createEmailChannel();
    const outputs = await channel.sendBatch([input({ content: "A" }), input({ content: "B" })], NOW);
    expect(outputs).toHaveLength(2);
    expect(outputs.every((output) => output.ok)).toBe(true);
  });

  it("sendBatch isolates per-input failures", async () => {
    const channel = createEmailChannel();
    const outputs = await channel.sendBatch(
      [input(), input({ recipient: createNotificationRecipient({ channel: "email", address: "bad" }) })],
      NOW,
    );
    expect(outputs[0]?.ok).toBe(true);
    expect(outputs[1]?.ok).toBe(false);
  });

  it("forwards subject, format and attachments to the transport", async () => {
    const mock = createMockTransport();
    const attachment = createNotificationAttachment({ name: "a.pdf", mimeType: "application/pdf" });
    const channel = createEmailChannel({ transport: mock.transport });
    await channel.send(input({ format: "html", attachments: [attachment] }), NOW);
    const record = mock.sends()[0];
    expect(record?.subject).toBe("Hi");
    expect(record?.format).toBe("html");
    expect(record?.attachments).toHaveLength(1);
    expect(record?.at).toBe(NOW);
  });
});

describe("MockTransport", () => {
  it("records deterministic message ids", async () => {
    const mock = createMockTransport();
    await mock.transport.send({ channel: "email", recipient: createNotificationRecipient({ channel: "email", address: "a@b.c" }), content: "x", at: NOW });
    await mock.transport.send({ channel: "email", recipient: createNotificationRecipient({ channel: "email", address: "a@b.c" }), content: "x", at: NOW });
    const sends = mock.sends();
    expect(sends).toHaveLength(2);
    expect(sends[0]?.messageId).toBe(sends[1]?.messageId);
  });

  it("clears its sink", async () => {
    const mock = createMockTransport();
    await mock.transport.send({ channel: "mock", recipient: createNotificationRecipient({ channel: "mock", address: "x" }), content: "c", at: NOW });
    expect(mock.count()).toBe(1);
    mock.clear();
    expect(mock.count()).toBe(0);
  });
});

describe("health and retry hints", () => {
  it("health reports healthy for built-in channels", () => {
    const health = createEmailChannel().health(NOW);
    expect(health.status).toBe("healthy");
    expect(health.score).toBe(1);
    expect(health.lastCheckedAt).toBe(NOW);
  });

  it("retryHint classifies transient failures as retryable", () => {
    const channel = createEmailChannel();
    expect(channel.retryHint({ ok: false, error: { code: "timeout", message: "t" } })).toBe(true);
    expect(channel.retryHint({ ok: false, error: { code: "provider_error", message: "t" } })).toBe(true);
    expect(channel.retryHint({ ok: false, error: { code: "validation_failed", message: "v" } })).toBe(false);
    expect(channel.retryHint({ ok: true, message: "m" })).toBe(false);
  });

  it("honours an explicit retryable flag", () => {
    const channel = createEmailChannel();
    expect(channel.retryHint({ ok: false, error: { code: "custom", message: "m", retryable: true } })).toBe(true);
  });
});

describe("NotificationChannelRegistry", () => {
  it("registers channels and rejects duplicates", () => {
    const registry = createNotificationChannelRegistry();
    const next = registry.register(createEmailChannel());
    expect(next.count()).toBe(1);
    expect(() => next.register(createEmailChannel())).toThrow(/already contains/);
  });

  it("seeds from an initial list", () => {
    const registry = createNotificationChannelRegistry({ channels: createDefaultNotificationChannels() });
    expect(registry.count()).toBe(8);
  });

  it("looks up channels by type", () => {
    const registry = createNotificationChannelRegistry().register(createEmailChannel());
    expect(registry.has("email")).toBe(true);
    expect(registry.get("email")?.channel).toBe("email");
    expect(registry.get("push")).toBeUndefined();
  });

  it("unregister removes only the target channel", () => {
    const registry = createNotificationChannelRegistry({ channels: [createEmailChannel(), createPushChannel()] });
    const next = registry.unregister("email");
    expect(next.count()).toBe(1);
    expect(next.has("push")).toBe(true);
    expect(registry.count()).toBe(2);
  });

  it("unregister is a no-op for absent channels", () => {
    const registry = createNotificationChannelRegistry();
    expect(registry.unregister("email")).toBe(registry);
  });

  it("list returns registration order and hash is deterministic", () => {
    const a = createNotificationChannelRegistry({ channels: [createEmailChannel(), createPushChannel()] });
    const b = createNotificationChannelRegistry({ channels: [createEmailChannel(), createPushChannel()] });
    expect(a.list().map((channel) => channel.channel)).toEqual(["email", "push"]);
    expect(a.hash()).toBe(b.hash());
    expect(a.hash()).toBe(channelRegistryHash(a.list()));
    const c = a.unregister("push");
    expect(c.hash()).not.toBe(a.hash());
  });
});

describe("determinism", () => {
  it("identical sends produce identical mock message ids", async () => {
    const a = createEmailChannel();
    const b = createEmailChannel();
    const first = await a.send(input(), NOW);
    const second = await b.send(input(), NOW);
    expect(first.message).toBe(second.message);
  });

  it("channels are stateless with respect to sends", async () => {
    const channel = createEmailChannel();
    await channel.send(input({ content: "A" }), NOW);
    const output = await channel.send(input({ content: "A" }), NOW);
    expect(output.ok).toBe(true);
  });
});
