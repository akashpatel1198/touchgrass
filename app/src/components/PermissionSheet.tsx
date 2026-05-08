// Bottom-sheet modal for approving/denying a permission request. Three actions
// stacked (thumb-friendly), with the tool name large at the top and args
// rendered as monospace JSON below. Args are shown expanded by default — the
// whole point of this modal is "look at what it wants to do, then decide."
//
// Caller owns the open/close lifecycle. We just emit the chosen decision.

import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { DecisionKind, PermissionRequest } from "../api/types";
import { colors, fontSizes, radii, spacing } from "../theme";

interface Props {
  visible: boolean;
  request: PermissionRequest | null;
  busy?: boolean;
  onDecision: (decision: DecisionKind) => void;
  onDismiss: () => void;
}

export function PermissionSheet({
  visible,
  request,
  busy,
  onDecision,
  onDismiss,
}: Props) {
  return (
    <Modal
      visible={visible && request !== null}
      animationType="slide"
      transparent
      onRequestClose={busy ? undefined : onDismiss}
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.eyebrow}>Permission requested</Text>
          <Text style={styles.toolName}>{request?.tool_name ?? ""}</Text>

          <ScrollView
            style={styles.argsScroll}
            contentContainerStyle={styles.argsContent}
          >
            <Text style={styles.args}>{prettyArgs(request?.tool_args)}</Text>
          </ScrollView>

          <View style={styles.buttons}>
            <Action
              label="Allow once"
              tone="primary"
              busy={busy}
              onPress={() => onDecision("allow_once")}
            />
            <Action
              label="Allow for project"
              tone="secondary"
              busy={busy}
              onPress={() => onDecision("allow_project")}
            />
            <Action
              label="Deny"
              tone="danger"
              busy={busy}
              onPress={() => onDecision("deny")}
            />
          </View>

          <Pressable
            onPress={busy ? undefined : onDismiss}
            style={styles.dismiss}
          >
            <Text style={styles.dismissText}>Decide later</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function Action({
  label,
  tone,
  busy,
  onPress,
}: {
  label: string;
  tone: "primary" | "secondary" | "danger";
  busy?: boolean;
  onPress: () => void;
}) {
  const toneStyle =
    tone === "primary"
      ? styles.primary
      : tone === "danger"
      ? styles.danger
      : styles.secondary;
  const textStyle =
    tone === "secondary" ? styles.btnTextMuted : styles.btnText;
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      style={({ pressed }) => [
        styles.btn,
        toneStyle,
        pressed && styles.pressed,
        busy && styles.disabled,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={tone === "secondary" ? colors.text : colors.bg} />
      ) : (
        <Text style={textStyle}>{label}</Text>
      )}
    </Pressable>
  );
}

function prettyArgs(raw: string | undefined): string {
  if (!raw) return "(no args)";
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.65)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  handle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: spacing.sm,
  },
  eyebrow: {
    color: colors.warning,
    fontSize: fontSizes.xs,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  toolName: {
    color: colors.text,
    fontSize: fontSizes.display,
    fontWeight: "700",
  },
  argsScroll: {
    maxHeight: 220,
    backgroundColor: colors.bg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  argsContent: { padding: spacing.md },
  args: {
    color: colors.text,
    fontFamily: "monospace",
    fontSize: fontSizes.xs,
    lineHeight: 18,
  },
  buttons: { gap: spacing.sm, marginTop: spacing.sm },
  btn: {
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    alignItems: "center",
  },
  primary: { backgroundColor: colors.accent },
  secondary: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: colors.border,
  },
  danger: { backgroundColor: colors.danger },
  btnText: { color: colors.bg, fontSize: fontSizes.body, fontWeight: "600" },
  btnTextMuted: {
    color: colors.text,
    fontSize: fontSizes.body,
    fontWeight: "600",
  },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.6 },
  dismiss: { alignItems: "center", paddingTop: spacing.sm },
  dismissText: { color: colors.textDim, fontSize: fontSizes.sm },
});
