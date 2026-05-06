// Project picker. Fetches GET /projects on mount and on pull-to-refresh.
// Last-picked project is surfaced as a prominent "Resume" card at the top so
// the common case is one tap away.
//
// Tap a project → navigate to Sessions for that project. The actual session
// list rendering lands in §4.

import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useEffect, useState } from "react";
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
import type { Project } from "../api/types";
import { useLockState } from "../auth/useLockState";
import {
  getLastProject,
  setLastProject,
  type ClientConfig,
} from "../storage/config";
import { colors, fontSizes, radii, spacing } from "../theme";
import type { RootStackParamList } from "../navigation/types";

type Nav = NativeStackNavigationProp<RootStackParamList, "Projects">;

interface Props {
  config: ClientConfig;
  onResetConfig: () => void;
}

type FetchState =
  | { kind: "loading" }
  | { kind: "ok"; projects: Project[] }
  | { kind: "error"; message: string };

export function ProjectsScreen({ config, onResetConfig }: Props) {
  const navigation = useNavigation<Nav>();
  const { lock } = useLockState();
  const [state, setState] = useState<FetchState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [lastPicked, setLastPicked] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const projects = await api.listProjects(config);
      setState({ kind: "ok", projects });
    } catch (exc) {
      setState({ kind: "error", message: messageFor(exc) });
    }
  }, [config]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [, last] = await Promise.all([load(), getLastProject()]);
      if (!cancelled) setLastPicked(last);
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const onPick = async (name: string) => {
    await setLastProject(name);
    setLastPicked(name);
    navigation.navigate("Sessions", { projectName: name });
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Projects</Text>
          <Text style={styles.subtitle}>{config.baseUrl}</Text>
        </View>
        <Pressable onPress={lock} style={styles.headerAction}>
          <Text style={styles.headerActionText}>Lock</Text>
        </Pressable>
      </View>

      <Body
        state={state}
        refreshing={refreshing}
        onRefresh={onRefresh}
        lastPicked={lastPicked}
        onPick={onPick}
        onResetConfig={onResetConfig}
      />
    </SafeAreaView>
  );
}

interface BodyProps {
  state: FetchState;
  refreshing: boolean;
  onRefresh: () => Promise<void> | void;
  lastPicked: string | null;
  onPick: (name: string) => void;
  onResetConfig: () => void;
}

function Body({
  state,
  refreshing,
  onRefresh,
  lastPicked,
  onPick,
  onResetConfig,
}: BodyProps) {
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
        <Text style={styles.errorTitle}>Can&apos;t reach the daemon</Text>
        <Text style={styles.errorBody}>{state.message}</Text>
        <Pressable style={styles.errorButton} onPress={onRefresh}>
          <Text style={styles.errorButtonText}>Try again</Text>
        </Pressable>
        <Pressable style={styles.linkButton} onPress={onResetConfig}>
          <Text style={styles.linkButtonText}>Edit connection</Text>
        </Pressable>
      </View>
    );
  }

  const ordered = orderedWithResume(state.projects, lastPicked);

  if (ordered.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>No projects configured</Text>
        <Text style={styles.emptyBody}>
          Edit <Text style={styles.code}>~/.touchgrass/config.yaml</Text> on your
          laptop and restart the daemon.
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={ordered}
      keyExtractor={(item) => item.project.name}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.accent}
        />
      }
      renderItem={({ item }) => (
        <ProjectCard
          project={item.project}
          isLastPicked={item.isLastPicked}
          onPress={() => onPick(item.project.name)}
        />
      )}
    />
  );
}

interface CardItem {
  project: Project;
  isLastPicked: boolean;
}

function orderedWithResume(
  projects: Project[],
  lastPicked: string | null,
): CardItem[] {
  if (!lastPicked) return projects.map((p) => ({ project: p, isLastPicked: false }));
  const matched = projects.find((p) => p.name === lastPicked);
  if (!matched) {
    return projects.map((p) => ({ project: p, isLastPicked: false }));
  }
  const rest = projects.filter((p) => p.name !== lastPicked);
  return [
    { project: matched, isLastPicked: true },
    ...rest.map((p) => ({ project: p, isLastPicked: false })),
  ];
}

interface CardProps {
  project: Project;
  isLastPicked: boolean;
  onPress: () => void;
}

function ProjectCard({ project, isLastPicked, onPress }: CardProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        isLastPicked && styles.cardResume,
        pressed && styles.cardPressed,
      ]}
      android_ripple={{ color: colors.surfaceElevated }}
    >
      {isLastPicked && <Text style={styles.resumeLabel}>RESUME</Text>}
      <Text style={styles.cardTitle}>{project.name}</Text>
      <Text style={styles.cardPath} numberOfLines={1}>
        {project.path}
      </Text>
    </Pressable>
  );
}

function messageFor(exc: unknown): string {
  if (exc instanceof ApiError) {
    if (exc.kind === "network") {
      return "Can't reach the daemon at this URL. Check Tailscale and that `make dev` is running.";
    }
    if (exc.kind === "unauthorized") {
      return "Bearer token rejected. Tap 'Edit connection' below to re-paste it.";
    }
    return exc.message;
  }
  return "Unexpected error. Pull to retry.";
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
  headerAction: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
  },
  headerActionText: { color: colors.textMuted, fontSize: fontSizes.sm },
  title: { color: colors.text, fontSize: fontSizes.display, fontWeight: "600" },
  subtitle: { color: colors.textDim, fontSize: fontSizes.xs, marginTop: 2 },

  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
    gap: spacing.md,
  },
  errorTitle: { color: colors.text, fontSize: fontSizes.title, fontWeight: "600" },
  errorBody: { color: colors.textMuted, fontSize: fontSizes.body, textAlign: "center", lineHeight: 22 },
  errorButton: {
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.md,
    marginTop: spacing.sm,
  },
  errorButtonText: { color: colors.bg, fontSize: fontSizes.body, fontWeight: "600" },
  linkButton: { paddingVertical: spacing.sm },
  linkButtonText: { color: colors.textMuted, fontSize: fontSizes.sm },

  emptyTitle: { color: colors.text, fontSize: fontSizes.title, fontWeight: "600" },
  emptyBody: { color: colors.textMuted, fontSize: fontSizes.body, textAlign: "center", lineHeight: 22 },
  code: { fontFamily: "monospace", color: colors.text },

  list: { padding: spacing.lg, gap: spacing.md },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: 4,
  },
  cardResume: { borderColor: colors.accent },
  cardPressed: { opacity: 0.7 },
  resumeLabel: {
    color: colors.accent,
    fontSize: fontSizes.xs,
    fontWeight: "600",
    letterSpacing: 1,
  },
  cardTitle: { color: colors.text, fontSize: fontSizes.lg, fontWeight: "600" },
  cardPath: { color: colors.textDim, fontSize: fontSizes.xs },
});
