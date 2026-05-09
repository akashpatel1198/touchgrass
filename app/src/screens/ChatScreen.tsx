// Chat UI for an active session. Pulls history + live updates over a single
// WebSocket. Sends are REST (`POST /sessions/{id}/prompts`) — simpler than
// multiplexing sends over the WS, and matches what phase 1 wired up.
//
// Transcript layout: flat list of role-typed rows. Tool calls and tool results
// are independent rows (the daemon's persisted store gives us them flat too,
// so there's no clean "merge by tool_use_id" path on replay). Tap a tool row
// to expand its args/content.
//
// Reconnect handling: on every `open`, we wipe the transcript before the
// daemon's replay envelopes paint it back. This keeps the screen in sync with
// the persisted store and avoids duplicates on flaky links.

import {
  useNavigation,
  useRoute,
  type RouteProp,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import Markdown from "react-native-markdown-display";

import { ApiError, api } from "../api/client";
import type {
  DecisionKind,
  Message,
  PermissionRequest,
  Session,
  SessionStatus,
} from "../api/types";
import {
  connectSessionStream,
  type ReplayPayload,
  type WsConnectionStatus,
  type WsEvent,
  type WsHandle,
} from "../api/ws";
import { PermissionSheet } from "../components/PermissionSheet";
import { StatusBadge } from "../components/StatusBadge";
import {
  isComplete,
  loadConfig,
  type ClientConfig,
} from "../storage/config";
import { colors, fontSizes, radii, spacing } from "../theme";
import type { RootStackParamList } from "../navigation/types";

type ChatRoute = RouteProp<RootStackParamList, "Chat">;
type Nav = NativeStackNavigationProp<RootStackParamList, "Chat">;

type Item =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | {
      kind: "tool_call";
      id: string;
      toolName: string;
      toolArgs: string;
    }
  | {
      kind: "tool_result";
      id: string;
      content: string;
      isError: boolean;
    }
  | { kind: "error"; id: string; message: string };

const NEAR_BOTTOM_PX = 80;

export function ChatScreen() {
  const route = useRoute<ChatRoute>();
  const navigation = useNavigation<Nav>();
  const { sessionId, permissionId } = route.params;

  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>("connecting");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [pending, setPending] = useState<PermissionRequest | null>(null);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [turnInFlight, setTurnInFlight] = useState(false);

  const listRef = useRef<FlatList<Item>>(null);
  const counterRef = useRef(0);
  const nextId = (prefix: string) => `${prefix}-${++counterRef.current}`;
  // Pending wipe runs synchronously when the next event arrives after a fresh
  // WS open. Doing it via useEffect on wsStatus loses the race against the
  // replay events that come right after onopen — the replays would land in
  // setItems first, then the effect would wipe them.
  const pendingWipeRef = useRef(false);
  const wsHandleRef = useRef<WsHandle | null>(null);
  // Guard so we don't double-init the connection / history fetch on re-renders.
  const initRef = useRef(false);

  // Boot: load config, fetch session metadata, then open the WS. Without
  // config we can't do anything; bounce back.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const partial = await loadConfig();
      if (cancelled) return;
      if (!isComplete(partial)) {
        navigation.goBack();
        return;
      }
      setConfig(partial);
      try {
        const s = await api.getSession(partial, sessionId);
        if (!cancelled) setSession(s);
      } catch (exc) {
        if (!cancelled) {
          Alert.alert("Couldn't load session", messageFor(exc));
        }
      }
      // Cold-start recovery: if a permission for this session was already
      // pending before we connected, surface it immediately. If we arrived
      // here via a deep link (`permissionId` param set), prefer that exact id
      // and warn if it's no longer pending — likely already resolved.
      try {
        const all = await api.listPendingPermissions(partial);
        if (cancelled) return;
        if (permissionId) {
          const exact = all.find((r) => r.id === permissionId) ?? null;
          if (exact) {
            setPending(exact);
            setSheetVisible(true);
          } else {
            Alert.alert(
              "Already handled",
              "That permission request was already resolved.",
            );
          }
        } else {
          const match = all.find((r) => r.session_id === sessionId) ?? null;
          if (match) {
            setPending(match);
            setSheetVisible(true);
          }
        }
      } catch {
        // Non-fatal — the WS will deliver any new permission_request anyway.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigation, sessionId, permissionId]);

  const handleEvent = useCallback((event: WsEvent) => {
    // Wipe-on-fresh-open lives here, not in a useEffect on wsStatus, so it
    // runs in the same tick as the events that follow `onopen`. Otherwise
    // replays land first and a deferred wipe nukes them.
    if (pendingWipeRef.current) {
      pendingWipeRef.current = false;
      setItems([]);
      setExpanded({});
      counterRef.current = 0;
    }
    if (event.type === "replay") {
      const incoming = replayToItem(event.payload);
      if (!incoming) return;
      setItems((prev) => [...prev, incoming]);
      return;
    }
    if (event.type === "assistant_message") {
      setTurnInFlight(false);
      setItems((prev) => [
        ...prev,
        { kind: "assistant", id: nextId("a"), text: event.payload.text },
      ]);
      return;
    }
    if (event.type === "tool_call") {
      const args =
        typeof event.payload.tool_args === "string"
          ? event.payload.tool_args
          : JSON.stringify(event.payload.tool_args, null, 2);
      setItems((prev) => [
        ...prev,
        {
          kind: "tool_call",
          id: nextId("tc"),
          toolName: event.payload.tool_name,
          toolArgs: args,
        },
      ]);
      return;
    }
    if (event.type === "tool_result") {
      const content =
        typeof event.payload.content === "string"
          ? event.payload.content
          : JSON.stringify(event.payload.content, null, 2);
      setItems((prev) => [
        ...prev,
        {
          kind: "tool_result",
          id: nextId("tr"),
          content,
          isError: event.payload.is_error,
        },
      ]);
      return;
    }
    if (event.type === "session_status") {
      const newStatus = event.payload.status;
      setSession((s) => (s ? { ...s, status: newStatus } : s));
      if (newStatus === "completed" || newStatus === "failed") {
        setTurnInFlight(false);
      }
      return;
    }
    if (event.type === "permission_request") {
      const p = event.payload;
      const args =
        typeof p.tool_args === "string"
          ? p.tool_args
          : JSON.stringify(p.tool_args);
      setPending({
        id: p.request_id,
        session_id: event.session_id,
        tool_name: p.tool_name,
        tool_args: args,
        status: "pending",
        created_at: p.created_at,
        resolved_at: null,
      });
      setSheetVisible(true);
      return;
    }
    if (event.type === "error") {
      setTurnInFlight(false);
      setItems((prev) => [
        ...prev,
        { kind: "error", id: nextId("e"), message: event.payload.message },
      ]);
    }
  }, []);

  const onWsStatusChange = useCallback((s: WsConnectionStatus) => {
    if (s === "open") pendingWipeRef.current = true;
    setWsStatus(s);
  }, []);

  // Once we have config + session metadata, decide how to populate the
  // transcript. Active/waiting sessions get a live WS subscription; terminal
  // sessions have no hub on the daemon, so we fetch history over REST. Guard
  // against re-running when session status flips mid-screen.
  useEffect(() => {
    if (!config || !session || initRef.current) return;
    initRef.current = true;

    const isTerminal =
      session.status === "completed" || session.status === "failed";

    if (isTerminal) {
      setWsStatus("closed");
      (async () => {
        try {
          const msgs = await api.getMessages(config, sessionId, { limit: 200 });
          const mapped = msgs
            .map(messageToItem)
            .filter((x): x is Item => x !== null);
          setItems(mapped);
        } catch (exc) {
          Alert.alert("Couldn't load history", messageFor(exc));
        }
      })();
      return;
    }

    wsHandleRef.current = connectSessionStream(config, sessionId, {
      onStatusChange: onWsStatusChange,
      onEvent: handleEvent,
    });
  }, [config, session, sessionId, handleEvent, onWsStatusChange]);

  useEffect(() => {
    return () => {
      wsHandleRef.current?.close();
    };
  }, []);

  // Auto-scroll: if user is pinned near the bottom, keep it pinned on new
  // content. If they've scrolled up, leave them alone and surface the "jump
  // to latest" pill.
  useEffect(() => {
    if (pinnedToBottom) {
      // requestAnimationFrame so the list has measured the new row first.
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: true });
      });
    }
  }, [items, pinnedToBottom]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distanceFromBottom =
      contentSize.height - (contentOffset.y + layoutMeasurement.height);
    setPinnedToBottom(distanceFromBottom < NEAR_BOTTOM_PX);
  };

  const send = async () => {
    if (!config || sending) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    setSending(true);
    setText("");
    setItems((prev) => [
      ...prev,
      { kind: "user", id: nextId("u"), text: trimmed },
    ]);
    setPinnedToBottom(true);
    setTurnInFlight(true);
    try {
      await api.submitPrompt(config, sessionId, trimmed);
    } catch (exc) {
      Alert.alert("Couldn't send prompt", messageFor(exc));
      setTurnInFlight(false);
    } finally {
      setSending(false);
    }
  };

  const toggle = (id: string) =>
    setExpanded((m) => ({ ...m, [id]: !m[id] }));

  const decide = async (decision: DecisionKind) => {
    if (!config || !pending || decisionBusy) return;
    setDecisionBusy(true);
    try {
      await api.decidePermission(config, pending.id, decision);
      setPending(null);
      setSheetVisible(false);
    } catch (exc) {
      // 409 = the broker already resolved this (timeout, or another client
      // decided). 404 = unknown id, same outcome from the user's POV.
      if (
        exc instanceof ApiError &&
        (exc.kind === "conflict" || exc.kind === "not_found")
      ) {
        Alert.alert("Already handled", "This request was already resolved.");
        setPending(null);
        setSheetVisible(false);
      } else {
        Alert.alert("Couldn't submit decision", messageFor(exc));
      }
    } finally {
      setDecisionBusy(false);
    }
  };

  const renderItem = ({ item }: { item: Item }) => (
    <Row item={item} expanded={!!expanded[item.id]} onToggle={() => toggle(item.id)} />
  );

  const status: SessionStatus = session?.status ?? "active";
  const waiting = status === "waiting_permission";
  const terminal = status === "completed" || status === "failed";

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} style={styles.back}>
          <Text style={styles.backText}>← Sessions</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.title} numberOfLines={1}>
            {session?.goal?.trim() || "Untitled session"}
          </Text>
          <View style={styles.headerMeta}>
            <StatusBadge status={status} />
            <Text style={styles.headerWs}>
              {wsStatus === "open"
                ? "live"
                : wsStatus === "connecting"
                ? "connecting…"
                : "offline"}
            </Text>
          </View>
        </View>
        {session && (
          <Pressable
            style={styles.filesBtn}
            onPress={() =>
              navigation.navigate("FileTree", {
                projectName: session.project_name,
                path: "",
              })
            }
          >
            <Text style={styles.filesBtnText}>Files</Text>
          </Pressable>
        )}
      </View>

      {waiting && (
        <Pressable
          style={styles.banner}
          onPress={() => {
            if (pending) setSheetVisible(true);
          }}
        >
          <Text style={styles.bannerText}>
            {pending
              ? "Waiting for your approval — tap to review"
              : "Waiting for your approval…"}
          </Text>
        </Pressable>
      )}

      <KeyboardAvoidingView
        style={styles.flex}
        // `behavior="padding"` works on both platforms in Expo Go. On Android,
        // `undefined` would rely on the activity's softInputMode (we set
        // `resize` in app.json), but that's only honored once a dev build
        // ships — Expo Go ignores it. Padding is the belt + suspenders.
        behavior="padding"
        keyboardVerticalOffset={0}
      >
        <View style={styles.transcriptWrap}>
          <FlatList
            ref={listRef}
            data={items}
            keyExtractor={(it) => it.id}
            renderItem={renderItem}
            contentContainerStyle={styles.transcript}
            onScroll={onScroll}
            scrollEventThrottle={64}
            onContentSizeChange={() => {
              if (pinnedToBottom) listRef.current?.scrollToEnd({ animated: false });
            }}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyText}>
                  {terminal
                    ? "No messages in this session."
                    : wsStatus === "open"
                    ? "No messages yet. Send a prompt below."
                    : "Connecting…"}
                </Text>
              </View>
            }
          />
          {!pinnedToBottom && (
            <Pressable
              style={styles.jumpPill}
              onPress={() => {
                setPinnedToBottom(true);
                listRef.current?.scrollToEnd({ animated: true });
              }}
            >
              <Text style={styles.jumpText}>Jump to latest ↓</Text>
            </Pressable>
          )}
        </View>

        {turnInFlight && (
          <View style={styles.thinking}>
            <ActivityIndicator color={colors.accent} size="small" />
            <Text style={styles.thinkingText}>Claude is thinking…</Text>
          </View>
        )}

        <View style={styles.inputBar}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder={
              terminal ? "Session ended" : "Send a prompt…"
            }
            placeholderTextColor={colors.textDim}
            multiline
            editable={!terminal}
          />
          <Pressable
            onPress={send}
            disabled={sending || terminal || !text.trim()}
            style={[
              styles.sendBtn,
              (sending || terminal || !text.trim()) && styles.sendBtnDisabled,
            ]}
          >
            {sending ? (
              <ActivityIndicator color={colors.bg} size="small" />
            ) : (
              <Text style={styles.sendText}>Send</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      <PermissionSheet
        visible={sheetVisible}
        request={pending}
        busy={decisionBusy}
        onDecision={decide}
        onDismiss={() => !decisionBusy && setSheetVisible(false)}
      />
    </SafeAreaView>
  );
}

