import { describe, it, expect } from "vitest";
import {
  extractMessageText,
  formatWhatsAppPhone,
  normalizeNumber,
  toIso,
} from "@/lib/services/whatsapp/whatsappUtils";
import type { WAMessage } from "@whiskeysockets/baileys";

/** Build a minimal WAMessage-like object for testing the text extractor. */
function message(body: unknown): WAMessage {
  return { message: body } as unknown as WAMessage;
}

describe("extractMessageText", () => {
  it("returns plain conversation text", () => {
    expect(extractMessageText(message({ conversation: "hello" }))).toBe("hello");
  });

  it("returns extended text when present", () => {
    expect(extractMessageText(message({ extendedTextMessage: { text: "long message" } }))).toBe("long message");
  });

  it("falls back to media captions", () => {
    expect(extractMessageText(message({ imageMessage: { caption: "a photo" } }))).toBe("a photo");
    expect(extractMessageText(message({ videoMessage: { caption: "a video" } }))).toBe("a video");
  });

  it("prefers conversation over captions", () => {
    expect(
      extractMessageText(message({ conversation: "text", imageMessage: { caption: "caption" } })),
    ).toBe("text");
  });

  it("returns an empty string for messages without text", () => {
    expect(extractMessageText(message({ locationMessage: { degreesLatitude: 1 } }))).toBe("");
    expect(extractMessageText(message(null))).toBe("");
  });
});

describe("formatWhatsAppPhone", () => {
  it("strips the domain and the :<device> suffix", () => {
    expect(formatWhatsAppPhone("917024296567:96@s.whatsapp.net")).toBe("917024296567");
    expect(formatWhatsAppPhone("15551234567@s.whatsapp.net")).toBe("15551234567");
  });

  it("returns null for non-phone jids", () => {
    expect(formatWhatsAppPhone("1234567890-123456@g.us")).toBeNull();
    expect(formatWhatsAppPhone("status@broadcast")).toBeNull();
    expect(formatWhatsAppPhone(null)).toBeNull();
    expect(formatWhatsAppPhone(undefined)).toBeNull();
  });
});

describe("normalizeNumber", () => {
  it("passes through finite numbers", () => {
    expect(normalizeNumber(1700000000)).toBe(1700000000);
    expect(normalizeNumber(0)).toBe(0);
  });

  it("converts Long-like objects", () => {
    expect(normalizeNumber({ toNumber: () => 42 })).toBe(42);
  });

  it("parses numeric strings and ignores junk", () => {
    expect(normalizeNumber("123")).toBe(123);
    expect(normalizeNumber("abc")).toBe(0);
    expect(normalizeNumber(null)).toBe(0);
    expect(normalizeNumber(undefined)).toBe(0);
  });
});

describe("toIso", () => {
  it("converts epoch seconds to an ISO string", () => {
    expect(toIso(1700000000)).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it("returns null for missing or invalid values", () => {
    expect(toIso(0)).toBeNull();
    expect(toIso(null)).toBeNull();
    expect(toIso("not-a-number")).toBeNull();
  });
});
