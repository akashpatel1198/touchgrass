// Lock-state context. Owns "is the app currently unlocked?" and re-locks on
// foreground if the app has been backgrounded for more than the inactivity
// threshold. The Root navigator subscribes to this to decide which screen to
// render.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, type AppStateStatus } from "react-native";

const INACTIVITY_THRESHOLD_MS = 60_000;

interface LockState {
  unlocked: boolean;
  unlock: () => void;
  lock: () => void;
}

const LockContext = createContext<LockState | null>(null);

export function LockProvider({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState(false);
  const backgroundedAtRef = useRef<number | null>(null);
  const previousStateRef = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      const previous = previousStateRef.current;
      if (next === "background" || next === "inactive") {
        if (previous === "active") {
          backgroundedAtRef.current = Date.now();
        }
      } else if (next === "active") {
        if (backgroundedAtRef.current !== null) {
          const awayMs = Date.now() - backgroundedAtRef.current;
          backgroundedAtRef.current = null;
          if (awayMs > INACTIVITY_THRESHOLD_MS) {
            setUnlocked(false);
          }
        }
      }
      previousStateRef.current = next;
    });
    return () => subscription.remove();
  }, []);

  const unlock = useCallback(() => setUnlocked(true), []);
  const lock = useCallback(() => setUnlocked(false), []);

  const value = useMemo(() => ({ unlocked, unlock, lock }), [unlocked, unlock, lock]);
  return <LockContext.Provider value={value}>{children}</LockContext.Provider>;
}

export function useLockState(): LockState {
  const ctx = useContext(LockContext);
  if (!ctx) throw new Error("useLockState must be used inside LockProvider");
  return ctx;
}
