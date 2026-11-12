import { describe, it, expect } from 'vitest';
import { evenDimensions, computeBitrate, frameCount, frameTimestampUs, frameDurationUs, avcLevel, codecCandidates, videoFileName } from '../src/export/video';

describe('video export helpers', () => {
  it('rounds output size to even numbers', () => {
    expect(evenDimensions(1920, 1080, 1)).toEqual({ width: 1920, height: 1080 });
    expect(evenDimensions(1920, 1080, 0.5)).toEqual({ width: 960, height: 540 });
    expect(evenDimensions(1001, 333, 1)).toEqual({ width: 1002, height: 334 });
    expect(evenDimensions(375, 667, 0.5)).toEqual({ width: 188, height: 334 });
    expect(evenDimensions(1, 1, 0.5)).toEqual({ width: 2, height: 2 });
    const d = evenDimensions(1279, 719, 2);
    expect(d.width % 2).toBe(0); expect(d.height % 2).toBe(0);
  });

  it('computes bitrate from pixels, fps and quality, clamped', () => {
    expect(computeBitrate(1920, 1080, 30, 'medium')).toBe(Math.round(1920 * 1080 * 30 * 0.1));
    expect(computeBitrate(1920, 1080, 30, 'high')).toBeGreaterThan(computeBitrate(1920, 1080, 30, 'medium'));
    expect(computeBitrate(1920, 1080, 30, 'low')).toBeLessThan(computeBitrate(1920, 1080, 30, 'medium'));
    expect(computeBitrate(64, 64, 1, 'low')).toBe(500_000);
    expect(computeBitrate(7680, 4320, 60, 'high')).toBe(80_000_000);
  });

  it('frame count and timestamps tile the duration exactly', () => {
    expect(frameCount(3, 30)).toBe(90);
    expect(frameCount(2.5, 24)).toBe(60);
    expect(frameCount(1 / 3, 30)).toBe(10);
    expect(frameCount(0, 30)).toBe(1);
    expect(frameTimestampUs(0, 30)).toBe(0);
    expect(frameTimestampUs(1, 30)).toBe(33333);
    expect(frameTimestampUs(30, 30)).toBe(1_000_000);
    expect(frameTimestampUs(3, 29.97)).toBe(100100);
    let sum = 0;
    for (let i = 0; i < 90; i++) { const d = frameDurationUs(i, 30); expect(d === 33333 || d === 33334).toBe(true); sum += d; }
    expect(sum).toBe(3_000_000);
  });

  it('picks H.264 levels by size and rate', () => {
    expect(avcLevel(1280, 720, 30)).toBe(0x1f);   // 3.1
    expect(avcLevel(1920, 1080, 30)).toBe(0x28);  // 4.0
    expect(avcLevel(1920, 1080, 60)).toBe(0x2a);  // 4.2
    expect(avcLevel(3840, 2160, 30)).toBe(0x33);  // 5.1
    expect(avcLevel(3840, 2160, 60)).toBe(0x34);  // 5.2
  });

  it('lists codec candidates', () => {
    const mp4 = codecCandidates('mp4', 1920, 1080, 30);
    expect(mp4[0]).toBe('avc1.640028');
    expect(mp4.every(c => /^avc1\.[0-9a-f]{6}$/.test(c))).toBe(true);
    expect(codecCandidates('webm', 1920, 1080, 30)[0]).toBe('vp09.00.41.08');
    expect(codecCandidates('webm', 3840, 2160, 30)[0]).toBe('vp09.00.51.08');
  });

  it('makes safe file names', () => {
    expect(videoFileName('My: clip/1', 'mp4')).toBe('My_ clip_1.mp4');
    expect(videoFileName('', 'webm')).toBe('animation.webm');
  });
});
