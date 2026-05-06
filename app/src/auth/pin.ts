// PIN setup, verification, and exponential-backoff state.
//
// The threat model here is "someone who picks up your unlocked phone and pokes
// the touchgrass app." Tailscale already gates network reach; the PIN gates
// the UI. Anyone with full device access can extract `expo-secure-store` keys
// (Android Keystore, iOS Keychain) — that's a different threat model and not
// what this protects against.
//
// Storage layout (in expo-secure-store under `touchgrass_pin`):
//   { version, saltHex, hashHex, length, attempts, lastFailedAtMs }
// `version` lets us upgrade the hashing scheme later without surprising users.
//
// We hash with a single SHA-256 of `salt:pin`. That's enough for our scope:
// the on-screen keypad rate-limits attempts via the backoff schedule below,
// so brute-force throughput is the bottleneck, not the hash work factor.
// Iterated SHA-256 was tried (100k rounds via `digestStringAsync`) and turned
// out to be unusable — each round is an async bridge call, totaling tens of
// seconds on real devices, which manifested as a frozen "set PIN" screen.

import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const STORE_KEY = "touchgrass_pin";
const HASH_VERSION = 1;
const SALT_BYTES = 16;
export const PIN_LENGTH = 6;

export interface PinRecord {
  version: number;
  saltHex: string;
  hashHex: string;
  length: number;
  attempts: number;
  lastFailedAtMs: number | null;
}

interface BackoffState {
  remainingMs: number;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPin(pin: string, saltHex: string): Promise<string> {
  return await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `${saltHex}:${pin}`,
  );
}

async function loadRecord(): Promise<PinRecord | null> {
  const raw = await SecureStore.getItemAsync(STORE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PinRecord;
  } catch {
    return null;
  }
}

async function writeRecord(record: PinRecord): Promise<void> {
  await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(record));
}

export async function hasPin(): Promise<boolean> {
  return (await loadRecord()) !== null;
}

export async function setPin(pin: string): Promise<void> {
  if (pin.length !== PIN_LENGTH || !/^\d+$/.test(pin)) {
    throw new Error(`PIN must be exactly ${PIN_LENGTH} digits`);
  }
  const saltBytes = await Crypto.getRandomBytesAsync(SALT_BYTES);
  const saltHex = bytesToHex(saltBytes);
  const hashHex = await hashPin(pin, saltHex);
  await writeRecord({
    version: HASH_VERSION,
    saltHex,
    hashHex,
    length: PIN_LENGTH,
    attempts: 0,
    lastFailedAtMs: null,
  });
}

export async function clearPin(): Promise<void> {
  await SecureStore.deleteItemAsync(STORE_KEY);
}

export async function verifyPin(pin: string): Promise<boolean> {
  const record = await loadRecord();
  if (!record) return false;
  const candidate = await hashPin(pin, record.saltHex);
  const ok = candidate === record.hashHex;
  if (ok) {
    if (record.attempts !== 0 || record.lastFailedAtMs !== null) {
      await writeRecord({ ...record, attempts: 0, lastFailedAtMs: null });
    }
    return true;
  }
  await writeRecord({
    ...record,
    attempts: record.attempts + 1,
    lastFailedAtMs: Date.now(),
  });
  return false;
}

// Exponential-ish backoff after 3 failed attempts. Resets on success.
//   0–2 wrongs → 0s
//   3 wrongs   → 5s
//   4 wrongs   → 15s
//   5 wrongs   → 60s
//   6+ wrongs  → 300s (5min)
function backoffMsFor(attempts: number): number {
  if (attempts < 3) return 0;
  if (attempts === 3) return 5_000;
  if (attempts === 4) return 15_000;
  if (attempts === 5) return 60_000;
  return 300_000;
}

export async function getBackoff(): Promise<BackoffState> {
  const record = await loadRecord();
  if (!record || record.lastFailedAtMs === null) return { remainingMs: 0 };
  const window = backoffMsFor(record.attempts);
  if (window === 0) return { remainingMs: 0 };
  const elapsed = Date.now() - record.lastFailedAtMs;
  return { remainingMs: Math.max(0, window - elapsed) };
}
