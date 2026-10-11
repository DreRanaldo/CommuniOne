// Safe application logging.
//
// Services log through a Logger the application provides (console, Sentry,
// a log drain...). Every field passes through redact() first, so passwords,
// tokens, invitation secrets, payment data and contact details never reach a
// log sink, even if a caller passes them by mistake.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
}

/** Discards everything (the default: services never log unless asked to). */
export const silentLogger: Logger = { log() {} };

/** Structured JSON lines on the console, already redacted. */
export const consoleLogger: Logger = {
  log(level, event, fields = {}) {
    const line = JSON.stringify({ level, event, ...(redact(fields) as LogFields), at: new Date().toISOString() });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  },
};

const SENSITIVE_KEY_PART = /password|passwd|secret|token|authorization|cookie|session|jwt|bearer|apikey|api_key|privatekey|private_key|credential|phone|email/;
const SENSITIVE_KEY_WORD = new Set(['pass', 'otp', 'pin', 'card', 'cvv', 'cvc', 'iban', 'ssn']);

const isSensitiveKey = (key: string): boolean => {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEY_PART.test(lower)) return true;
  // Whole words only, so "shipping" or "opinion" are not treated as "pin".
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
  return words.some((word) => SENSITIVE_KEY_WORD.has(word));
};

const SENSITIVE_VALUE: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, // JWTs (access tokens, API keys)
  /\bci_[0-9a-f]{64}\b/g, // invitation tokens
  /\bsb_(secret|publishable)_[A-Za-z0-9_-]+/g, // Supabase keys
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:\d[ -]?){13,19}\b/g, // card-number-like digit runs
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // email addresses
];

const REDACTED = '[redacted]';

const redactString = (value: string): string =>
  SENSITIVE_VALUE.reduce((s, pattern) => s.replace(pattern, REDACTED), value).slice(0, 2000);

/** Deep-copies a value with sensitive keys and token-like strings removed. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), code: (value as { code?: unknown }).code };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

/** Wraps a logger so every call is redacted. */
export function safeLogger(inner: Logger): Logger {
  return {
    log(level, event, fields) {
      try {
        inner.log(level, event, fields ? (redact(fields) as LogFields) : undefined);
      } catch {
        // Logging must never break a request.
      }
    },
  };
}
