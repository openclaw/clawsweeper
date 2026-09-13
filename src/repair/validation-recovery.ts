export class ValidationRecoveryRequiredError extends Error {
  readonly recoveryPaths = new Set<string>();
  private readonly detail: string;

  constructor(message: string, cause: unknown, paths: readonly string[] = []) {
    super(message, { cause });
    this.name = "ValidationRecoveryRequiredError";
    this.detail = message;
    this.retain(paths);
  }

  retain(paths: readonly string[]) {
    for (const path of paths) this.recoveryPaths.add(path);
    this.message = `${this.detail}. Validation recovery required: stop and verify all target processes have exited before inspecting or restoring retained state; do not retry this checkout.${
      this.recoveryPaths.size ? ` Retained paths: ${[...this.recoveryPaths].join(", ")}` : ""
    }`;
    return this;
  }
}

export function validationRecoveryRequired(error: unknown): ValidationRecoveryRequiredError | null {
  const visited = new Set<unknown>();
  while (error instanceof Error && !visited.has(error)) {
    if (error instanceof ValidationRecoveryRequiredError) return error;
    visited.add(error);
    error = error.cause;
  }
  return null;
}

export type DisposableValidationState = {
  restore: () => void;
  recoveryPaths: string[];
};

export function withDisposableValidationState<T>(
  prepare: (save: (state: DisposableValidationState) => void) => void,
  execute: () => T,
  command?: string,
): T {
  const states: DisposableValidationState[] = [];
  let result: T;
  let failed = false;
  let executionError: unknown;
  try {
    prepare((state) => states.push(state));
    result = execute();
  } catch (error) {
    failed = true;
    executionError = error;
  }
  const paths = states.flatMap((state) => state.recoveryPaths);
  const recovery = validationRecoveryRequired(executionError);
  if (recovery) {
    recovery.retain(paths);
    throw executionError;
  }
  let restorationError: unknown;
  for (const state of states) {
    try {
      state.restore();
    } catch (error) {
      restorationError ??= error;
    }
  }
  if (restorationError) {
    throw new ValidationRecoveryRequiredError(
      `${command ? `validation command failed (${command}): ` : ""}validation state restoration failed: ${String(restorationError)}${failed ? `; command failure: ${String(executionError)}` : ""}`,
      restorationError,
      paths,
    );
  }
  if (failed) throw executionError;
  return result!;
}
