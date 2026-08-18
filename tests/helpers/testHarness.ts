export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function equal<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}\nExpected: ${String(expected)}\nReceived: ${String(actual)}`);
  }
}

export function deepEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}\nExpected: ${b}\nReceived: ${a}`);
}

export function throws(fn: () => unknown, message: string): void {
  let didThrow = false;
  try {
    fn();
  } catch {
    didThrow = true;
  }
  if (!didThrow) throw new Error(message);
}

export function runSuite(name: string, cases: Array<[string, () => void]>): void {
  let passed = 0;
  for (const [caseName, fn] of cases) {
    try {
      fn();
      passed += 1;
      console.log(`  PASS ${caseName}`);
    } catch (error) {
      console.error(`  FAIL ${caseName}`);
      throw error;
    }
  }
  console.log(`PASS ${name}: ${passed}/${cases.length}`);
}

export async function runAsyncSuite(name: string, cases: Array<[string, () => Promise<void>]>): Promise<void> {
  let passed = 0;
  for (const [caseName, fn] of cases) {
    try {
      await fn();
      passed += 1;
      console.log(`  PASS ${caseName}`);
    } catch (error) {
      console.error(`  FAIL ${caseName}`);
      throw error;
    }
  }
  console.log(`PASS ${name}: ${passed}/${cases.length}`);
}
