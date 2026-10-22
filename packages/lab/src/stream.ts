// Read-only snapshot delivery. No runner, job submission or cancellation code
// is reachable here. A reconnect is a new read of the latest persisted state.
export function snapshotStream<T>({
  initial,
  load,
  settled,
  signal,
  intervalMs = 1_000,
}: {
  initial: T;
  load: () => Promise<T>;
  settled: (value: T) => boolean;
  signal: AbortSignal;
  intervalMs?: number;
}) {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let last = "";
  let close: () => void = () => {};
  function cleanup() {
    stopped = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", close);
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => {
        if (!stopped) {
          cleanup();
          controller.close();
        }
      };
      if (signal.aborted) {
        close();
        return;
      }
      signal.addEventListener("abort", close, { once: true });
      function send(event: string, data: string) {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${data}\n\n`),
        );
      }
      function publish(value: T) {
        const serialized = JSON.stringify(value);
        if (serialized !== last) {
          send("snapshot", serialized);
          last = serialized;
        }
        if (settled(value)) {
          send("settled", "{}");
          close();
        }
      }
      async function tick() {
        if (stopped) return;
        try {
          // Bound buffered snapshots for a slow/disconnected reader.
          if ((controller.desiredSize ?? 0) > 0) {
            const value = await load();
            if (stopped) return;
            publish(value);
          }
        } catch {
          if (!stopped) {
            send(
              "unavailable",
              '{"message":"Saved progress is temporarily unavailable."}',
            );
            close();
          }
        }
        if (!stopped) timer = setTimeout(tick, intervalMs);
      }
      publish(initial);
      if (!stopped) timer = setTimeout(tick, intervalMs);
    },
    cancel() {
      cleanup();
    },
  });
}
