/**
 * Fixture file for symbol-tools.test.ts.
 * Contains a variety of symbol kinds for test assertions.
 */

export interface Greeter {
  greet(name: string): string;
}

export type StringOrNumber = string | number;

export const MAX_RETRIES = 3;

export class Calculator {
  private value: number;

  constructor(initial = 0) {
    this.value = initial;
  }

  add(n: number): Calculator {
    this.value += n;
    return this;
  }

  subtract(n: number): Calculator {
    this.value -= n;
    return this;
  }

  result(): number {
    return this.value;
  }
}

export function greetUser(name: string): string {
  return `Hello, ${name}!`;
}

export async function fetchData(url: string): Promise<string> {
  return `data from ${url}`;
}

export const formatDate = (d: Date): string => d.toISOString().split('T')[0];
