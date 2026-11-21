declare module "bun" {
  export interface BunPluginBuild {
    onResolve(
      options: { filter: RegExp; namespace?: string },
      callback: (args: { path: string; importer: string; namespace: string }) =>
        | { path: string; namespace?: string }
        | null
        | undefined
    ): void;
    onLoad(
      options: { filter: RegExp; namespace?: string },
      callback: (args: { path: string; namespace: string }) =>
        | { contents: string; loader?: "js" | "ts" | "tsx" | "jsx" | "json" | "text" }
        | null
        | undefined
    ): void;
  }
  export interface BunPlugin {
    name: string;
    setup(build: BunPluginBuild): void;
  }
  export function plugin(p: BunPlugin): void;
}

declare module "bun:test" {
  export const mock: { module(path: string, factory: () => Record<string, unknown>): void };
  export function describe(label: string, fn: () => void): void;
  export function test(label: string, fn: () => void | Promise<void>): void;
  export function it(label: string, fn: () => void | Promise<void>): void;
  export interface ExpectMatchers {
    toBe(expected: any): void;
    toEqual(expected: any): void;
    toBeCloseTo(expected: number, numDigits?: number): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeNull(): void;
    toBeDefined(): void;
    toContain(item: any): void;
    not: ExpectMatchers;
  }
  export function expect(actual: any): ExpectMatchers;
}
