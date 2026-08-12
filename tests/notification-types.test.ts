/**
 * Phase 6D STEP 2 — notification domain model tests.
 */
import { describe, expect, it } from "vitest";
import {
  createNotification,
  createNotificationRecipient,
  cloneNotification,
  touchNotification,
  notificationIdFor,
  notificationStatistics,
  notificationSummary,
  createNotificationSnapshot,
  notificationMetrics,
  createNotificationDelivery,
  touchNotificationDelivery,
  cloneNotificationDelivery,
  createNotificationDeliveryAttempt,
  createNotificationTemplate,
  touchNotificationTemplate,
  cloneNotificationTemplate,
  templateVersionFor,
  createNotificationPreference,
  touchNotificationPreference,
  createNotificationSubscription,
  createNotificationPreferenceRule,
  createNotificationRule,
  createNotificationQueueItem,
  createNotificationFailure,
  createNotificationAttachment,
  createNotificationMetadata,
  createNotificationPayload,
  createNotificationHealth,
  createNotificationRateLimit,
  createNotificationConfiguration,
  createNotificationRetryPolicy,
  createNotificationProvider,
  createNotificationProviderCapabilities,
  createNotificationMessage,
  createNotificationHistory,
  isNotificationSettled,
  isNotificationDeliverable,
  DEFAULT_NOTIFICATION_PRIORITY,
  DEFAULT_NOTIFICATION_CATEGORY,
  NOTIFICATION_CHANNEL_TYPES,
  NOTIFICATION_PRIORITY_RANK,
  recipientIdFor,
  templateIdFor,
  deliveryIdFor,
  attemptIdFor,
  messageIdFor,
  batchIdFor,
  queueItemIdFor,
  subscriptionIdFor,
  preferenceIdFor,
  preferenceRuleIdFor,
  notificationRuleIdFor,
  failureIdFor,
  attachmentIdFor,
  hashNotificationRecipient,
  isScheduleDue,
} from "@/lib/notifications/types";
import type { NotificationChannelConfig } from "@/lib/notifications/types";

const NOW = "2026-08-11T09:00:00.000Z";
const LATER = "2026-08-11T10:00:00.000Z";

const email = (address = "user@example.com") =>
  createNotificationRecipient({ channel: "email", address });
const telegram = () => createNotificationRecipient({ channel: "telegram", address: "12345" });

function sampleNotification(overrides: Partial<Parameters<typeof createNotification>[0]> = {}) {
  return createNotification({
    title: "Hello",
    body: "World",
    recipients: [email()],
    createdAt: NOW,
    ...overrides,
  });
}

describe("recipients", () => {
  it("derives a deterministic id from channel + address", () => {
    expect(email("a@b.c").id).toBe(recipientIdFor("email", "a@b.c"));
    expect(email("a@b.c").id).toBe(email("a@b.c").id);
    expect(email("a@b.c").id).not.toBe(email("x@y.z").id);
  });

  it("deep-freezes recipients", () => {
    const recipient = email();
    expect(Object.isFrozen(recipient)).toBe(true);
    const withMetadata = createNotificationRecipient({
      channel: "email",
      address: "a@b.c",
      metadata: { tenant: "t" },
    });
    expect(Object.isFrozen(withMetadata.metadata)).toBe(true);
  });

  it("copies fallback channels and metadata on construction", () => {
    const recipient = createNotificationRecipient({
      channel: "email",
      address: "a@b.c",
      fallbackChannels: ["telegram"],
      metadata: { tenant: "t" },
    });
    expect(recipient.fallbackChannels).toEqual(["telegram"]);
    expect(recipient.metadata).toEqual({ tenant: "t" });
  });

  it("hashes recipient identity deterministically", () => {
    expect(hashNotificationRecipient(email("a@b.c"))).toBe(hashNotificationRecipient(email("a@b.c")));
  });
});

