const generationBrand: unique symbol = Symbol("LiveReadGenerationId");

export type LiveReadGenerationId = number & { readonly [generationBrand]: true };

export interface GenerationBoundValue<T> {
  readonly generation: LiveReadGenerationId;
  readonly value: T;
}

export interface LiveReadOptions {
  bypassGenerationCache?: boolean;
}

type LiveReadCacheEntry =
  | { readonly generation: LiveReadGenerationId; readonly ok: true; readonly value: unknown }
  | { readonly generation: LiveReadGenerationId; readonly ok: false; readonly error: unknown };

/**
 * One coherent set of live GitHub reads for one apply item. Mutations advance
 * the generation and make values bound to the preceding generation unusable.
 */
export class LiveReadGeneration {
  #generation = 1 as LiveReadGenerationId;
  readonly #cache = new Map<string, LiveReadCacheEntry>();

  get id(): LiveReadGenerationId {
    return this.#generation;
  }

  read<T>(key: string, read: () => T, options: LiveReadOptions = {}): T {
    if (options.bypassGenerationCache) return read();
    const generation = this.#generation;
    const cached = this.#cache.get(key);
    if (cached) {
      if (cached.generation !== generation) {
        throw new Error(
          `live read cache entry ${key} belongs to generation ${cached.generation}, current generation is ${generation}`,
        );
      }
      if (cached.ok) return cached.value as T;
      throw cached.error;
    }
    try {
      const value = read();
      this.#cache.set(key, { generation, ok: true, value });
      return value;
    } catch (error) {
      this.#cache.set(key, { generation, ok: false, error });
      throw error;
    }
  }

  bind<T>(value: T): GenerationBoundValue<T> {
    return { generation: this.#generation, value };
  }

  value<T>(bound: GenerationBoundValue<T>): T {
    if (bound.generation !== this.#generation) {
      throw new Error(
        `live value belongs to generation ${bound.generation}, current generation is ${this.#generation}`,
      );
    }
    return bound.value;
  }

  invalidate(): void {
    this.#cache.clear();
    this.#generation = (this.#generation + 1) as LiveReadGenerationId;
  }
}

export function generationReadKey(kind: string, args: readonly unknown[]): string {
  return JSON.stringify([kind, ...args]);
}
