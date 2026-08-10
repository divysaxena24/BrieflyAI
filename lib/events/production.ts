/**
 * Application Event Bus — production composition (Phase 5J STEP 5).
 *
 * The application's single event bus instance. Buses are immutable and
 * stateless; the singleton is a convenience so the application wires
 * listeners once (e.g. the workflow triggering wiring in `./wiring`).
 */

import { EventBus } from "./bus";

/**
 * Build a fresh production event bus.
 * Pure — construction only; no listeners are registered.
 */
export function createProductionEventBus(): EventBus {
  return new EventBus();
}

/**
 * The application's single production event bus instance.
 * Created once at module load.
 */
const productionEventBus = createProductionEventBus();

/** Return the application's single production event bus instance. */
export function getProductionEventBus(): EventBus {
  return productionEventBus;
}
