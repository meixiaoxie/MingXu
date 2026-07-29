export class ControlQueue<T> {
  readonly #items: T[] = [];

  enqueue(item: T): void {
    this.#items.push(item);
  }

  drainOne(): T | undefined {
    return this.#items.shift();
  }

  drainAll(): T[] {
    const all = [...this.#items];
    this.#items.length = 0;
    return all;
  }

  get size(): number {
    return this.#items.length;
  }
}
