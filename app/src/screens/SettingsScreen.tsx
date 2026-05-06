// First-run config screen + reachable from elsewhere later. Collects daemon URL,
// bearer token, ntfy topic; on save, fires GET /health to confirm reachability
// before persisting.

import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ApiError, api } from "../api/client";
import { saveConfig } from "../storage/config";
import { colors, fontSizes, radii, spacing } from "../theme";

interface Props {
  initial?: { baseUrl: string | null; bearerToken: string | null; ntfyTopic: string | null };
  onSaved: () => void;
}

export function SettingsScreen({ initial, onSaved }: Props) {
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "http://");
  const [bearerToken, setBearerToken] = useState(initial?.bearerToken ?? "");
  const [ntfyTopic, setNtfyTopic] = useState(initial?.ntfyTopic ?? "");
  const [saving, setSaving] = useState(false);

  const canSubmit = baseUrl.startsWith("http") && bearerToken.length >= 16 && ntfyTopic.length > 0;

  const onSave = async () => {
    if (saving) return;
    const config = { baseUrl: baseUrl.trim(), bearerToken: bearerToken.trim(), ntfyTopic: ntfyTopic.trim() };
    setSaving(true);
    try {
      await api.health(config);
    } catch (exc) {
      const msg =
        exc instanceof ApiError
          ? exc.kind === "network"
            ? `Couldn't reach ${config.baseUrl}. Check Tailscale and that \`make dev\` is running.`
            : `Daemon responded with an error: ${exc.message}`
          : "Unexpected error reaching the daemon.";
      Alert.alert("Connection failed", msg);
      setSaving(false);
      return;
    }
    await saveConfig(config);
    setSaving(false);
    onSaved();
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Connect</Text>
          <Text style={styles.subtitle}>
            Pair this app with your laptop daemon. Same bearer + ntfy topic that&apos;s in your{" "}
            <Text style={styles.code}>~/.touchgrass/config.yaml</Text>.
          </Text>

          <Field label="Daemon URL" hint="Your laptop's tailnet IP, e.g. http://100.80.23.61:8765">
            <TextInput
              value={baseUrl}
              onChangeText={setBaseUrl}
              placeholder="http://100.x.x.x:8765"
              placeholderTextColor={colors.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={styles.input}
            />
          </Field>

          <Field label="Bearer token" hint="≥16 chars, must match the daemon's config">
            <TextInput
              value={bearerToken}
              onChangeText={setBearerToken}
              placeholder="paste from config.yaml"
              placeholderTextColor={colors.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              style={styles.input}
            />
          </Field>

          <Field label="ntfy topic" hint="The push channel — e.g. touchgrass-ABC123">
            <TextInput
              value={ntfyTopic}
              onChangeText={setNtfyTopic}
              placeholder="touchgrass-..."
              placeholderTextColor={colors.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
          </Field>

          <TouchableOpacity
            style={[styles.button, !canSubmit && styles.buttonDisabled]}
            onPress={onSave}
            disabled={!canSubmit || saving}
          >
            {saving ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <Text style={styles.buttonText}>Test &amp; save</Text>
            )}
          </TouchableOpacity>

          <Text style={styles.footer}>
            Tapping save fires <Text style={styles.code}>GET /health</Text> against the daemon.
            We only persist if it answers.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
      <Text style={styles.fieldHint}>{hint}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.lg },
  title: { color: colors.text, fontSize: fontSizes.display, fontWeight: "600" },
  subtitle: { color: colors.textMuted, fontSize: fontSizes.body, lineHeight: 22 },
  field: { gap: spacing.xs },
  fieldLabel: { color: colors.text, fontSize: fontSizes.sm, fontWeight: "500" },
  fieldHint: { color: colors.textDim, fontSize: fontSizes.xs },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    color: colors.text,
    fontSize: fontSizes.body,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: "center",
    marginTop: spacing.sm,
  },
  buttonDisabled: { backgroundColor: colors.accentMuted, opacity: 0.6 },
  buttonText: { color: colors.bg, fontSize: fontSizes.body, fontWeight: "600" },
  footer: { color: colors.textDim, fontSize: fontSizes.xs, textAlign: "center" },
  code: { fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }) },
});