function replayToItem(p: ReplayPayload): Item | null {
  return roleToItem({
    id: `replay-${p.id}`,
    role: p.role,
    content: p.content,
    tool_name: p.tool_name,
    tool_args: p.tool_args,
  });
}

function messageToItem(m: Message): Item | null {
  return roleToItem({
    id: `rest-${m.id}`,
    role: m.role,
    content: m.content,
    tool_name: m.tool_name,
    tool_args: m.tool_args,
  });
}

function roleToItem(p: {
  id: string;
  role: Message["role"];
  content: string;
  tool_name: string | null;
  tool_args: string | null;
}): Item | null {
  if (p.role === "user") return { kind: "user", id: p.id, text: p.content };
  if (p.role === "assistant")
    return { kind: "assistant", id: p.id, text: p.content };
  if (p.role === "tool_call") {
    return {
      kind: "tool_call",
      id: p.id,
      toolName: p.tool_name ?? "tool",
      toolArgs: p.tool_args ?? p.content,
    };
  }
  if (p.role === "tool_result") {
    return { kind: "tool_result", id: p.id, content: p.content, isError: false };
  }
  return null;
}

function Row({
  item,
  expanded,
  onToggle,
}: {
  item: Item;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (item.kind === "user") {
    return (
      <View style={[styles.bubble, styles.bubbleUser]}>
        <Text style={styles.bubbleText}>{item.text}</Text>
      </View>
    );
  }
  if (item.kind === "assistant") {
    return (
      <View style={[styles.bubble, styles.bubbleAssistant]}>
        <Markdown style={markdownStyles}>{item.text}</Markdown>
      </View>
    );
  }
  if (item.kind === "error") {
    return (
      <View style={[styles.bubble, styles.bubbleError]}>
        <Text style={styles.bubbleText}>Error: {item.message}</Text>
      </View>
    );
  }
  if (item.kind === "tool_call") {
    return (
      <Pressable onPress={onToggle} style={styles.tool}>
        <View style={styles.toolHeader}>
          <Text style={styles.toolChip}>⏵ {item.toolName}</Text>
          <Text style={styles.toolHint}>{expanded ? "tap to hide" : "tap to expand"}</Text>
        </View>
        {expanded && <Text style={styles.code}>{item.toolArgs}</Text>}
      </Pressable>
    );
  }
  // tool_result
  return (
    <Pressable onPress={onToggle} style={styles.tool}>
      <View style={styles.toolHeader}>
        <Text style={[styles.toolChip, item.isError && styles.toolChipError]}>
          ⏶ result{item.isError ? " (error)" : ""}
        </Text>
        <Text style={styles.toolHint}>{expanded ? "tap to hide" : "tap to expand"}</Text>
      </View>
      {expanded && <Text style={styles.code}>{item.content}</Text>}
    </Pressable>
  );
}

function messageFor(exc: unknown): string {
  if (exc instanceof ApiError) {
    if (exc.kind === "network")
      return "Can't reach the daemon. Check Tailscale and `make dev`.";
    if (exc.kind === "unauthorized") return "Bearer token rejected.";
    if (exc.kind === "not_found") return "Session not found.";
    return exc.message;
  }
  return "Unexpected error.";
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
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
  headerCenter: { flex: 1, gap: spacing.xs },
  title: {
    color: colors.text,
    fontSize: fontSizes.lg,
    fontWeight: "600",
  },
  headerMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  headerWs: { color: colors.textDim, fontSize: fontSizes.xs },
  filesBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  filesBtnText: { color: colors.text, fontSize: fontSizes.sm, fontWeight: "600" },

  banner: {
    backgroundColor: colors.warning,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  bannerText: {
    color: colors.bg,
    fontSize: fontSizes.sm,
    fontWeight: "600",
    textAlign: "center",
  },

  transcriptWrap: { flex: 1 },
  transcript: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.lg },
  empty: { padding: spacing.xl, alignItems: "center" },
  emptyText: { color: colors.textDim, fontSize: fontSizes.sm },

  bubble: {
    padding: spacing.md,
    borderRadius: radii.md,
    maxWidth: "92%",
  },
  bubbleUser: {
    backgroundColor: colors.accentMuted,
    alignSelf: "flex-end",
  },
  bubbleAssistant: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  bubbleError: {
    backgroundColor: colors.danger,
    alignSelf: "flex-start",
  },
  bubbleText: { color: colors.text, fontSize: fontSizes.body, lineHeight: 22 },

  tool: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.sm,
    gap: spacing.sm,
  },
  toolHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  toolChip: {
    color: colors.accent,
    fontSize: fontSizes.xs,
    fontWeight: "600",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  toolChipError: { color: colors.danger },
  toolHint: { color: colors.textDim, fontSize: fontSizes.xs },
  code: {
    color: colors.text,
    fontSize: fontSizes.xs,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    backgroundColor: colors.bg,
    padding: spacing.sm,
    borderRadius: radii.sm,
  },

  jumpPill: {
    position: "absolute",
    bottom: spacing.md,
    alignSelf: "center",
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.lg,
  },
  jumpText: { color: colors.text, fontSize: fontSizes.xs, fontWeight: "600" },

  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    padding: spacing.md,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    color: colors.text,
    fontSize: fontSizes.body,
    backgroundColor: colors.bg,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderColor: colors.border,
    borderWidth: 1,
  },
  sendBtn: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    minWidth: 72,
    alignItems: "center",
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendText: { color: colors.bg, fontSize: fontSizes.body, fontWeight: "600" },

  thinking: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  thinkingText: { color: colors.textMuted, fontSize: fontSizes.sm },
});

