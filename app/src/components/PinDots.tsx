// Visual representation of how many digits have been entered. Shake animation
// for the wrong-PIN feedback.

import { forwardRef, useImperativeHandle, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";

import { colors, spacing } from "../theme";

export interface PinDotsHandle {
  shake: () => void;
}

interface Props {
  filled: number;
  total: number;
}

export const PinDots = forwardRef<PinDotsHandle, Props>(function PinDots(
  { filled, total },
  ref,
) {
  const offset = useRef(new Animated.Value(0)).current;

  useImperativeHandle(ref, () => ({
    shake: () => {
      Animated.sequence([
        Animated.timing(offset, { toValue: 12, duration: 60, useNativeDriver: true }),
        Animated.timing(offset, { toValue: -12, duration: 60, useNativeDriver: true }),
        Animated.timing(offset, { toValue: 8, duration: 60, useNativeDriver: true }),
        Animated.timing(offset, { toValue: -8, duration: 60, useNativeDriver: true }),
        Animated.timing(offset, { toValue: 0, duration: 60, useNativeDriver: true }),
      ]).start();
    },
  }));

  return (
    <Animated.View style={[styles.row, { transform: [{ translateX: offset }] }]}>
      {Array.from({ length: total }, (_, i) => (
        <View
          key={i}
          style={[styles.dot, i < filled ? styles.dotFilled : styles.dotEmpty]}
        />
      ))}
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: spacing.md, justifyContent: "center" },
  dot: { width: 16, height: 16, borderRadius: 8 },
  dotFilled: { backgroundColor: colors.accent },
  dotEmpty: { backgroundColor: "transparent", borderWidth: 2, borderColor: colors.border },
});
