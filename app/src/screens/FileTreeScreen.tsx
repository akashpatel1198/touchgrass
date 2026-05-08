// One-directory listing for the active project. Tap a folder → push a fresh
// FileTree screen for that path; tap a file → push FileSummary. Lazy by
// design — we never recurse — so a giant repo doesn't crater the request.

import {
  useNavigation,
  useRoute,
  type RouteProp,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ApiError, api } from "../api/client";
import type { TreeEntry } from "../api/types";
import {
  isComplete,
  loadConfig,
  type ClientConfig,
} from "../storage/config";
import { colors, fontSizes, radii, spacing } from "../theme";
import type { RootStackParamList } from "../navigation/types";

type Route = RouteProp<RootStackParamList, "FileTree">;
type Nav = NativeStackNavigationProp<RootStackParamList, "FileTree">;

type State =
  | { kind: "loading" }
  | { kind: "ok"; entries: TreeEntry[] }
  | { kind: "error"; message: string };

export function FileTreeScreen() {
  const route = useRoute<Route>();
  const navigation = useNavigation<Nav>();
  const { projectName, path } = route.params;

  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const partial = await loadConfig();
      if (cancelled || !isComplete(partial)) return;
      setConfig(partial);
      try {
        const entries = await api.listTree(partial, projectName, path);
        if (!cancelled) setState({ kind: "ok", entries });
      } catch (exc) {
        if (!cancelled) setState({ kind: "error", message: messageFor(exc) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectName, path]);

  const onRefresh = async () => {
    if (!config) return;
    setRefreshing(true);
    try {
      const entries = await api.listTree(config, projectName, path);
      setState({ kind: "ok", entries });
    } catch (exc) {
      setState({ kind: "error", message: messageFor(exc) });
    } finally {
      setRefreshing(false);
    }
  };

  const onTap = (entry: TreeEntry) => {
    const child = path ? `${path}/${entry.name}` : entry.name;
    if (entry.type === "dir") {
      navigation.push("FileTree", { projectName, path: child });
    } else {
      navigation.push("FileSummary", { projectName, path: child });
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} style={styles.back}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {path ? `/${path}` : projectName}
        </Text>
      </View>

      <Body
        state={state}
        refreshing={refreshing}
        onRefresh={onRefresh}
        onTap={onTap}
      />
    </SafeAreaView>
  );
}

interface BodyProps {
  state: State;
  refreshing: boolean;
  onRefresh: () => void;
  onTap: (entry: TreeEntry) => void;
}

function Body({ state, refreshing, onRefresh, onTap }: BodyProps) {
  if (state.kind === "loading") {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  if (state.kind === "error") {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Couldn&apos;t load tree</Text>
        <Text style={styles.errorBody}>{state.message}</Text>
        <Pressable style={styles.retry} onPress={onRefresh}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }
  if (state.entries.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>(empty)</Text>
      </View>
    );
  }
  return (
    <FlatList
      data={state.entries}
      keyExtractor={(e) => `${e.type}:${e.name}`}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.accent}
        />
      }
      renderItem={({ item }) => (
        <Pressable
          onPress={() => onTap(item)}
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          android_ripple={{ color: colors.surfaceElevated }}
        >
          <Text style={styles.glyph}>{item.type === "dir" ? "▸" : "·"}</Text>
          <Text style={styles.rowName} numberOfLines={1}>
            {item.name}
            {item.type === "dir" ? "/" : ""}
          </Text>
          {item.size != null && (
            <Text style={styles.rowSize}>{formatSize(item.size)}</Text>
          )}
        </Pressable>
      )}
    />
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function messageFor(exc: unknown): string {
  if (exc instanceof ApiError) {
    if (exc.kind === "network")
      return "Can't reach the daemon. Check Tailscale and `make dev`.";
    if (exc.kind === "unauthorized") return "Bearer token rejected.";
    if (exc.kind === "not_found") return "Path not found.";
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
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg, gap: spacing.md },
  errorTitle: { color: colors.text, fontSize: fontSizes.title, fontWeight: "600" },
  errorBody: { color: colors.textMuted, fontSize: fontSizes.body, textAlign: "center" },
  retry: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
  },
  retryText: { color: colors.bg, fontSize: fontSizes.body, fontWeight: "600" },
  emptyText: { color: colors.textDim, fontSize: fontSizes.body },

  list: { padding: spacing.md, gap: spacing.xs },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
  },
  rowPressed: { backgroundColor: colors.surface },
  glyph: { color: colors.accent, fontSize: fontSizes.body, width: 16, textAlign: "center" },
  rowName: { flex: 1, color: colors.text, fontSize: fontSizes.body, fontFamily: "monospace" },
  rowSize: { color: colors.textDim, fontSize: fontSizes.xs },
});