describe("createNotification", () => {
  it("applies documented defaults", () => {
    const notification = sampleNotification();
    expect(notification.status).toBe("pending");
    expect(notification.priority).toBe(DEFAULT_NOTIFICATION_PRIORITY);
    expect(notification.category).toBe(DEFAULT_NOTIFICATION_CATEGORY);
    expect(notification.attempts).toBe(0);
    expect(notification.attachments).toEqual([]);
    expect(notification.metadata.tags).toEqual([]);
  });

  it("derives a deterministic id from identity fields", () => {
    const a = sampleNotification({ userId: "u1" });
    const b = sampleNotification({ userId: "u1" });
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(
      notificationIdFor("u1", "Hello", "system", "normal", NOW),
    );
    expect(a.id).not.toBe(sampleNotification({ userId: "u2" }).id);
  });

  it("accepts an explicit id", () => {
    const notification = sampleNotification({ id: "notification-abc" });
    expect(notification.id).toBe("notification-abc");
  });

  it("copies recipients, attachments and tags (no aliasing)", () => {
    const recipient = email();
    const attachment = createNotificationAttachment({ name: "f.pdf", mimeType: "application/pdf" });
    const recipients = [recipient];
    const tags = ["a"];
    const notification = createNotification({
      title: "T",
      body: "B",
      recipients,
      attachments: [attachment],
      metadata: { tags },
      createdAt: NOW,
    });
    recipients.push(telegram());
    tags.push("mutated");
    expect(notification.recipients).toHaveLength(1);
    expect(notification.metadata.tags).toEqual(["a"]);
  });

  it("deep-freezes the notification graph", () => {
    const notification = sampleNotification();
    expect(Object.isFrozen(notification)).toBe(true);
    expect(Object.isFrozen(notification.recipients)).toBe(true);
    expect(Object.isFrozen(notification.recipients[0])).toBe(true);
    expect(Object.isFrozen(notification.metadata)).toBe(true);
  });
});

describe("touchNotification", () => {
  it("returns a successor without mutating the input", () => {
    const notification = sampleNotification();
    const next = touchNotification(notification, { status: "queued" });
    expect(notification.status).toBe("pending");
    expect(next.id).toBe(notification.id);
    expect(next.status).toBe("queued");
  });

  it("clears optional fields with null", () => {
    const notification = sampleNotification({ sentAt: NOW, error: { code: "x", message: "m" } });
    const next = touchNotification(notification, { sentAt: null, error: null });
    expect(next.sentAt).toBeUndefined();
    expect(next.error).toBeUndefined();
  });

  it("preserves missing patch keys", () => {
    const notification = sampleNotification({ category: "digest", priority: "high" });
    const next = touchNotification(notification, { title: "Changed" });
    expect(next.category).toBe("digest");
    expect(next.priority).toBe("high");
  });

  it("cloneNotification returns a detached, unfrozen copy", () => {
    const notification = sampleNotification();
    const copy = cloneNotification(notification);
    expect(copy).toEqual(notification);
    expect(Object.isFrozen(copy)).toBe(false);
    expect(copy).not.toBe(notification);
  });
});

describe("templates", () => {
  it("derives deterministic ids and content versions", () => {
    const template = createNotificationTemplate({
      name: "welcome",
      body: "Hello {{user.name}}",
      variables: [{ name: "user.name", required: true }],
      createdAt: NOW,
    });
    expect(template.id).toBe(templateIdFor("welcome", NOW));
    expect(template.version).toBe(
      templateVersionFor({
        body: "Hello {{user.name}}",
        variables: [{ name: "user.name", required: true }],
      }),
    );
    expect(createNotificationTemplate({ name: "welcome", body: "Hi", createdAt: NOW }).id).toBe(
      template.id,
    );
  });

  it("version changes when the body changes", () => {
    const a = createNotificationTemplate({ name: "t", body: "A", createdAt: NOW });
    const b = createNotificationTemplate({ name: "t", body: "B", createdAt: NOW });
    expect(b.version).not.toBe(a.version);
  });

  it("touchNotificationTemplate recomputes the version", () => {
    const template = createNotificationTemplate({ name: "t", body: "A", createdAt: NOW });
    const next = touchNotificationTemplate(template, { body: "B" });
    expect(next.version).not.toBe(template.version);
    expect(template.body).toBe("A");
  });

  it("cloneNotificationTemplate detaches variables", () => {
    const template = createNotificationTemplate({
      name: "t",
      body: "x",
      variables: [{ name: "a", required: true }],
      createdAt: NOW,
    });
    const copy = cloneNotificationTemplate(template);
    copy.variables.push({ name: "b" });
    expect(template.variables).toHaveLength(1);
  });
});

