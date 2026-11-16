// Voice Call tests cover realtime keypad elevation config.
import { readFileSync } from "node:fs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import {
  normalizeVoiceCallConfig,
  resolveRealtimeElevationPin,
  validateProviderConfig,
  type VoiceCallConfig,
} from "./config.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

function createBaseConfig(
  provider: "telnyx" | "twilio" | "plivo" | "mock",
  overrides: Partial<VoiceCallConfig> = {},
): VoiceCallConfig {
  return { ...createVoiceCallBaseConfig({ provider }), ...overrides };
}

function envRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

function rejectsConfig(input: unknown, error?: RegExp) {
  expect(() => normalizeVoiceCallConfig(input as never)).toThrow(error);
}

describe("realtime keypad elevation config", () => {
  const manifestSchema = () =>
    JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"))
      .configSchema;
  const elevated = (
    elevation: Record<string, unknown>,
    overrides: Partial<VoiceCallConfig> = {},
  ): VoiceCallConfig => {
    const base = createBaseConfig("twilio", {
      fromNumber: "+15550001234",
      twilio: { accountSid: "AC123", authToken: "secret" },
      inboundPolicy: "allowlist",
      ...overrides,
    });
    return {
      ...base,
      realtime: {
        ...base.realtime,
        enabled: true,
        ...overrides.realtime,
        elevation: { ...base.realtime.elevation, enabled: true, ...elevation },
      },
    };
  };

  it("defaults off and validates shape in runtime and manifest schemas", () => {
    expect(normalizeVoiceCallConfig({}).realtime.elevation).toEqual({
      enabled: false,
      prefix: "*",
      elevatedToolPolicy: "owner",
      maxAttempts: 3,
      lockoutMs: 3_600_000,
    });
    const accepted = { enabled: true, pin: envRef("VOICE_PIN"), prefix: "9", maxAttempts: 5 };
    expect(
      normalizeVoiceCallConfig({ realtime: { elevation: accepted } }).realtime.elevation,
    ).toMatchObject(accepted);
    expect(
      validateJsonSchemaValue({
        schema: manifestSchema(),
        value: { realtime: { elevation: accepted } },
      }).ok,
    ).toBe(true);
    for (const invalid of [
      { prefix: "#" },
      { prefix: "**" },
      { elevatedToolPolicy: "none" },
      { maxAttempts: 0 },
      { lockoutMs: 0 },
    ]) {
      const input = { realtime: { elevation: invalid } };
      rejectsConfig(input);
      expect(validateJsonSchemaValue({ schema: manifestSchema(), value: input }).ok).toBe(false);
    }
  });

  it("requires a PIN, an allowlist, a consult policy, and Twilio", () => {
    const errorsFor = (config: VoiceCallConfig) => validateProviderConfig(config).errors;
    expect(errorsFor(elevated({ pin: envRef("VOICE_PIN") }))).toEqual([]);
    expect(errorsFor(elevated({}))).toEqual([
      "plugins.entries.voice-call.config.realtime.elevation.pin is required when realtime.elevation.enabled is true",
    ]);
    expect(errorsFor(elevated({ pin: "2468" }, { inboundPolicy: "open" }))).toEqual([
      'plugins.entries.voice-call.config.inboundPolicy must be "allowlist" or "pairing" when realtime.elevation.enabled is true',
    ]);
    const noConsult = elevated({ pin: "2468" });
    noConsult.realtime.toolPolicy = "none";
    expect(errorsFor(noConsult)).toEqual([
      'plugins.entries.voice-call.config.realtime.toolPolicy must not be "none" when realtime.elevation.enabled is true',
    ]);
    expect(
      errorsFor(
        elevated(
          { pin: "2468" },
          {
            provider: "telnyx",
            skipSignatureVerification: true,
            telnyx: { apiKey: "K", connectionId: "C" },
          },
        ),
      ),
    ).toEqual([
      'plugins.entries.voice-call.config.provider must be "twilio" when realtime.elevation.enabled is true (keypad digits arrive on Twilio Media Streams)',
    ]);
  });

  it("resolves a 4-12 digit PIN without echoing invalid values", () => {
    expect(resolveRealtimeElevationPin(elevated({ pin: "024680" }))).toBe("024680");
    expect(resolveRealtimeElevationPin(createBaseConfig("twilio"))).toBeUndefined();
    for (const pin of ["123", "1234567890123", "12a4"]) {
      expect(() => resolveRealtimeElevationPin(elevated({ pin }))).toThrow(
        /^plugins\.entries\.voice-call\.config\.realtime\.elevation\.pin must resolve to 4-12 digits$/,
      );
    }
    expect(() => resolveRealtimeElevationPin(elevated({ pin: envRef("VOICE_PIN") }))).toThrow(
      /unresolved SecretRef/,
    );
  });
});
