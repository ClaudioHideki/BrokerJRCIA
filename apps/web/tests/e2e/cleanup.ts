export interface E2eCleanupStep {
  name: string;
  run(): Promise<void>;
}

export async function runE2eCleanupSteps(steps: E2eCleanupStep[]): Promise<void> {
  const failures: Error[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch {
      failures.push(new Error(`E2E cleanup failed: ${step.name}`));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more isolated E2E resources were not cleaned');
  }
}
