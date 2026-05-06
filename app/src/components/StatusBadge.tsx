// Color-coded session status pill. Mirrors the daemon's SessionStatus literals.

import { StyleSheet, Text, View } from "react-native";

import type { SessionStatus } from "../api/types";
import { colors, fontSizes, radii, spacing } from "../theme";

interface Props {
  status: SessionStatus;
}

const palette: Record<SessionStatus, { bg: string; fg: string; label: string }> = {
  active: { bg: colors.accentMuted, fg: colors.bg, label: "active" },
  waiting_permission: {
    bg: colors.warning,
    fg: colors.bg,
    label: "needs you",
  },
  completed: { bg: colors.surfaceElevated, fg: colors.textMuted, label: "done" },
  failed: { bg: colors.danger, fg: colors.bg, label: "failed" },
};

export function StatusBadge({ status }: Props) {
  const tone = palette[status];
  return (
    <View style={[styles.pill, { backgroundColor: tone.bg }]}>
      <Text style={[styles.text, { color: tone.fg }]}>{tone.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.sm,
    alignSelf: "flex-start",
  },
  text: {
    fontSize: fontSizes.xs,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
});
