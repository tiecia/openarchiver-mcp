export interface OpenArchiverConfig {
  /** Effective API base, e.g. https://host/api/v1 (no trailing slash). */
  apiBase: string;
  apiKey: string;
  /** Request timeout in milliseconds. */
  timeoutMs: number;
  /** Test-only opt-in; never permits remote HTTP. */
  allowHttpLoopback?: boolean;
}

/**
 * Normalize a configured base URL to the effective API base.
 * - strips trailing slashes
 * - appends `/api/v1` unless an `/api/v<n>` suffix is already present
 */
export function normalizeApiBase(baseUrl: string, allowHttpLoopback = false): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error("OPENARCHIVER_BASE_URL is empty");
  const invalid = () => new Error("OPENARCHIVER_BASE_URL must be a safe HTTPS URL without credentials, query, or fragment.");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw invalid();
  }
  const match = /^https?:\/\/([^/?#]+)([^?#]*)$/.exec(trimmed);
  if (!match || /[\s\\]/.test(trimmed) || /[@]/.test(match[1]) || match[1].endsWith(":")) {
    throw invalid();
  }
  const path = match[2].replace(/\/+$/, "");
  const localHttp = allowHttpLoopback && url.protocol === "http:" &&
    /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(match[1]);
  if ((!localHttp && url.protocol !== "https:") || url.username || url.password || url.search || url.hash ||
      path.split("/").slice(1).some(segment => !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._~-]+$/.test(segment))) {
    throw invalid();
  }
  url.pathname = /\/api\/v\d+$/.test(path) ? path : `${path}/api/v1`;
  return url.href;
}

/**
 * Load and validate configuration from the environment.
 * Throws with an actionable message when something is missing.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): OpenArchiverConfig {
  const baseUrl = env.OPENARCHIVER_BASE_URL?.trim();
  const apiKey = env.OPENARCHIVER_API_KEY?.trim();

  if (!baseUrl) {
    throw new Error(
      "OPENARCHIVER_BASE_URL is not set. Set it to your OpenArchiver instance URL, e.g. https://openarchiver.example.com",
    );
  }
  if (!apiKey) {
    throw new Error(
      "OPENARCHIVER_API_KEY is not set. Create an API key in OpenArchiver with search:archive and read:archive permissions.",
    );
  }

  const timeoutMs = Number.parseInt(env.OPENARCHIVER_TIMEOUT_MS ?? "", 10);

  return {
    apiBase: normalizeApiBase(baseUrl, env.OPENARCHIVER_ALLOW_HTTP_LOOPBACK === "true"),
    apiKey,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000,
    ...(env.OPENARCHIVER_ALLOW_HTTP_LOOPBACK === "true" ? { allowHttpLoopback: true } : {}),
  };
}
