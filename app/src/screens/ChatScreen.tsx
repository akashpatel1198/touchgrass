// Placeholder for phase 4 §1. Real chat UI streams over the WebSocket.

import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, fontSizes, radii, spacing } from "../theme";
import type { RootStackParamList } from "../navigation/types";

type ChatRoute = RouteProp<RootStackParamList, "Chat">;

export function ChatScreen() {
  const route = useRoute<ChatRoute>();
  const navigation = useNavigation();

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} style={styles.back}>
          <Text style={styles.backText}>← Sessions</Text>
        </Pressable>
      </View>
      <View style={styles.body}>
        <Text style={styles.title}>Chat</Text>
        <Text style={styles.subtitle}>Session</Text>
        <Text style={styles.id}>{route.params.sessionId}</Text>
        <Text style={styles.placeholder}>Chat UI lands in phase 4 §1.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  back: { alignSelf: "flex-start", paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radii.md },
  backText: { color: colors.textMuted, fontSize: fontSizes.body },
  body: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm, padding: spacing.lg },
  title: { color: colors.text, fontSize: fontSizes.display, fontWeight: "600" },
  subtitle: { color: colors.textMuted, fontSize: fontSizes.sm, marginTop: spacing.md },
  id: {
    color: colors.text,
    fontSize: fontSizes.xs,
    fontFamily: "monospace",
  },
  placeholder: {
    color: colors.textMuted,
    fontSize: fontSizes.body,
    marginTop: spacing.lg,
  },
});
