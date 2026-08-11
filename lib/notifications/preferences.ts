/**
 * Notification & Delivery System — user preferences (Phase 6D STEP 8).
 *
 * A successor-based preference engine over the immutable
 * `NotificationPreference` / `NotificationSubscription` /
 * `NotificationPreferenceRule` models (types module). It answers the
 * per-user delivery questions the pipeline needs before dispatching:
 *
 * - **Preferred channels**: the user's enabled channel set, derived from
 *   the preference's `channels` allow-list and per-channel `enabled` flags.
 * - **Mute**: permanent (`muted`) or until a timestamp (`mutedUntil`).
 * - **Quiet hours**: a daily `HH:mm` window; non-critical notifications
 *   inside the window are suppressed.
 * - **Digest mode**: when enabled, notifications are aggregated instead of
 *   sent immediately.
 * - **Category & priority filters**: per-category / per-priority enablement.
 * - **Subscriptions**: per-user per-topic subscribe / unsubscribe with an
 *   active flag and per-subscription channel set.
 * - **Rules**: per-user allow/block rules over channel/category/priority.
 * - **Language & timezone**: surfaced on the preference model.
 *
 * Every mutation returns a successor engine (in-place replacement following
 * the Monitoring/Worker engine convention — the receiver's state fields are
 * reassigned, the stored models are never mutated). All timestamps are
 * caller-supplied; no wall clock is read.
 */

import {
  NOTIFICATION_CHANNEL_TYPES,
  type NotificationCategory,
  type NotificationChannelConfig,
  type NotificationChannelType,
  type NotificationPreference,
  type NotificationPreferenceRule,
  type NotificationPriority,
  type NotificationSubscription,
} from "./types";
import {
  createNotificationPreference,
  createNotificationPreferenceRule,
  createNotificationSubscription,
  touchNotificationPreference,
} from "./types";

/**
 * Detached, unfrozen copy of a preference (never mutates the input). Built
 * by hand — `touchNotificationPreference` re-freezes through
 * `createNotificationPreference`, which would break the detached-copy
 * contract on reads.
 */
function clonePreference(preference: NotificationPreference): NotificationPreference {
  return {
    id: preference.id,
    userId: preference.userId,
    channels: [...preference.channels],
    muted: preference.muted,
    ...(preference.mutedUntil !== undefined ? { mutedUntil: preference.mutedUntil } : {}),
    ...(preference.quietHours !== undefined
      ? { quietHours: { ...preference.quietHours } }
      : {}),
    digestMode: preference.digestMode,
    ...(preference.language !== undefined ? { language: preference.language } : {}),
    ...(preference.timezone !== undefined ? { timezone: preference.timezone } : {}),
    categories: { ...preference.categories },
    priorities: { ...preference.priorities },
    channelConfig: Object.fromEntries(
      NOTIFICATION_CHANNEL_TYPES.map((channel) => {
        const config = preference.channelConfig[channel];
        return [
          channel,
          {
            ...config,
            ...(config.quietHours !== undefined
              ? { quietHours: { ...config.quietHours } }
              : {}),
          },
        ];
      }),
    ) as Record<NotificationChannelType, NotificationChannelConfig>,
    updatedAt: preference.updatedAt,
  };
}

/** Options accepted by the {@link NotificationPreferenceEngine} constructor. */
export interface NotificationPreferenceEngineOptions {
  readonly preferences?: readonly NotificationPreference[];
  readonly subscriptions?: readonly NotificationSubscription[];
  readonly rules?: readonly NotificationPreferenceRule[];
}

/** A per-user delivery decision produced by the engine. */
export interface NotificationDeliveryDecision {
  /** Whether the notification should be delivered. */
  readonly allowed: boolean;
  /** Why it is blocked (empty when allowed). */
  readonly reasons: readonly string[];
  /**
   * The channel types delivery may use, after applying the user's
   * preferences to the requested channels. Empty when the notification is
   * not allowed.
   */
  readonly channels: readonly NotificationChannelType[];
  /** Whether the user prefers digest aggregation for this notification. */
  readonly digest: boolean;
}

