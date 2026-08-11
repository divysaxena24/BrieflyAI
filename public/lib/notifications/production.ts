/**
 * Notification & Delivery System — production composition (Phase 6D STEP 12).
 *
 * `NotificationEngine` is the composition root of the notification layer. It
 * wires the Phase 6D sub-engines:
 *
 * ```text
 * NotificationDeliveryEngine (delivery + queues + retry + dead letters)
 * NotificationPreferenceEngine (preferences / subscriptions / rules)
 * TemplateRegistry (rendered content)
 * NotificationMonitoringBridge (logs / metrics / alerts / spans / health)
 * NotificationPersistence (row-level storage over the Phase 6A DatabaseEngine)
 * NotificationBackgroundEngine (worker jobs: dispatch / replay / batch /
 *                               digest / cleanup / recovery)
 * ```
 *
 * - `createProductionNotificationEngine()` is a pure factory: it only wires
 *   the graph (optionally seeded with injected sub-engines); nothing runs
 *   during construction.
 * - `getProductionNotificationEngine()` returns the application's single
 *   engine instance (module-level singleton).
 * - `NotificationEngine` exposes thin facades over each sub-engine and
 *   re-exposes the whole-domain save/restore paths (restart recovery); it
 *   never reimplements their logic.
 *
 * Everything is dependency-injected; timestamps are caller-supplied; the
 * engine holds no wall clock.
 */

import { NotificationDeliveryEngine, type NotificationSendInput } from "./delivery";
import { NotificationPreferenceEngine } from "./preferences";
import { TemplateRegistry, createTemplateRegistry } from "./templates";
import {
  NotificationMonitoringBridge,
  createNotificationMonitoringBridge,
} from "./monitoring";
import { NotificationPersistence, createNotificationPersistence } from "./persistence";
import {
  NotificationBackgroundEngine,
  createNotificationBackgroundEngine,
} from "./background";
import type { Notification } from "./types";

/** Options accepted by the {@link NotificationEngine} constructor. */
export interface NotificationEngineOptions {
  /** Delivery engine (dependency injection); fresh by default. */
  readonly delivery?: NotificationDeliveryEngine;
  /** Preference engine (dependency injection); fresh by default. */
  readonly preferences?: NotificationPreferenceEngine;
  /** Template registry (dependency injection); fresh by default. */
  readonly templates?: TemplateRegistry;
  /** Monitoring bridge (dependency injection); fresh by default. */
  readonly monitoring?: NotificationMonitoringBridge;
  /** Persistence (dependency injection); fresh by default. */
  readonly persistence?: NotificationPersistence;
  /** Background engine (dependency injection); fresh by default. */
  readonly background?: NotificationBackgroundEngine;
  /** Injected current-time source; defaults to the wall clock. */
  readonly now?: () => string;
}

/**
 * The notification engine — the application composition root. Owns the six
 * sub-engines and re-exposes their read/write facades. Sub-engines are
 * replaced via successor wiring on every mutation (the composition-root
 * convention of Phases 6A–6C); every stored model stays immutable.
 */
export class NotificationEngine {
  private _delivery: NotificationDeliveryEngine;
  private _preferences: NotificationPreferenceEngine;
  private _templates: TemplateRegistry;
  private _monitoring: NotificationMonitoringBridge;
  private _persistence: NotificationPersistence;
  private _background: NotificationBackgroundEngine;

  private readonly now: () => string;

  constructor(options: NotificationEngineOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this._delivery = options.delivery ?? new NotificationDeliveryEngine({ now: this.now });
    this._preferences = options.preferences ?? new NotificationPreferenceEngine();
    this._templates = options.templates ?? createTemplateRegistry();
    // The engine's template registry is the delivery engine's rendering
    // source: keep them in sync so `send` renders through the engine facade.
    this._delivery.withTemplates(this._templates);
    this._monitoring = options.monitoring ?? createNotificationMonitoringBridge();
    this._persistence = options.persistence ?? createNotificationPersistence();
    this._background =
      options.background ??
      createNotificationBackgroundEngine({
        delivery: this._delivery,
        preferences: this._preferences,
        monitoring: this._monitoring,
        now: this.now,
      });
  }

  // ── Read-only facades ──────────────────────────────────────────

  /** The current delivery engine (readonly view). */
  get delivery(): NotificationDeliveryEngine {
    return this._delivery;
  }

  /** The current preference engine (readonly view). */
  get preferences(): NotificationPreferenceEngine {
    return this._preferences;
  }

  /** The current template registry (readonly view). */
  get templates(): TemplateRegistry {
    return this._templates;
  }

  /** The current monitoring bridge (readonly view). */
  get monitoring(): NotificationMonitoringBridge {
    return this._monitoring;
  }

  /** The current persistence adapter (readonly view). */
  get persistence(): NotificationPersistence {
    return this._persistence;
  }

  /** The current background engine (readonly view). */
  get background(): NotificationBackgroundEngine {
    return this._background;
  }

  // ── Delivery facade ────────────────────────────────────────────

