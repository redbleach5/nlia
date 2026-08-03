/**
 * Emotion module tests — perceive, decay, dominantEmotion.
 *
 * Tests the rule-based perceive logic (ported from v2):
 *   - Trigger detection (warmth, rudeness, sad topics, etc.)
 *   - Emotion deltas applied correctly
 *   - Decay pulls toward baseline over time
 *   - perceiveEpisodeEmotion applies decay + perceive
 */

import { describe, it, expect } from "vitest";
import {
  perceive,
  decayEmotion,
  dominantEmotion,
  perceiveEpisodeEmotion,
  LIA_BASELINE_EMOTION,
} from "../src/identity/emotion.js";
import { NEUTRAL_EMOTION } from "../src/identity/emotional-state.js";

describe("emotion perceive", () => {
  it("detects warmth trigger from 'спасибо'", () => {
    const result = perceive("спасибо за помощь", { ...NEUTRAL_EMOTION });
    expect(result.triggers).toContain("warmth");
    expect(result.emotion.joy).toBeGreaterThan(NEUTRAL_EMOTION.joy);
    expect(result.emotion.irritation).toBeLessThan(NEUTRAL_EMOTION.irritation);
  });

  it("detects rudeness trigger from insult", () => {
    const result = perceive("ты дурак", { ...NEUTRAL_EMOTION });
    expect(result.triggers).toContain("rudeness");
    expect(result.emotion.irritation).toBeGreaterThan(NEUTRAL_EMOTION.irritation);
    expect(result.emotion.joy).toBeLessThan(NEUTRAL_EMOTION.joy);
  });

  it("detects sad topic from death/illness mention", () => {
    const result = perceive("мой дед умер на прошлой неделе", { ...NEUTRAL_EMOTION });
    expect(result.triggers).toContain("sadTopic");
    expect(result.emotion.sadness).toBeGreaterThan(NEUTRAL_EMOTION.sadness);
  });

  it("detects enthusiasm from 'ура'", () => {
    const result = perceive("ура, получилось!", { ...NEUTRAL_EMOTION });
    expect(result.triggers).toContain("enthusiasm");
    expect(result.emotion.joy).toBeGreaterThan(NEUTRAL_EMOTION.joy);
  });

  it("detects curiosity from 'почему'", () => {
    const result = perceive("почему небо голубое?", { ...NEUTRAL_EMOTION });
    expect(result.triggers).toContain("curiosity");
    expect(result.emotion.curiosity).toBeGreaterThan(NEUTRAL_EMOTION.curiosity);
  });

  it("detects task trigger from 'напиши'", () => {
    const result = perceive("напиши функцию на Python", { ...NEUTRAL_EMOTION });
    expect(result.triggers).toContain("task");
    expect(result.emotion.curiosity).toBeGreaterThan(NEUTRAL_EMOTION.curiosity);
  });

  it("returns no triggers for neutral message", () => {
    const result = perceive("хорошая погода сегодня", { ...NEUTRAL_EMOTION });
    expect(result.triggers).toHaveLength(0);
    // Emotion unchanged
    expect(result.emotion).toEqual(NEUTRAL_EMOTION);
  });

  it("clamps emotion values to [0, 1]", () => {
    const result = perceive("дурак дурак дурак", {
      ...NEUTRAL_EMOTION,
      irritation: 0.95,
    });
    expect(result.emotion.irritation).toBeLessThanOrEqual(1);
    expect(result.emotion.irritation).toBeGreaterThanOrEqual(0);
  });
});

describe("emotion decay", () => {
  it("pulls toward baseline over time", () => {
    const spiked: typeof NEUTRAL_EMOTION = {
      ...NEUTRAL_EMOTION,
      irritation: 0.9,
      joy: 0.1,
    };
    const decayed = decayEmotion(spiked, 60); // 60 minutes
    // Irritation should have decreased toward baseline
    expect(decayed.irritation).toBeLessThan(spiked.irritation);
    expect(decayed.irritation).toBeGreaterThan(NEUTRAL_EMOTION.irritation);
    // Joy should have increased toward baseline
    expect(decayed.joy).toBeGreaterThan(spiked.joy);
  });

  it("returns baseline instantly at infinite time", () => {
    const spiked = { ...NEUTRAL_EMOTION, irritation: 0.9 };
    const decayed = decayEmotion(spiked, 10000); // ~7 days
    // Should be very close to baseline
    expect(decayed.irritation).toBeCloseTo(LIA_BASELINE_EMOTION.irritation, 1);
  });

  it("no decay at zero time", () => {
    const spiked = { ...NEUTRAL_EMOTION, irritation: 0.9 };
    const decayed = decayEmotion(spiked, 0);
    expect(decayed.irritation).toBeCloseTo(0.9, 5);
  });
});

describe("dominantEmotion", () => {
  it("returns the axis with highest value", () => {
    const e = { joy: 0.8, curiosity: 0.3, calm: 0.5, irritation: 0.1, sadness: 0.2 };
    expect(dominantEmotion(e)).toBe("joy");
  });

  it("returns calm for baseline", () => {
    expect(dominantEmotion(LIA_BASELINE_EMOTION)).toBe("calm");
  });
});

describe("perceiveEpisodeEmotion", () => {
  it("applies decay + perceive", () => {
    const lastEmotion = { ...NEUTRAL_EMOTION, irritation: 0.8 };
    const lastTs = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

    const result = perceiveEpisodeEmotion("спасибо", lastEmotion, lastTs);
    // Decay should have reduced irritation, then warmth trigger should reduce it further
    expect(result.emotion.irritation).toBeLessThan(0.8);
    expect(result.triggers).toContain("warmth");
  });

  it("uses baseline for first message (no last emotion)", () => {
    const result = perceiveEpisodeEmotion("привет", null, null);
    expect(result.emotion).toBeDefined();
    expect(result.triggers).toContain("warmth"); // "привет" matches warmth
  });
});
