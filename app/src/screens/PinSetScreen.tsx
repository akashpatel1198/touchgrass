// First-time PIN setup: enter twice, both must match. Once stored, the app
// kicks back to Root, which sees pinIsSet=true and routes to Projects (we set
// `unlocked` immediately so the user isn't asked to re-enter the PIN they
// just typed).

import { useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { PinDots, type PinDotsHandle } from "../components/PinDots";
import { PinKeypad } from "../components/PinKeypad";
import { PIN_LENGTH, setPin } from "../auth/pin";
import { colors, fontSizes, spacing } from "../theme";

interface Props {
  onPinSet: () => void;
}

type Phase = "enter" | "confirm";

export function PinSetScreen({ onPinSet }: Props) {
  const [phase, setPhase] = useState<Phase>("enter");
  const [first, setFirst] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dotsRef = useRef<PinDotsHandle>(null);

  const current = phase === "enter" ? first : confirm;
  const setCurrent = phase === "enter" ? setFirst : setConfirm;

  const onDigit = async (digit: string) => {
    if (busy || current.length >= PIN_LENGTH) return;
    setError(null);
    const next = current + digit;
    setCurrent(next);
    if (next.length === PIN_LENGTH) {
      if (phase === "enter") {
        // Brief pause so the final dot animates in before screen swap.
        setTimeout(() => setPhase("confirm"), 150);
      } else {
        if (next === first) {
          setBusy(true);
          await setPin(next);
          setBusy(false);
          onPinSet();
        } else {
          dotsRef.current?.shake();
          setError("PINs didn't match. Start over.");
          setTimeout(() => {
            setFirst("");
            setConfirm("");
            setPhase("enter");
          }, 500);
        }
      }
    }
  };

  const onDelete = () => {
    if (busy) return;
    setError(null);
    setCurrent(current.slice(0, -1));
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Set a PIN</Text>
          <Text style={styles.subtitle}>
            {phase === "enter"
              ? `Pick a ${PIN_LENGTH}-digit PIN. You'll use this every time you open the app or come back from background.`
              : "Enter it again to confirm."}
          </Text>
        </View>

        <View style={styles.dots}>
          <PinDots ref={dotsRef} filled={current.length} total={PIN_LENGTH} />
          {error ? <Text style={styles.error}>{error}</Text> : <View style={styles.errorPlaceholder} />}
        </View>

        <PinKeypad onDigit={onDigit} onDelete={onDelete} disabled={busy} />
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
  dots: { gap: spacing.md, alignItems: "center" },
  error: { color: colors.danger, fontSize: fontSizes.sm },
  errorPlaceholder: { height: fontSizes.sm + 4 },
});
