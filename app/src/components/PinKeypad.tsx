// 3x4 number pad. Center bottom is empty; left bottom is "Forgot" (optional);
// right bottom is delete (backspace). Designed for thumb-friendly tap targets.

import { Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { colors, fontSizes, radii, spacing } from "../theme";

interface Props {
  onDigit: (digit: string) => void;
  onDelete: () => void;
  onForgot?: () => void;
  disabled?: boolean;
}

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

export function PinKeypad({ onDigit, onDelete, onForgot, disabled }: Props) {
  return (
    <View style={styles.pad}>
      <View style={styles.row}>
        {DIGITS.slice(0, 3).map((d) => (
          <KeypadButton key={d} label={d} onPress={() => onDigit(d)} disabled={disabled} />
        ))}
      </View>
      <View style={styles.row}>
        {DIGITS.slice(3, 6).map((d) => (
          <KeypadButton key={d} label={d} onPress={() => onDigit(d)} disabled={disabled} />
        ))}
      </View>
      <View style={styles.row}>
        {DIGITS.slice(6, 9).map((d) => (
          <KeypadButton key={d} label={d} onPress={() => onDigit(d)} disabled={disabled} />
        ))}
      </View>
      <View style={styles.row}>
        <KeypadButton
          label={onForgot ? "Forgot" : ""}
          onPress={onForgot ?? (() => {})}
          disabled={disabled || !onForgot}
          variant="text"
        />
        <KeypadButton label="0" onPress={() => onDigit("0")} disabled={disabled} />
        <KeypadButton label="⌫" onPress={onDelete} disabled={disabled} variant="text" />
      </View>
    </View>
  );
}

interface ButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: "digit" | "text";
}

function KeypadButton({ label, onPress, disabled, variant = "digit" }: ButtonProps) {
  if (!label) return <View style={styles.button} />;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        variant === "digit" && styles.buttonDigit,
        pressed && !disabled && styles.buttonPressed,
        disabled && styles.buttonDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
      android_ripple={{ color: colors.surfaceElevated, borderless: false }}
    >
      <Text
        style={[
          variant === "digit" ? styles.buttonText : styles.buttonTextSmall,
          disabled && styles.buttonTextDisabled,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pad: { gap: spacing.md, paddingHorizontal: spacing.md },
  row: { flexDirection: "row", justifyContent: "space-between", gap: spacing.md },
  button: {
    flex: 1,
    aspectRatio: 1.4,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.lg,
  },
  buttonDigit: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  buttonPressed: { opacity: 0.6 },
  buttonDisabled: { opacity: 0.3 },
  buttonText: {
    color: colors.text,
    fontSize: fontSizes.title,
    fontWeight: "500",
    fontVariant: Platform.OS === "ios" ? ["tabular-nums"] : undefined,
  },
  buttonTextSmall: { color: colors.textMuted, fontSize: fontSizes.body },
  buttonTextDisabled: { color: colors.textDim },
});
