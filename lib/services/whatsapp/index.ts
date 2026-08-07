// ──────────────────────────────────────────────
//  WhatsApp services barrel
//  Reusable session layer + read service.
// ──────────────────────────────────────────────

export * from "./whatsappService";
export * from "./whatsappClient";
export * from "./whatsappUtils";

export { default as WhatsAppService } from "./whatsappService";
export { default as WhatsAppClient } from "./whatsappClient";
export { whatsappSessionManager } from "./whatsappSessionManager";