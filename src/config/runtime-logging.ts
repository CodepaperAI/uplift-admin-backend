type RuntimeEnvironment = {
  BACKEND_VERBOSE_LOGGING?: string;
  NODE_ENV?: string;
};

type RuntimeConsole = Pick<Console, "log">;

export function isVerboseBackendLoggingEnabled(
  environment: RuntimeEnvironment = process.env,
): boolean {
  return (
    environment.NODE_ENV === "test" ||
    environment.BACKEND_VERBOSE_LOGGING?.trim().toLowerCase() === "true"
  );
}

/**
 * The backend historically accumulated hundreds of per-request and per-item
 * console.log calls. Disable that informational stream by default so provider
 * payload formatting and stdout writes cannot consume request CPU or disk.
 * Warnings and errors remain untouched. Set BACKEND_VERBOSE_LOGGING=true only
 * for a short, targeted debugging session.
 */
export function configureRuntimeLogging(
  runtimeConsole: RuntimeConsole = console,
  environment: RuntimeEnvironment = process.env,
): void {
  if (isVerboseBackendLoggingEnabled(environment)) return;
  runtimeConsole.log = () => undefined;
}