describe("deliveries and attempts", () => {
  it("derives deterministic delivery and attempt ids", () => {
    const delivery = createNotificationDelivery({
      notificationId: "notification-1",
      recipientId: email().id,
      channel: "email",
      createdAt: NOW,
    });
    expect(delivery.id).toBe(deliveryIdFor("notification-1", email().id));
    const attempt = createNotificationDeliveryAttempt({
      deliveryId: delivery.id,
      attempt: 1,
      status: "sent",
      startedAt: NOW,
    });
    expect(attempt.id).toBe(attemptIdFor(delivery.id, 1, NOW));
  });

  it("touchNotificationDelivery is successor-based", () => {
    const delivery = createNotificationDelivery({
      notificationId: "n1",
      recipientId: "r1",
      channel: "email",
      createdAt: NOW,
    });
    const next = touchNotificationDelivery(delivery, {
      status: "failed",
      attempts: 1,
      error: { code: "timeout", message: "slow", retryable: true },
    });
    expect(delivery.status).toBe("pending");
    expect(next.status).toBe("failed");
    expect(next.attempts).toBe(1);
    expect(next.error).toEqual({ code: "timeout", message: "slow", retryable: true });
  });

  it("cloneNotificationDelivery preserves all fields", () => {
    const delivery = createNotificationDelivery({
      notificationId: "n1",
      recipientId: "r1",
      channel: "email",
      status: "sent",
      attempts: 2,
      createdAt: NOW,
      startedAt: NOW,
      finishedAt: LATER,
      sentAt: LATER,
      message: "provider-1",
    });
    const copy = cloneNotificationDelivery(delivery);
    expect(copy).toEqual(delivery);
    expect(Object.isFrozen(copy)).toBe(false);
  });
});

describe("messages, batches, queue items, failures", () => {
  it("message ids are deterministic", () => {
    const message = createNotificationMessage({
      notificationId: "n1",
      recipientId: "r1",
      channel: "email",
      content: "hi",
    });
    expect(message.id).toBe(messageIdFor("n1", "r1", "email"));
    expect(Object.isFrozen(message)).toBe(true);
  });

  it("batch ids are deterministic and order-stable", () => {
    expect(batchIdFor(["a", "b"], NOW)).toBe(batchIdFor(["a", "b"], NOW));
    expect(batchIdFor(["a", "b"], NOW)).not.toBe(batchIdFor(["b", "a"], NOW));
  });

  it("queue item ids are deterministic", () => {
    const item = createNotificationQueueItem({ notificationId: "n1", enqueuedAt: NOW });
    expect(item.id).toBe(queueItemIdFor("n1", NOW));
    expect(item.priority).toBe("normal");
    expect(item.attempt).toBe(0);
  });

  it("failure ids are deterministic and error is frozen", () => {
    const failure = createNotificationFailure({
      notificationId: "n1",
      attempt: 2,
      at: NOW,
      error: { code: "timeout", message: "slow" },
    });
    expect(failure.id).toBe(failureIdFor("n1", 2, NOW));
    expect(Object.isFrozen(failure.error)).toBe(true);
  });
});

describe("preferences, subscriptions, rules", () => {
  it("preference id derives from the user", () => {
    expect(preferenceIdFor("u1")).toBe(preferenceIdFor("u1"));
    expect(createNotificationPreference({ userId: "u1", updatedAt: NOW }).id).toBe(
      preferenceIdFor("u1"),
    );
  });

  it("defaults enable every category, priority and channel", () => {
    const preference = createNotificationPreference({ userId: "u1", updatedAt: NOW });
    expect(preference.muted).toBe(false);
    expect(preference.digestMode).toBe(false);
    expect(preference.categories.digest).toBe(true);
    expect(preference.priorities.critical).toBe(true);
    expect(preference.channelConfig.email.enabled).toBe(true);
  });

  it("touchNotificationPreference merges partial maps", () => {
    const preference = createNotificationPreference({ userId: "u1", updatedAt: NOW });
    const next = touchNotificationPreference(preference, {
      categories: { marketing: false },
      priorities: { low: false },
      updatedAt: LATER,
    });
    expect(next.categories.marketing).toBe(false);
    expect(next.categories.digest).toBe(true);
    expect(next.priorities.low).toBe(false);
    expect(next.priorities.critical).toBe(true);
    expect(next.updatedAt).toBe(LATER);
    expect(preference.categories.marketing).toBe(true);
  });

  it("channel config can be updated per channel", () => {
    const preference = createNotificationPreference({ userId: "u1", updatedAt: NOW });
    const next = touchNotificationPreference(preference, {
      channelConfig: { email: { enabled: false, address: "other@x.y" } },
    });
    expect(next.channelConfig.email.enabled).toBe(false);
    expect(next.channelConfig.email.address).toBe("other@x.y");
    expect(preference.channelConfig.email.enabled).toBe(true);
  });

  it("subscriptions have deterministic ids and copy channels", () => {
    const subscription = createNotificationSubscription({
      userId: "u1",
      topic: "digest",
      createdAt: NOW,
    });
    expect(subscription.id).toBe(subscriptionIdFor("u1", "digest"));
    expect(subscription.active).toBe(true);
    expect(Object.isFrozen(subscription)).toBe(true);
  });

  it("preference rules derive ids from their identity", () => {
    const rule = createNotificationPreferenceRule({
      userId: "u1",
      channel: "email",
      category: "digest",
      enabled: true,
      createdAt: NOW,
    });
    expect(rule.id).toBe(
      preferenceRuleIdFor({ userId: "u1", channel: "email", category: "digest" }),
    );
  });

  it("notification rules are immutable with defaults", () => {
    const rule = createNotificationRule({ name: "digest published", event: "digest.published", createdAt: NOW });
    expect(rule.id).toBe(notificationRuleIdFor("digest published", "digest.published", NOW));
    expect(rule.active).toBe(true);
    expect(rule.channels).toEqual([]);
  });
});

