// Minimal event emitter that works in Node and in the browser.
type Listener = (payload: never) => void;

export class Emitter {
  private listeners = new Map<string, Set<Listener>>();

  on<T>(event: string, fn: (payload: T) => void): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn as Listener);
    return () => this.listeners.get(event)?.delete(fn as Listener);
  }

  emit<T>(event: string, payload?: T): void {
    for (const fn of this.listeners.get(event) ?? []) (fn as (p: T | undefined) => void)(payload);
  }
}