/** Input accepted by {@link NotificationPreferenceEngine.decision}. */
export interface NotificationDeliveryDecisionInput {
  readonly userId: string;
  readonly category: NotificationCategory;
  readonly priority: NotificationPriority;
  /** ISO-8601 UTC timestamp of the proposed delivery. */
  readonly at: string;
  /** Requested channels; defaults to the preference's preferred channels. */
  readonly channels?: readonly NotificationChannelType[];
}

/** Outcome of evaluating quiet hours for a timestamp. */
export interface QuietHoursOutcome {
  readonly inQuietHours: boolean;
  /** The active window, when inside one. */
  readonly window?: { readonly start: string; readonly end: string };
}

/** A subscription summary for a user. */
export interface SubscriptionSummary {
  readonly total: number;
  readonly active: number;
  readonly byTopic: Readonly<Record<string, number>>;
}

/**
 * The successor-based preference engine. State fields are replaced on
 * mutation; every read returns detached copies.
 */
export class NotificationPreferenceEngine {
  private _preferences: readonly NotificationPreference[];
  private _subscriptions: readonly NotificationSubscription[];
  private _rules: readonly NotificationPreferenceRule[];

  constructor(options: NotificationPreferenceEngineOptions = {}) {
    this._preferences = [...(options.preferences ?? [])].map(clonePreference);
    this._subscriptions = [...(options.subscriptions ?? [])].map((subscription) => ({
      ...subscription,
      channels: [...subscription.channels],
    }));
    this._rules = [...(options.rules ?? [])].map((rule) => ({ ...rule }));
  }

  // ─────────────────────────────────────────────────────────────
  // Reads.
  // ─────────────────────────────────────────────────────────────

  /** Detached copies of every preference, oldest first. */
  listPreferences(): NotificationPreference[] {
    return this._preferences.map(clonePreference);
  }

  /** The preference of `userId`, or `undefined` (detached copy). */
  getPreference(userId: string): NotificationPreference | undefined {
    const preference = this._preferences.find(
      (candidate) => candidate.userId === userId,
    );
    return preference === undefined ? undefined : clonePreference(preference);
  }

  /** Whether a preference record exists for `userId`. */
  hasPreference(userId: string): boolean {
    return this._preferences.some((candidate) => candidate.userId === userId);
  }

  /** Number of tracked preferences. */
  preferenceCount(): number {
    return this._preferences.length;
  }

  /** Every subscription across all users (detached copies, insertion order). */
  listAllSubscriptions(): NotificationSubscription[] {
    return this._subscriptions.map((subscription) => ({
      ...subscription,
      channels: [...subscription.channels],
    }));
  }

  /** Every subscription of `userId` (detached copies, newest first). */
  listSubscriptions(userId: string): NotificationSubscription[] {
    return this._subscriptions
      .filter((subscription) => subscription.userId === userId)
      .map((subscription) => ({
        ...subscription,
        channels: [...subscription.channels],
      }));
  }

  /** The subscription of `userId` for `topic`, or `undefined`. */
  getSubscription(userId: string, topic: string): NotificationSubscription | undefined {
    const subscription = this._subscriptions.find(
      (candidate) => candidate.userId === userId && candidate.topic === topic,
    );
    return subscription === undefined
      ? undefined
      : { ...subscription, channels: [...subscription.channels] };
  }

  /** Whether `userId` is actively subscribed to `topic`. */
  isSubscribed(userId: string, topic: string): boolean {
    const subscription = this.getSubscription(userId, topic);
    return subscription !== undefined && subscription.active;
  }

  /** Every rule across all users (detached copies, insertion order). */
  listAllRules(): NotificationPreferenceRule[] {
    return this._rules.map((rule) => ({ ...rule }));
  }

  /** Every rule of `userId` (detached copies). */
  listRules(userId: string): NotificationPreferenceRule[] {
    return this._rules.filter((rule) => rule.userId === userId).map((rule) => ({ ...rule }));
  }