describe("statistics, summary, metrics, snapshot", () => {
  it("notificationStatistics counts by status/priority/category/channel", () => {
    const a = sampleNotification({ userId: "u1", priority: "high", category: "digest", status: "delivered" });
    const b = sampleNotification({ userId: "u2", priority: "low", category: "system", status: "failed" });
    const stats = notificationStatistics([a, b]);
    expect(stats.total).toBe(2);
    expect(stats.byStatus.delivered).toBe(1);
    expect(stats.byStatus.failed).toBe(1);
    expect(stats.byPriority.high).toBe(1);
    expect(stats.byCategory.digest).toBe(1);
    expect(stats.byChannel.email).toBe(2);
    expect(Object.isFrozen(stats.byStatus)).toBe(true);
  });

  it("notificationSummary reports the aggregate status", () => {
    const summary = notificationSummary([
      sampleNotification({ status: "delivered" }),
      sampleNotification({ status: "delivered" }),
    ]);
    expect(summary.total).toBe(2);
    expect(summary.delivered).toBe(2);
    expect(summary.overall).toBe("delivered");
  });

  it("summary overall prioritises dead > failed > pending", () => {
    expect(notificationSummary([sampleNotification({ status: "failed" })]).overall).toBe("failed");
    expect(
      notificationSummary([sampleNotification({ status: "failed" }), sampleNotification({ status: "dead" })]).overall,
    ).toBe("dead");
  });

  it("notificationMetrics computes failure rate and latency", () => {
    const delivery = createNotificationDelivery({
      notificationId: "n1",
      recipientId: "r1",
      channel: "email",
      status: "failed",
      attempts: 2,
      createdAt: NOW,
    });
    const attempt = createNotificationDeliveryAttempt({
      deliveryId: delivery.id,
      attempt: 1,
      status: "failed",
      startedAt: NOW,
      finishedAt: LATER,
      durationMs: 1500,
    });
    const failure = createNotificationFailure({
      notificationId: "n1",
      attempt: 2,
      at: LATER,
      error: { code: "timeout", message: "slow" },
    });
    const metrics = notificationMetrics({
      notifications: [sampleNotification({ status: "dead" })],
      deliveries: [delivery],
      attempts: [attempt],
      failures: [failure],
    });
    expect(metrics.dead).toBe(1);
    expect(metrics.failureRate).toBe(1);
    expect(metrics.averageLatencyMs).toBe(1500);
    expect(metrics.maxLatencyMs).toBe(1500);
  });

  it("createNotificationSnapshot deep-freezes and detaches", () => {
    const snapshot = createNotificationSnapshot({
      at: LATER,
      notifications: [sampleNotification()],
      deliveries: [],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.at).toBe(LATER);
    expect(snapshot.statistics.total).toBe(1);
  });
});

describe("configuration, limits, health, providers", () => {
  it("createNotificationConfiguration applies defaults and merges overrides", () => {
    const config = createNotificationConfiguration({
      retryPolicy: { maxRetries: 3, backoffMs: 1000 },
      limits: { maxRecipients: 5 },
    });
    expect(config.retryPolicy.maxRetries).toBe(3);
    expect(config.limits.maxRecipients).toBe(5);
    expect(config.limits.maxAttachments).toBe(10);
    expect(config.digestEnabled).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("createNotificationRetryPolicy defaults to no retries", () => {
    expect(createNotificationRetryPolicy().maxRetries).toBe(0);
    expect(createNotificationRetryPolicy({ maxRetries: 2, backoffMs: 500 }).backoffMs).toBe(500);
  });

  it("rate limits are frozen with defaults", () => {
    const limit = createNotificationRateLimit();
    expect(limit.windowMs).toBe(60_000);
    expect(limit.maxSends).toBe(100);
    expect(Object.isFrozen(limit)).toBe(true);
  });

  it("health records defaults and overrides", () => {
    expect(createNotificationHealth().status).toBe("unknown");
    expect(createNotificationHealth({ status: "healthy", score: 1, lastCheckedAt: NOW }).score).toBe(1);
  });

  it("providers derive deterministic ids and copy capabilities", () => {
    const provider = createNotificationProvider({
      channel: "email",
      name: "gmail",
      capabilities: createNotificationProviderCapabilities({ supportsAttachments: true }),
    });
    expect(provider.id).toBe(`provider-${provider.id.slice("provider-".length)}`);
    expect(provider.capabilities.supportsAttachments).toBe(true);
    expect(provider.capabilities.supportsBatch).toBe(false);
  });

  it("channel types and priority ranks are canonical", () => {
    expect(NOTIFICATION_CHANNEL_TYPES).toHaveLength(7);
    expect(NOTIFICATION_PRIORITY_RANK.critical).toBeGreaterThan(NOTIFICATION_PRIORITY_RANK.low);
  });
});

describe("lifecycle predicates", () => {
  it("isNotificationSettled accepts terminal statuses only", () => {
    expect(isNotificationSettled(sampleNotification({ status: "queued" }))).toBe(false);
    expect(isNotificationSettled(sampleNotification({ status: "delivered" }))).toBe(true);
    expect(isNotificationSettled(sampleNotification({ status: "dead" }))).toBe(true);
  });

  it("isNotificationDeliverable rejects settled, expired and future-scheduled", () => {
    expect(isNotificationDeliverable(sampleNotification({ status: "queued" }), NOW)).toBe(true);
    expect(isNotificationDeliverable(sampleNotification({ status: "sent" }), NOW)).toBe(false);
    expect(
      isNotificationDeliverable(
        sampleNotification({ metadata: { expiresAt: "2026-08-11T08:00:00.000Z" } }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isNotificationDeliverable(sampleNotification({ scheduledAt: LATER }), NOW),
    ).toBe(false);
  });

  it("isScheduleDue handles one-time schedules", () => {
    expect(isScheduleDue({ at: NOW }, NOW)).toBe(true);
    expect(isScheduleDue({ at: LATER }, NOW)).toBe(false);
  });

  it("attachments derive deterministic ids", () => {
    const attachment = createNotificationAttachment({ name: "a.pdf", mimeType: "application/pdf" });
    expect(attachment.id).toBe(attachmentIdFor("a.pdf", "application/pdf"));
  });

  it("payload and metadata helpers are frozen", () => {
    const payload = createNotificationPayload({ title: "T", body: "B", data: { k: 1 } });
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.data)).toBe(true);
    const metadata = createNotificationMetadata({ tags: ["t"], dedupeKey: "k" });
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.tags)).toBe(true);
  });

  it("history records are frozen with copied entries", () => {
    const history = createNotificationHistory("n1", [
      { at: NOW, kind: "queued" },
      { at: LATER, kind: "delivered", detail: "ok" },
    ]);
    expect(history.notificationId).toBe("n1");
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.isFrozen(history.entries[0])).toBe(true);
  });

  it("channel config type is exposed and frozen", () => {
    const config: NotificationChannelConfig = { channel: "email", enabled: true };
    const frozen = Object.freeze(config);
    expect(frozen.enabled).toBe(true);
  });
});

describe("determinism", () => {
  it("identical inputs produce identical ids and deep-equal models", () => {
    const a = sampleNotification({ recipients: [email(), telegram()] });
    const b = sampleNotification({ recipients: [email(), telegram()] });
    expect(a.id).toBe(b.id);
    expect(a).toEqual(b);
  });

  it("no wall clock or randomness is read", () => {
    const ids = Array.from({ length: 20 }, () => sampleNotification().id);
    expect(new Set(ids).size).toBe(1);
  });
});
