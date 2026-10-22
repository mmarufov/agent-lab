import { afterEach, expect, it, vi } from "vitest";
import { snapshotStream } from "../src/stream";
afterEach(() => vi.useRealTimers());
const decode = (chunk: { value?: Uint8Array }) =>
  new TextDecoder().decode(chunk.value);

it("delivers initial and changed snapshots, then settles and stops loading", async () => {
  vi.useFakeTimers();
  let value = { count: 0, done: false };
  const load = vi.fn(async () => value);
  const reader = snapshotStream({
    initial: value,
    load,
    settled: (value) => value.done,
    signal: new AbortController().signal,
  }).getReader();
  expect(decode(await reader.read())).toContain(
    'event: snapshot\ndata: {"count":0',
  );
  const next = reader.read();
  await vi.advanceTimersByTimeAsync(1000);
  expect(load).toHaveBeenCalledTimes(1);
  value = { count: 1, done: true };
  await vi.advanceTimersByTimeAsync(1000);
  expect(decode(await next)).toContain('"count":1');
  expect(decode(await reader.read())).toContain("event: settled");
  expect((await reader.read()).done).toBe(true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(load).toHaveBeenCalledTimes(2);
});

it("cancels the read timer on disconnect without invoking execution code", async () => {
  vi.useFakeTimers();
  const load = vi.fn(async () => ({ done: false }));
  const abort = new AbortController();
  const reader = snapshotStream({
    initial: { done: false },
    load,
    settled: (value) => value.done,
    signal: abort.signal,
  }).getReader();
  await reader.read();
  abort.abort();
  await vi.advanceTimersByTimeAsync(5000);
  expect(load).not.toHaveBeenCalled();
  expect((await reader.read()).done).toBe(true);
});

it("reconnecting starts with the latest saved snapshot, including terminal runs", async () => {
  const load = vi.fn();
  const reader = snapshotStream({
    initial: { done: true, count: 8 },
    load,
    settled: (value) => value.done,
    signal: new AbortController().signal,
  }).getReader();
  expect(decode(await reader.read())).toContain('"count":8');
  expect(decode(await reader.read())).toContain("event: settled");
  expect((await reader.read()).done).toBe(true);
  expect(load).not.toHaveBeenCalled();
});

it("closes on read failures without exposing private errors", async () => {
  vi.useFakeTimers();
  const reader = snapshotStream({
    initial: {},
    load: async () => {
      throw new Error("PRIVATE_DATABASE_URL");
    },
    settled: () => false,
    signal: new AbortController().signal,
  }).getReader();
  await reader.read();
  const next = reader.read();
  await vi.advanceTimersByTimeAsync(1000);
  const message = decode(await next);
  expect(message).toContain("event: unavailable");
  expect(message).not.toContain("PRIVATE");
  expect((await reader.read()).done).toBe(true);
});
