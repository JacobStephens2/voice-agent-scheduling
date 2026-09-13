import type { RealtimeSocket } from "../src/session.js";

type SocketEvent = "message" | "close" | "error";

export class FakeRealtimeSocket implements RealtimeSocket {
  readonly sent: unknown[] = [];
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  private readonly listeners = new Map<SocketEvent, Array<(...args: unknown[]) => void>>();
  private closed = false;

  constructor(url: string, headers: Record<string, string>) {
    this.url = url;
    this.headers = headers;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit("close");
  }

  on(event: SocketEvent, listener: (...args: unknown[]) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  receive(event: unknown): void {
    this.emit("message", JSON.stringify(event));
  }

  fail(message: string): void {
    this.emit("error", new Error(message));
  }

  messageOfType(type: string): Record<string, unknown> | undefined {
    return this.sent.find(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === type,
    );
  }

  private emit(event: SocketEvent, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}