  /**
   * Send a notification (create + enqueue + dispatch when due). Dispatch
   * receipts are fed into monitoring so inline sends are observable too
   * (the same observations `runDispatch` records for worker runs).
   */
  async send(input: NotificationSendInput, now?: string) {
    const at = now ?? this.now();
    const result = await this._delivery.send(input, at);
    if (result.summary !== undefined) {
      this._background.observeDispatchOutcomes(result.summary.receipts, at);
    }
    return result;
  }

  /**
   * Send many notifications in parallel (batch delivery). Each dispatched
   * notification's receipts are fed into monitoring (the worker `runBatch`
   * job observes the same outcomes).
   */
  async sendBatch(inputs: readonly NotificationSendInput[], now?: string) {
    const at = now ?? this.now();
    const result = await this._delivery.sendBatch(inputs, at);
    const receipts = result.notifications.flatMap((notification) =>
      this._delivery.receipts(notification.id),
    );
    if (receipts.length > 0) {
      this._background.observeDispatchOutcomes(receipts, at);
    }
    return result;
  }

  /** Schedule a notification for a future delivery (no dispatch yet). */
  schedule(
    input: Omit<NotificationSendInput, "schedule"> & { readonly schedule: { at: string } },
    now?: string,
  ) {
    const at = now ?? this.now();
    return this._delivery.schedule(input, at);
  }

  /** Dispatch every due notification at `now` (worker scheduled job). */
  dispatch(now?: string) {
    const at = now ?? this.now();
    return this._delivery.dispatch(at);
  }

  /** Every stored notification (detached copies). */
  listNotifications(): Notification[] {
    return this._delivery.list();
  }

  /** A notification by id (detached copy), or `undefined`. */
  findNotification(notificationId: string): Notification | undefined {
    return this._delivery.find(notificationId);
  }

  /** Cancel a queued notification. */
  cancel(notificationId: string, now?: string) {
    const at = now ?? this.now();
    return this._delivery.cancel(notificationId, at);
  }

  // ── Background facade ──────────────────────────────────────────

  /** Run the full background pipeline at `now` (dispatch + replay + digest + cleanup). */
  runAll(now?: string) {
    const at = now ?? this.now();
    return this._background.runAll(at);
  }

  /** Restart recovery at `now` (dispatch queued work + replay dead letters). */
  recover(now?: string) {
    const at = now ?? this.now();
    return this._background.recover(at);
  }

  // ── Persistence facade ─────────────────────────────────────────

  /** Persist the whole notification domain under `scope` (restart recovery). */
  saveAll(scope: string, now?: string) {
    const at = now ?? this.now();
    return this._persistence.saveAll(
      scope,
      {
        delivery: this._delivery,
        preferences: this._preferences,
        templates: this._templates,
      },
      at,
    );
  }

  /** Rebuild the whole notification domain from storage under `scope`. */
  restoreAll(scope: string) {
    return this._persistence.restoreAll(scope);
  }

  /** Whether any notification-domain rows exist under `scope`. */
  hasData(scope: string): Promise<boolean> {
    return this._persistence.hasData(scope);
  }

  /** Remove every notification-domain row under `scope`. */
  clear(scope: string): Promise<void> {
    return this._persistence.clear(scope);
  }

  /** A combined point-in-time monitoring snapshot at `at`. */
  monitoringSnapshot(at: string) {
    return this._monitoring.snapshot(at);
  }

  // ── Successor wiring ───────────────────────────────────────────

  /** Replace the delivery engine (state preserved; templates kept in sync). */
  withDelivery(delivery: NotificationDeliveryEngine): NotificationEngine {
    this._delivery = delivery;
    this._delivery.withTemplates(this._templates);
    this._background.restoreState({ delivery, preferences: this._preferences });
    return this;
  }

  /** Replace the preference engine (state preserved). */
  withPreferences(preferences: NotificationPreferenceEngine): NotificationEngine {
    this._preferences = preferences;
    this._background.restoreState({ delivery: this._delivery, preferences });
    return this;
  }

  /** Replace the template registry (state preserved; kept in sync with the delivery engine). */
  withTemplates(templates: TemplateRegistry): NotificationEngine {
    this._templates = templates;
    this._delivery.withTemplates(templates);
    return this;
  }

  /** Replace the persistence adapter (state preserved). */
  withPersistence(persistence: NotificationPersistence): NotificationEngine {
    this._persistence = persistence;
    return this;
  }
}

/**
 * Build a fresh production notification engine.
 *
 * Wires fresh Phase 6D sub-engines; optional overrides seed the graph for
 * dependency injection. Pure — construction only; nothing runs.
 */
export function createProductionNotificationEngine(
  options: NotificationEngineOptions = {},
): NotificationEngine {
  return new NotificationEngine(options);
}

/**
 * The application's single production notification engine instance.
 * Created once at module load.
 */
const productionNotificationEngine = createProductionNotificationEngine();

/** Return the application's single production notification engine instance. */
export function getProductionNotificationEngine(): NotificationEngine {
  return productionNotificationEngine;
}