// Markdown styles for assistant messages. Keep it close to the surrounding
// bubble styling so it doesn't clash; tighten paragraph margins so single-line
// replies don't have a sea of vertical padding.
const markdownStyles = StyleSheet.create({
  body: { color: colors.text, fontSize: fontSizes.body, lineHeight: 22 },
  paragraph: { marginTop: 0, marginBottom: spacing.sm, color: colors.text },
  heading1: { color: colors.text, fontSize: fontSizes.title, fontWeight: "700", marginBottom: spacing.sm, marginTop: spacing.sm },
  heading2: { color: colors.text, fontSize: fontSizes.lg, fontWeight: "700", marginBottom: spacing.sm, marginTop: spacing.sm },
  heading3: { color: colors.text, fontSize: fontSizes.body, fontWeight: "700", marginBottom: spacing.sm, marginTop: spacing.sm },
  strong: { fontWeight: "700", color: colors.text },
  em: { fontStyle: "italic", color: colors.text },
  code_inline: {
    color: colors.accent,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: fontSizes.sm,
    backgroundColor: colors.bg,
    paddingHorizontal: 4,
    borderRadius: 3,
  },
  code_block: {
    color: colors.text,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: fontSizes.xs,
    backgroundColor: colors.bg,
    padding: spacing.sm,
    borderRadius: radii.sm,
    borderColor: colors.border,
    borderWidth: 1,
  },
  fence: {
    color: colors.text,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: fontSizes.xs,
    backgroundColor: colors.bg,
    padding: spacing.sm,
    borderRadius: radii.sm,
    borderColor: colors.border,
    borderWidth: 1,
  },
  bullet_list: { marginBottom: spacing.sm },
  ordered_list: { marginBottom: spacing.sm },
  list_item: { color: colors.text, marginBottom: 2 },
  link: { color: colors.accent, textDecorationLine: "underline" },
  hr: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth, marginVertical: spacing.sm },
  blockquote: {
    backgroundColor: colors.surfaceElevated,
    borderLeftColor: colors.accent,
    borderLeftWidth: 3,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginVertical: spacing.xs,
  },
});
