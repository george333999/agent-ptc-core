export class KeyedMutex {
  constructor() {
    this.tails = new Map();
  }

  run(key, task) {
    const previous = this.tails.get(key) || Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.catch(() => {});
    this.tails.set(key, tail);
    return result.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
  }
}