  /** Every rule that matches the given channel/category/priority. */
  rulesFor(
    userId: string,
    input: {
      readonly channel?: NotificationChannelType;
      readonly category?: NotificationCategory;
      readonly priority?: NotificationPriority;
    },
  ): NotificationPreferenceRule[] {
    return this._rules.filter(
      (rule) =>
        rule.userId === userId &&
        (input.channel === undefined || rule.channel === input.channel) &&
        (input.category === undefined || rule.category === input.category) &&
        (input.priority === undefined || rule.priority === input.priority),
    );
  }

  /** A per-user subscription summary. */
  subscriptionSummary(userId: string): SubscriptionSummary {
    const subscriptions = this.listSubscriptions(userId);
    const byTopic: Record<string, number> = {};
    for (const subscription of subscriptions) {
      byTopic[subscription.topic] = (byTopic[subscription.topic] ?? 0) + 1;
    }
    return Object.freeze({
      total: subscriptions.length,
      active: subscriptions.filter((subscription) => subscription.active).length,
      byTopic: Object.freeze(byTopic),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Preference mutations (successor-based).
  // ─────────────────────────────────────────────────────────────

  /**
   * Set the full preference of `userId` (upsert). Returns the successor
   * engine and the stored preference.
   */
  setPreference(
    userId: string,
    input: Omit<Parameters<typeof createNotificationPreference>[0], "userId">,
  ): { engine: NotificationPreferenceEngine; preference: NotificationPreference } {
    const preference = createNotificationPreference({ ...input, userId });
    if (this.hasPreference(userId)) {
      this._preferences = this._preferences.map((candidate) =>
        candidate.userId === userId ? clonePreference(preference) : candidate,
      );
    } else {
      this._preferences = [...this._preferences, clonePreference(preference)];
    }
    return { engine: this, preference: clonePreference(preference) };
  }

  /**
   * Apply a patch to the preference of `userId` (creating a default
   * preference first when absent). Returns the successor engine and the
   * stored preference.
   */
  updatePreference(
    userId: string,
    patch: Parameters<typeof touchNotificationPreference>[1],
    updatedAt: string,
  ): { engine: NotificationPreferenceEngine; preference: NotificationPreference } {
    const current = this.getPreference(userId) ?? this.defaultPreference(userId, updatedAt);
    const updated = touchNotificationPreference(current, {
      ...patch,
      ...(patch.updatedAt === undefined ? { updatedAt } : {}),
    });
    if (this.hasPreference(userId)) {
      this._preferences = this._preferences.map((candidate) =>
        candidate.userId === userId ? clonePreference(updated) : candidate,
      );
    } else {
      this._preferences = [...this._preferences, clonePreference(updated)];
    }
    return { engine: this, preference: clonePreference(updated) };
  }

  /** Mute `userId` (optionally until `until`). */
  mute(
    userId: string,
    updatedAt: string,
    until?: string,
  ): { engine: NotificationPreferenceEngine; preference: NotificationPreference } {
    return this.updatePreference(
      userId,
      { muted: true, ...(until !== undefined ? { mutedUntil: until } : {}) },
      updatedAt,
    );
  }

  /** Unmute `userId` and clear any `mutedUntil`. */
  unmute(
    userId: string,
    updatedAt: string,
  ): { engine: NotificationPreferenceEngine; preference: NotificationPreference } {
    return this.updatePreference(userId, { muted: false, mutedUntil: null }, updatedAt);
  }

  /** Set quiet hours for `userId` (null clears them). */
  setQuietHours(
    userId: string,
    quietHours: { readonly start: string; readonly end: string } | null,
    updatedAt: string,
  ): { engine: NotificationPreferenceEngine; preference: NotificationPreference } {
    return this.updatePreference(
      userId,
      { quietHours: quietHours ?? null },
      updatedAt,
    );
  }

  /** Enable or disable a channel for `userId`. */
  setChannelEnabled(
    userId: string,
    channel: NotificationChannelType,
    enabled: boolean,
    updatedAt: string,
  ): { engine: NotificationPreferenceEngine; preference: NotificationPreference } {
    return this.updatePreference(
      userId,
      { channelConfig: { [channel]: { enabled } } },
      updatedAt,
    );
  }

  /** Set the per-channel override address (null clears it). */
  setChannelAddress(
    userId: string,
    channel: NotificationChannelType,
    address: string | null,
    updatedAt: string,
  ): { engine: NotificationPreferenceEngine; preference: NotificationPreference } {
    return this.updatePreference(
      userId,
      {
        channelConfig: {
          [channel]: address === null ? { enabled: undefined } : { address },
        },
      },
      updatedAt,
    );
  }

  /** Enable or disable a category for `userId`. */
  setCategoryEnabled(
    userId: string,
    category: NotificationCategory,
    enabled: boolean,
    updatedAt: string,
  ): { engine: NotificationPreferenceEngine; preference: NotificationPreference } {
    return this.updatePreference(userId, { categories: { [category]: enabled } }, updatedAt);
  }

  /** Enable or disable a priority for `userId`. */
  setPriorityEnabled(
    userId: string,
    priority: NotificationPriority,
    enabled: boolean,
    updatedAt: string,
  ): { engine: NotificationPreferenceEngine; preference: NotificationPreference } {
    return this.updatePreference(userId, { priorities: { [priority]: enabled } }, updatedAt);
  }

  /** Toggle digest mode for `userId`. */
  setDigestMode(
    userId: string,
    enabled: boolean,
    updatedAt: string,
  ): { engine: NotificationPreferenceEngine; preference: NotificationPreference } {
    return this.updatePreference(userId, { digestMode: enabled }, updatedAt);
  }

  /** Set the preferred channels allow-list for `userId`. */
  setPreferredChannels(
    userId: string,
    channels: readonly NotificationChannelType[],
    updatedAt: string,
  ): { engine: NotificationPreferenceEngine; preference: NotificationPreference } {
    return this.updatePreference(userId, { channels }, updatedAt);
  }

  // ─────────────────────────────────────────────────────────────
  // Subscription mutations (successor-based).
  // ─────────────────────────────────────────────────────────────

  /** Subscribe `userId` to `topic` (upsert — re-activates and merges channels). */
  subscribe(
    userId: string,
    topic: string,
    channels: readonly NotificationChannelType[],
    createdAt: string,
  ): { engine: NotificationPreferenceEngine; subscription: NotificationSubscription } {
    const existing = this.getSubscription(userId, topic);
    const subscription = createNotificationSubscription({
      id: existing?.id,
      userId,
      topic,
      channels: channels.length > 0 ? channels : existing?.channels ?? [],
      active: true,
      createdAt: existing?.createdAt ?? createdAt,
    });
    if (existing !== undefined) {
      this._subscriptions = this._subscriptions.map((candidate) =>
        candidate.userId === userId && candidate.topic === topic
          ? { ...subscription, channels: [...subscription.channels] }
          : candidate,
      );
    } else {
      this._subscriptions = [
        ...this._subscriptions,
        { ...subscription, channels: [...subscription.channels] },
      ];
    }
    return { engine: this, subscription: { ...subscription, channels: [...subscription.channels] } };
  }

  /** Unsubscribe `userId` from `topic` (removes the subscription). */
  unsubscribe(
    userId: string,
    topic: string,
  ): { engine: NotificationPreferenceEngine; removed: boolean } {
    const before = this._subscriptions.length;
    this._subscriptions = this._subscriptions.filter(
      (subscription) => !(subscription.userId === userId && subscription.topic === topic),
    );
    return { engine: this, removed: this._subscriptions.length < before };
  }

  /** Activate or deactivate an existing subscription. */
  setSubscriptionActive(
    userId: string,
    topic: string,
    active: boolean,
  ): { engine: NotificationPreferenceEngine; subscription?: NotificationSubscription } {
    const existing = this.getSubscription(userId, topic);
    if (existing === undefined) return { engine: this };
    const updated: NotificationSubscription = { ...existing, active };
    this._subscriptions = this._subscriptions.map((candidate) =>
      candidate.userId === userId && candidate.topic === topic
        ? { ...updated, channels: [...candidate.channels] }
        : candidate,
    );
    return { engine: this, subscription: { ...updated, channels: [...updated.channels] } };
  }

  // ─────────────────────────────────────────────────────────────
  // Rule mutations (successor-based).
  // ─────────────────────────────────────────────────────────────

  /** Add an allow/block rule for `userId` (deduplicated by id). */
  addRule(input: Omit<Parameters<typeof createNotificationPreferenceRule>[0], "userId"> & {
    readonly userId: string;
  }): { engine: NotificationPreferenceEngine; rule: NotificationPreferenceRule } {
    const rule = createNotificationPreferenceRule(input);
    if (this._rules.some((candidate) => candidate.id === rule.id)) {
      throw new Error(`Preference rule already exists: ${rule.id}`);
    }
    this._rules = [...this._rules, { ...rule }];
    return { engine: this, rule: { ...rule } };
  }

  /** Remove the rule with `ruleId` (no-op when absent). */
  removeRule(ruleId: string): NotificationPreferenceEngine {
    this._rules = this._rules.filter((rule) => rule.id !== ruleId);
    return this;
  }

  // ─────────────────────────────────────────────────────────────
  // Delivery decisions.
  // ─────────────────────────────────────────────────────────────

  /**
   * The per-user delivery decision for a notification. Checks, in order:
   * mute, quiet hours (non-critical), category filter, priority filter,
   * channel enablement, and matching rules. Never throws.
   */
  decision(input: NotificationDeliveryDecisionInput): NotificationDeliveryDecision {
    const preference = this.getPreference(input.userId);
    const reasons: string[] = [];

    // No preference → default-allowed.
    if (preference === undefined) {
      const channels = input.channels ?? [];
      const digest = false;
      const matchedRules = this.applicableRules(input.userId, {
        channel: input.channels?.[0],
        category: input.category,
        priority: input.priority,
      });
      if (matchedRules.some((rule) => !rule.enabled)) {
        reasons.push("blocked_by_rule");
      }
      return Object.freeze({
        allowed: reasons.length === 0,
        reasons: Object.freeze(reasons),
        channels: Object.freeze(reasons.length === 0 ? channels : []),
        digest,
      });
    }

    // Mute (permanent or within `mutedUntil`).
    if (this.isMutedAt(preference, input.at)) {
      reasons.push("muted");
    }

    // Quiet hours (non-critical only).
    if (input.priority !== "critical") {
      const quiet = this.quietHoursOutcome(preference.quietHours, input.at);
      if (quiet.inQuietHours) {
        reasons.push("quiet_hours");
      }
    }

    // Category and priority filters.
    if (!preference.categories[input.category]) {
      reasons.push("category_disabled");
    }
    if (!preference.priorities[input.priority]) {
      reasons.push("priority_disabled");
    }

    // Channel resolution.
    const requested = input.channels ?? this.preferredChannels(preference);

    // Matching rules (an explicit block overrides everything).
    const matchedRules = this.applicableRules(input.userId, {
      channel: requested[0],
      category: input.category,
      priority: input.priority,
    });
    if (matchedRules.some((rule) => !rule.enabled)) {
      reasons.push("blocked_by_rule");
    }

    const channels = requested.filter((channel) => this.isChannelEnabled(preference, channel));

    const allowed = reasons.length === 0 && channels.length > 0;
    return Object.freeze({
      allowed,
      reasons: Object.freeze(reasons),
      channels: Object.freeze(allowed ? channels : []),
      digest: preference.digestMode,
    });
  }

  /** The user's preferred (enabled) channels, in preference order. */
  preferredChannels(
    userIdOrPreference: string | NotificationPreference,
  ): NotificationChannelType[] {
    const preference =
      typeof userIdOrPreference === "string"
        ? this.getPreference(userIdOrPreference)
        : userIdOrPreference;
    if (preference === undefined) return [];
    const allowList =
      preference.channels.length > 0
        ? preference.channels
        : (["email", "discord", "telegram", "whatsapp", "webhook", "push", "inapp", "mock"] as const);
    return allowList.filter((channel) => this.isChannelEnabled(preference, channel));
  }

  /** Whether the channel is enabled for the preference. */
  isChannelEnabled(preference: NotificationPreference, channel: NotificationChannelType): boolean {
    const config = preference.channelConfig[channel];
    if (config === undefined) return true;
    return config.enabled;
  }

  /**
   * Whether the user is muted at `at`. Permanent when `muted` with no
   * `mutedUntil`; temporary (until the timestamp) when `mutedUntil` is set.
   */
  isMutedAt(preference: NotificationPreference, at: string): boolean {
    if (!preference.muted) return false;
    if (preference.mutedUntil === undefined) return true;
    return Date.parse(preference.mutedUntil) > Date.parse(at);
  }

  /**
   * The rules that *apply* to a notification: every dimension the rule
   * specifies must match; unspecified dimensions are wildcards. Used by
   * {@link decision} (distinct from {@link rulesFor}, which requires exact
   * matches on the queried dimensions).
   */
  private applicableRules(
    userId: string,
    input: {
      readonly channel?: NotificationChannelType;
      readonly category?: NotificationCategory;
      readonly priority?: NotificationPriority;
    },
  ): NotificationPreferenceRule[] {
    return this._rules.filter(
      (rule) =>
        rule.userId === userId &&
        (rule.channel === undefined || rule.channel === input.channel) &&
        (rule.category === undefined || rule.category === input.category) &&
        (rule.priority === undefined || rule.priority === input.priority),
    );
  }

  /**
   * Whether `at` falls inside a quiet-hours window. A window wraps past
   * midnight when `end <= start`. Deterministic, timezone-agnostic (the
   * caller supplies a local-time label or the window compares against the
   * same clock).
   */
  quietHoursOutcome(
    quietHours: { readonly start: string; readonly end: string } | undefined,
    at: string,
  ): QuietHoursOutcome {
    if (quietHours === undefined) {
      return Object.freeze({ inQuietHours: false });
    }
    const time = toMinutes(at);
    const start = parseHHMM(quietHours.start);
    const end = parseHHMM(quietHours.end);
    let inside = false;
    if (start <= end) {
      inside = time >= start && time < end;
    } else {
      // Overnight window (e.g. 22:00 → 07:00).
      inside = time >= start || time < end;
    }
    return Object.freeze({
      inQuietHours: inside,
      ...(inside ? { window: { start: quietHours.start, end: quietHours.end } } : {}),
    });
  }

  /** Build a default (all-enabled) preference for `userId`. */
  defaultPreference(userId: string, updatedAt: string): NotificationPreference {
    return createNotificationPreference({ userId, updatedAt });
  }

  /** Restore persisted state wholesale (restart recovery). */
  restoreState(input: {
    readonly preferences: readonly NotificationPreference[];
    readonly subscriptions: readonly NotificationSubscription[];
    readonly rules: readonly NotificationPreferenceRule[];
  }): NotificationPreferenceEngine {
    this._preferences = input.preferences.map(clonePreference);
    this._subscriptions = input.subscriptions.map((subscription) => ({
      ...subscription,
      channels: [...subscription.channels],
    }));
    this._rules = input.rules.map((rule) => ({ ...rule }));
    return this;
  }
}

/** Build a fresh preference engine. */
export function createNotificationPreferenceEngine(
  options: NotificationPreferenceEngineOptions = {},
): NotificationPreferenceEngine {
  return new NotificationPreferenceEngine(options);
}

/** Minutes since midnight of the local time part of `at`. */
function toMinutes(at: string): number {
  const date = new Date(Date.parse(at));
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

/** Parse an HH:mm string into minutes since midnight. */
function parseHHMM(value: string): number {
  const [hours, minutes] = value.split(":").map((part) => Number(part));
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

export type {
  NotificationPreference,
  NotificationSubscription,
  NotificationPreferenceRule,
  NotificationChannelConfig,
};
