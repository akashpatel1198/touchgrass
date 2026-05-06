// PIN entry on launch / after re-lock. Wrong PIN shakes; after 3 wrongs,
// exponential backoff blocks input until a window passes.
//
// "Forgot PIN" wipes both the PIN record and the rest of the config (daemon
// URL, bearer, ntfy topic). User starts over from the Settings screen — no
// recovery path. This is by design: the threat model assumes whoever forgot
// the PIN is the legitimate owner re-pairing fresh.

import { useEffect, useRef, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { PIN_LENGTH, clearPin, getBackoff, verifyPin } from "../auth/pin";
import { PinDots, type PinDotsHandle } from "../components/PinDots";
import { PinKeypad } from "../components/PinKeypad";
import { clearConfig } from "../storage/config";
import { colors, fontSizes, spacing } from "../theme";

interface Props {
  onUnlock: () => void;
  onForgotComplete: () => void;
}

export function PinEntryScreen({ onUnlock, onForgotComplete }: Props) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [backoffMs, setBackoffMs] = useState(0);
  const dotsRef = useRef<PinDotsHandle>(null);

  // Poll backoff once per second so the disabled state lifts when the window expires.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const { remainingMs } = await getBackoff();
      if (!cancelled) setBackoffMs(remainingMs);
    };
    void tick();
    const interval = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const locked = backoffMs > 0;

  const onDigit = async (digit: string) => {
    if (busy || locked || pin.length >= PIN_LENGTH) return;
    const next = pin + digit;
    setPin(next);
    if (next.length === PIN_LENGTH) {
      setBusy(true);
      const ok = await verifyPin(next);
      setBusy(false);
      if (ok) {
        onUnlock();
      } else {
        dotsRef.current?.shake();
        const { remainingMs } = await getBackoff();
        setBackoffMs(remainingMs);
        setTimeout(() => setPin(""), 350);
      }
    }
  };

  const onDelete = () => {
    if (busy || locked) return;
    setPin(pin.slice(0, -1));
  };

  const onForgot = () => {
    Alert.alert(
      "Forgot your PIN?",
      "This wipes the saved daemon URL, bearer token, and PIN. You'll need to re-enter them. Continue?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Wipe",
          style: "destructive",
          onPress: async () => {
            await Promise.all([clearPin(), clearConfig()]);
            onForgotComplete();
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Enter PIN</Text>
          <Text style={styles.subtitle}>
            {locked
              ? `Too many wrong tries. Try again in ${Math.ceil(backoffMs / 1000)}s.`
              : "Tap your PIN to unlock."}
          </Text>
        </View>

        <View style={styles.dots}>
          <PinDots ref={dotsRef} filled={pin.length} total={PIN_LENGTH} />
        </View>

        <PinKeypad onDigit={onDigit} onDelete={onDelete} onForgot={onForgot} disabled={busy || locked} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, justifyContent: "space-between", paddingVertical: spacing.xl },
  header: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  title: { color: colors.text, fontSize: fontSizes.display, fontWeight: "600" },
  subtitle: { color: colors.textMuted, fontSize: fontSizes.body, lineHeight: 22 },
  dots: { alignItems: "center" },
});
