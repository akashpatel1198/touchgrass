// Stub for §2 — PIN gate. For §1 we just render a placeholder so the nav stack
// resolves. The real PIN flow (set, verify, store hash, exponential backoff)
// lands in the next section.

import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, fontSizes, spacing } from "../theme";

export function PinGateScreen() {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.center}>
        <Text style={styles.title}>PIN gate</Text>
        <Text style={styles.body}>Coming in phase 3 §2.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm },
  title: { color: colors.text, fontSize: fontSizes.title, fontWeight: "600" },
  body: { color: colors.textMuted, fontSize: fontSizes.body },
});
