// Bottom-sheet modal for creating a new session. Goal text input + Start button.
// Goal is optional (the daemon accepts null).

import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { colors, fontSizes, radii, spacing } from "../theme";

interface Props {
  visible: boolean;
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (goal: string | null) => void;
}

export function NewSessionSheet({ visible, busy, onCancel, onSubmit }: Props) {
  const [goal, setGoal] = useState("");
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) {
      // Reset on every open so a previous goal doesn't linger.
      setGoal("");
      // Slight delay so the modal is fully on-screen before focus.
      const id = setTimeout(() => inputRef.current?.focus(), 200);
      return () => clearTimeout(id);
    }
  }, [visible]);

  const submit = () => {
    if (busy) return;
    const trimmed = goal.trim();
    onSubmit(trimmed.length > 0 ? trimmed : null);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onCancel}
    >
      <Pressable style={styles.backdrop} onPress={busy ? undefined : onCancel}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.kb}
        >
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.handle} />
            <Text style={styles.title}>New session</Text>
            <Text style={styles.subtitle}>
              What&apos;s the goal? (Optional — leave blank for an open-ended chat.)
            </Text>
            <TextInput
              ref={inputRef}
              value={goal}
              onChangeText={setGoal}
              placeholder="e.g. fix the auth redirect bug"
              placeholderTextColor={colors.textDim}
              style={styles.input}
              multiline
              maxLength={500}
              editable={!busy}
              returnKeyType="go"
              onSubmitEditing={submit}
            />
            <View style={styles.row}>
              <Pressable
                onPress={onCancel}
                disabled={busy}
                style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={submit}
                disabled={busy}
                style={({ pressed }) => [
                  styles.start,
                  pressed && styles.pressed,
                  busy && styles.disabled,
                ]}
              >
                {busy ? (
                  <ActivityIndicator color={colors.bg} />
                ) : (
                  <Text style={styles.startText}>Start</Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  kb: { width: "100%" },
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
  title: { color: colors.text, fontSize: fontSizes.title, fontWeight: "600" },
  subtitle: { color: colors.textMuted, fontSize: fontSizes.sm, lineHeight: 20 },
  input: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    color: colors.text,
    fontSize: fontSizes.body,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    minHeight: 96,
    textAlignVertical: "top",
  },
  row: { flexDirection: "row", gap: spacing.md },
  cancel: {
    flex: 1,
    paddingVertical: spacing.md,
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelText: { color: colors.textMuted, fontSize: fontSizes.body },
  start: {
    flex: 1,
    paddingVertical: spacing.md,
    alignItems: "center",
    borderRadius: radii.md,
    backgroundColor: colors.accent,
  },
  startText: { color: colors.bg, fontSize: fontSizes.body, fontWeight: "600" },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.6 },
});
