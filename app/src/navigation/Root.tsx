// Root navigation container. §1 just shows Settings → Projects flow gated on
// whether config is complete. §2 will inject the PIN gate; §3 the project
// picker; §4 the chat & file tree.

import { DarkTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { ProjectsScreen } from "../screens/ProjectsScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import {
  isComplete,
  loadConfig,
  type ClientConfig,
  type PartialClientConfig,
} from "../storage/config";
import { colors } from "../theme";
import type { RootStackParamList } from "./types";

const Stack = createNativeStackNavigator<RootStackParamList>();

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    primary: colors.accent,
  },
};

export function Root() {
  const [partial, setPartial] = useState<PartialClientConfig | null>(null);

  const refresh = useCallback(async () => {
    setPartial(await loadConfig());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (partial === null) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {isComplete(partial) ? (
          <Stack.Screen name="Projects">
            {() => (
              <ProjectsScreen
                config={partial as ClientConfig}
                onResetConfig={() => setPartial({ baseUrl: null, bearerToken: null, ntfyTopic: null })}
              />
            )}
          </Stack.Screen>
        ) : (
          <Stack.Screen name="Settings">
            {() => <SettingsScreen initial={partial} onSaved={refresh} />}
          </Stack.Screen>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
});
