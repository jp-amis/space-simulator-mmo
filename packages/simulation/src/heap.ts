// Binary min-heap ordered by a numeric key (DESIGN §5.2 — scheduled event queue).

export class MinHeap<T> {
  private items: T[] = [];
  constructor(private readonly keyOf: (item: T) => number) {}

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keyOf(items[i]!) >= this.keyOf(items[parent]!)) break;
      [items[i], items[parent]] = [items[parent]!, items[i]!];
      i = parent;
    }
  }

  pop(): T | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  /** Pop every item whose key <= atMs, in ascending key order. */
  popDue(atMs: number): T[] {
    const due: T[] = [];
    while (this.items.length > 0 && this.keyOf(this.items[0]!) <= atMs) {
      due.push(this.pop()!);
    }
    return due;
  }

  private siftDown(start: number): void {
    const items = this.items;
    const n = items.length;
    let i = start;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < n && this.keyOf(items[l]!) < this.keyOf(items[smallest]!)) smallest = l;
      if (r < n && this.keyOf(items[r]!) < this.keyOf(items[smallest]!)) smallest = r;
      if (smallest === i) break;
      [items[i], items[smallest]] = [items[smallest]!, items[i]!];
      i = smallest;
    }
  }
}
