// AI summary for a single file, with an optional "Show full contents" path.
// The phone is not an editor — raw contents are plain monospace, no syntax
// highlighting. The summary fetch can be slow (model latency on first miss);
// the cached state is much faster.

import {
  useNavigation,
  useRoute,
  type RouteProp,
} from "@react-navigation/native";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ApiError, api } from "../api/client";
import {
  isComplete,
  loadConfig,
  type ClientConfig,
} from "../storage/config";
import { colors, fontSizes, radii, spacing } from "../theme";
import type { RootStackParamList } from "../navigation/types";

type Route = RouteProp<RootStackParamList, "FileSummary">;

type SummaryState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; summary: string; cached: boolean }
  | { kind: "error"; message: string };

type ContentsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; contents: string; size: number }
  | { kind: "error"; message: string };

export function FileSummaryScreen() {
  const route = useRoute<Route>();
  const navigation = useNavigation();
  const { projectName, path } = route.params;

  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [summary, setSummary] = useState<SummaryState>({ kind: "idle" });
  const [contents, setContents] = useState<ContentsState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const partial = await loadConfig();
      if (cancelled || !isComplete(partial)) return;
      setConfig(partial);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectName, path]);

  const loadSummary = async () => {
    if (!config || summary.kind === "loading") return;
    setSummary({ kind: "loading" });
    try {
      const res = await api.getFileSummary(config, projectName, path);
      setSummary({ kind: "ok", summary: res.summary, cached: res.cached });
    } catch (exc) {
      setSummary({ kind: "error", message: messageFor(exc) });
    }
  };

  const loadContents = async () => {
    if (!config || contents.kind === "loading") return;
    setContents({ kind: "loading" });
    try {
      const res = await api.getFileContents(config, projectName, path);
      setContents({ kind: "ok", contents: res.contents, size: res.size });
    } catch (exc) {
      setContents({ kind: "error", message: messageFor(exc) });
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} style={styles.back}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {path}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.eyebrow}>SUMMARY</Text>
        {summary.kind === "idle" && (
          <Pressable style={styles.showBtn} onPress={loadSummary}>
            <Text style={styles.showBtnText}>Generate summary</Text>
          </Pressable>
        )}
        {summary.kind === "loading" && (
          <View style={styles.summaryLoading}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.loadingText}>Asking Claude…</Text>
          </View>
        )}
        {summary.kind === "error" && (
          <>
            <Text style={styles.error}>{summary.message}</Text>
            <Pressable style={styles.showBtn} onPress={loadSummary}>
              <Text style={styles.showBtnText}>Try again</Text>
            </Pressable>
          </>
        )}
        {summary.kind === "ok" && (
          <>
            <Text style={styles.summary}>{summary.summary}</Text>
            <Text style={styles.cachedHint}>
              {summary.cached ? "from cache" : "fresh"}
            </Text>
            <Pressable style={styles.regenBtn} onPress={loadSummary}>
              <Text style={styles.regenBtnText}>Regenerate</Text>
            </Pressable>
          </>
        )}

        <View style={styles.divider} />

        {contents.kind === "idle" && (
          <Pressable style={styles.showBtn} onPress={loadContents}>
            <Text style={styles.showBtnText}>Show full contents</Text>
          </Pressable>
        )}
        {contents.kind === "loading" && (
          <View style={styles.summaryLoading}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.loadingText}>Fetching contents…</Text>
          </View>
        )}
        {contents.kind === "error" && (
          <Text style={styles.error}>{contents.message}</Text>
        )}
        {contents.kind === "ok" && (
          <>
            <Text style={styles.eyebrow}>
              CONTENTS · {contents.size.toLocaleString()} bytes
            </Text>
            <View style={styles.codeWrap}>
              <Text style={styles.code}>{contents.contents}</Text>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function messageFor(exc: unknown): string {
  if (exc instanceof ApiError) {
    if (exc.kind === "network")
      return "Can't reach the daemon. Check Tailscale and `make dev`.";
    if (exc.kind === "unauthorized") return "Bearer token rejected.";
    if (exc.kind === "client") return exc.message;
    return exc.message;
  }
  return "Unexpected error.";
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.md,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { paddingVertical: spacing.sm, paddingRight: spacing.sm },
  backText: { color: colors.textMuted, fontSize: fontSizes.body },
  title: {
    flex: 1,
    color: colors.text,
    fontSize: fontSizes.lg,
    fontWeight: "600",
    fontFamily: "monospace",
  },
  body: { padding: spacing.lg, gap: spacing.md },
  eyebrow: {
    color: colors.textDim,
    fontSize: fontSizes.xs,
    fontWeight: "700",
    letterSpacing: 1,
  },
  summary: {
    color: colors.text,
    fontSize: fontSizes.body,
    lineHeight: 24,
  },
  cachedHint: {
    color: colors.textDim,
    fontSize: fontSizes.xs,
    fontStyle: "italic",
  },
  summaryLoading: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  loadingText: { color: colors.textMuted, fontSize: fontSizes.sm },
  error: { color: colors.danger, fontSize: fontSizes.body },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
  },
  showBtn: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  showBtnText: { color: colors.text, fontSize: fontSizes.body, fontWeight: "600" },
  regenBtn: {
    alignSelf: "flex-start",
    paddingVertical: spacing.sm,
  },
  regenBtnText: { color: colors.accent, fontSize: fontSizes.sm, fontWeight: "600" },
  codeWrap: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  code: {
    color: colors.text,
    fontFamily: "monospace",
    fontSize: fontSizes.xs,
    lineHeight: 18,
  },
});
