export type Listener<T> = (value: T) => void;

/** Tiny observable so UI code can render engine state without importing the engine. */
export class Observable<T> {
  private listeners = new Set<Listener<T>>();

  constructor(private value: T) {}

  get(): T {
    return this.value;
  }

  set(next: T): void {
    if (next === this.value) return;
    this.value = next;
    for (const listener of [...this.listeners]) listener(next);
  }

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    listener(this.value);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
