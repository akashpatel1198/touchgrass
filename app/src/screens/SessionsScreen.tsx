// Per-project session list. Fetches on mount and refreshes on focus (so when
// you come back from a chat or a Postman action, the list is current). No
// WebSocket-driven live updates this phase — pull-to-refresh + focus-refresh
// is enough for §4. Live updates land naturally in phase 4 alongside the chat
// WebSocket, since we'll already have the connection open.
//
// Sort order: waiting_permission first (these are the rows screaming for
// attention), then active, then by created_at desc.

import {
  useFocusEffect,
  useNavigation,
  useRoute,
  type RouteProp,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ApiError, api } from "../api/client";
import type { Session, SessionStatus } from "../api/types";
import { NewSessionSheet } from "../components/NewSessionSheet";
import { StatusBadge } from "../components/StatusBadge";
import { relativeTime } from "../lib/time";
import { loadConfig, type ClientConfig, isComplete } from "../storage/config";
import { colors, fontSizes, radii, spacing } from "../theme";
import type { RootStackParamList } from "../navigation/types";

type SessionsRoute = RouteProp<RootStackParamList, "Sessions">;
type Nav = NativeStackNavigationProp<RootStackParamList, "Sessions">;

type FetchState =
  | { kind: "loading" }
  | { kind: "ok"; sessions: Session[] }
  | { kind: "error"; message: string };

const STATUS_RANK: Record<SessionStatus, number> = {
  waiting_permission: 0,
  active: 1,
  completed: 2,
  failed: 3,
};

export function SessionsScreen() {
  const route = useRoute<SessionsRoute>();
  const navigation = useNavigation<Nav>();
  const { projectName } = route.params;

  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [state, setState] = useState<FetchState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(
    async (cfg: ClientConfig) => {
      try {
        const sessions = await api.listProjectSessions(cfg, projectName);
        setState({ kind: "ok", sessions: sortSessions(sessions) });
      } catch (exc) {
        setState({ kind: "error", message: messageFor(exc) });
      }
    },
    [projectName],
  );

  // Re-fetch every time the screen comes into focus (back from Chat, etc.).
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const partial = await loadConfig();
        if (cancelled || !isComplete(partial)) return;
        setConfig(partial);
        await load(partial);
      })();
      return () => {
        cancelled = true;
      };
    }, [load]),
  );

  const onRefresh = async () => {
    if (!config) return;
    setRefreshing(true);
    await load(config);
    setRefreshing(false);
  };

  const onCreate = async (goal: string | null) => {
    if (!config || creating) return;
    setCreating(true);
    try {
      const { session_id } = await api.createSession(config, projectName, goal);
      setSheetVisible(false);
      await load(config);
      navigation.navigate("Chat", { sessionId: session_id });
    } catch (exc) {
      Alert.alert("Couldn't start session", messageFor(exc));
    } finally {
      setCreating(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} style={styles.back}>
          <Text style={styles.backText}>← Projects</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {projectName}
        </Text>
        <Pressable
          onPress={() => setSheetVisible(true)}
          style={styles.newButton}
        >
          <Text style={styles.newButtonText}>+ New</Text>
        </Pressable>
      </View>

      <Body
        state={state}
        refreshing={refreshing}
        onRefresh={onRefresh}
        onPickSession={(id) => navigation.navigate("Chat", { sessionId: id })}
      />

      <NewSessionSheet
        visible={sheetVisible}
        busy={creating}
        onCancel={() => !creating && setSheetVisible(false)}
        onSubmit={onCreate}
      />
    </SafeAreaView>
  );
}

interface BodyProps {
  state: FetchState;
  refreshing: boolean;
  onRefresh: () => void;
  onPickSession: (id: string) => void;
}

function Body({ state, refreshing, onRefresh, onPickSession }: BodyProps) {
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
        <Text style={styles.errorTitle}>Couldn&apos;t load sessions</Text>
        <Text style={styles.errorBody}>{state.message}</Text>
        <Pressable style={styles.retry} onPress={onRefresh}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }
  if (state.sessions.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>No sessions yet</Text>
        <Text style={styles.emptyBody}>Tap &quot;+ New&quot; to start one.</Text>
      </View>
    );
  }
  return (
    <FlatList
      data={state.sessions}
      keyExtractor={(s) => s.id}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.accent}
        />
      }
      renderItem={({ item }) => (
        <SessionRow session={item} onPress={() => onPickSession(item.id)} />
      )}
    />
  );
}

function SessionRow({ session, onPress }: { session: Session; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      android_ripple={{ color: colors.surfaceElevated }}
    >
      <View style={styles.rowTopRow}>
        <StatusBadge status={session.status} />
        <Text style={styles.rowTime}>{relativeTime(session.created_at)}</Text>
      </View>
      <Text style={styles.rowGoal} numberOfLines={2}>
        {session.goal?.trim() || "Untitled session"}
      </Text>
    </Pressable>
  );
}

function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const rankA = STATUS_RANK[a.status];
    const rankB = STATUS_RANK[b.status];
    if (rankA !== rankB) return rankA - rankB;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

function messageFor(exc: unknown): string {
  if (exc instanceof ApiError) {
    if (exc.kind === "network")
      return "Can't reach the daemon. Check Tailscale and `make dev`.";
    if (exc.kind === "unauthorized") return "Bearer token rejected.";
    if (exc.kind === "not_found") return "Project not found.";
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
  },
  back: { paddingVertical: spacing.sm, paddingRight: spacing.sm },
  backText: { color: colors.textMuted, fontSize: fontSizes.body },
  title: {
    flex: 1,
    color: colors.text,
    fontSize: fontSizes.title,
    fontWeight: "600",
  },
  newButton: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
  },
  newButtonText: { color: colors.bg, fontSize: fontSizes.sm, fontWeight: "600" },

  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
    gap: spacing.md,
  },
  errorTitle: { color: colors.text, fontSize: fontSizes.title, fontWeight: "600" },
  errorBody: { color: colors.textMuted, fontSize: fontSizes.body, textAlign: "center", lineHeight: 22 },
  retry: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    marginTop: spacing.sm,
  },
  retryText: { color: colors.bg, fontSize: fontSizes.body, fontWeight: "600" },
  emptyTitle: { color: colors.text, fontSize: fontSizes.title, fontWeight: "600" },
  emptyBody: { color: colors.textMuted, fontSize: fontSizes.body },

  list: { padding: spacing.lg, gap: spacing.md },
  row: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  rowPressed: { opacity: 0.7 },
  rowTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  rowTime: { color: colors.textDim, fontSize: fontSizes.xs },
  rowGoal: { color: colors.text, fontSize: fontSizes.body, lineHeight: 22 },
});
