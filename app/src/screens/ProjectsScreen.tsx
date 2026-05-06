// Stub for §3. §1 renders a "connected" debug page that fires GET /health and
// shows the result, so first-run verification passes without §2/§3 wiring.

import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ApiError, api } from "../api/client";
import { clearConfig, type ClientConfig } from "../storage/config";
import { colors, fontSizes, radii, spacing } from "../theme";

interface Props {
  config: ClientConfig;
  onResetConfig: () => void;
}

export function ProjectsScreen({ config, onResetConfig }: Props) {
  const [healthState, setHealthState] = useState<
    | { kind: "loading" }
    | { kind: "ok" }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await api.health(config);
        if (!cancelled) setHealthState({ kind: "ok" });
      } catch (exc) {
        if (cancelled) return;
        const message = exc instanceof ApiError ? exc.message : "unknown error";
        setHealthState({ kind: "error", message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config]);

  const onReset = async () => {
    await clearConfig();
    onResetConfig();
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <Text style={styles.title}>Connected</Text>
        <Text style={styles.subtitle}>{config.baseUrl}</Text>

        <View style={styles.statusCard}>
          {healthState.kind === "loading" && <ActivityIndicator color={colors.accent} />}
          {healthState.kind === "ok" && (
            <>
              <Text style={[styles.statusBadge, styles.statusBadgeOk]}>healthy</Text>
              <Text style={styles.statusBody}>Daemon is responding to /health.</Text>
            </>
          )}
          {healthState.kind === "error" && (
            <>
              <Text style={[styles.statusBadge, styles.statusBadgeBad]}>unreachable</Text>
              <Text style={styles.statusBody}>{healthState.message}</Text>
            </>
          )}
        </View>

        <Text style={styles.placeholder}>
          Project picker lands in phase 3 §3.{"\n"}
          For now this is the post-setup landing screen.
        </Text>

        <TouchableOpacity style={styles.resetButton} onPress={onReset}>
          <Text style={styles.resetText}>Reset connection</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, padding: spacing.lg, gap: spacing.lg },
  title: { color: colors.text, fontSize: fontSizes.display, fontWeight: "600" },
  subtitle: { color: colors.textMuted, fontSize: fontSizes.sm },
  statusCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  statusBadge: {
    alignSelf: "flex-start",
    fontSize: fontSizes.xs,
    fontWeight: "600",
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.sm,
    overflow: "hidden",
  },
  statusBadgeOk: { backgroundColor: colors.accentMuted, color: colors.bg },
  statusBadgeBad: { backgroundColor: colors.danger, color: colors.bg },
  statusBody: { color: colors.text, fontSize: fontSizes.body },
  placeholder: {
    color: colors.textDim,
    fontSize: fontSizes.sm,
    lineHeight: 20,
  },
  resetButton: {
    marginTop: "auto",
    alignItems: "center",
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
  },
  resetText: { color: colors.textMuted, fontSize: fontSizes.sm },
});
