// Root navigation container. Gates on three pieces of state, in order:
//
//   1. Config complete? → no: show Settings
//   2. PIN set?         → no: show PinSet
//   3. Unlocked?        → no: show PinEntry
//   4. Otherwise        → Projects (the post-auth landing screen)
//
// PIN setup goes straight into "unlocked" so the user isn't asked to retype
// the PIN they just confirmed. Background-then-foreground past 60s flips
// `unlocked` back to false (handled inside LockProvider).

import { DarkTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { hasPin } from "../auth/pin";
import { LockProvider, useLockState } from "../auth/useLockState";
import { PinEntryScreen } from "../screens/PinEntryScreen";
import { PinSetScreen } from "../screens/PinSetScreen";
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
  return (
    <LockProvider>
      <RootRouter />
    </LockProvider>
  );
}

function RootRouter() {
  const [partial, setPartial] = useState<PartialClientConfig | null>(null);
  const [pinIsSet, setPinIsSet] = useState<boolean | null>(null);
  const { unlocked, unlock, lock } = useLockState();

  const reload = useCallback(async () => {
    const [config, pin] = await Promise.all([loadConfig(), hasPin()]);
    setPartial(config);
    setPinIsSet(pin);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (partial === null || pinIsSet === null) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const onConfigSaved = async () => {
    await reload();
  };

  const onPinSet = async () => {
    setPinIsSet(true);
    unlock();
  };

  const onForgotComplete = async () => {
    setPinIsSet(false);
    setPartial({ baseUrl: null, bearerToken: null, ntfyTopic: null });
    lock();
  };

  const onResetConfig = async () => {
    setPartial({ baseUrl: null, bearerToken: null, ntfyTopic: null });
  };

  let screen: React.ReactNode;
  if (!isComplete(partial)) {
    screen = (
      <Stack.Screen name="Settings">
        {() => <SettingsScreen initial={partial} onSaved={onConfigSaved} />}
      </Stack.Screen>
    );
  } else if (!pinIsSet) {
    screen = (
      <Stack.Screen name="PinGate">
        {() => <PinSetScreen onPinSet={onPinSet} />}
      </Stack.Screen>
    );
  } else if (!unlocked) {
    screen = (
      <Stack.Screen name="PinGate">
        {() => (
          <PinEntryScreen onUnlock={unlock} onForgotComplete={onForgotComplete} />
        )}
      </Stack.Screen>
    );
  } else {
    screen = (
      <Stack.Screen name="Projects">
        {() => (
          <ProjectsScreen
            config={partial as ClientConfig}
            onResetConfig={onResetConfig}
          />
        )}
      </Stack.Screen>
    );
  }

  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>{screen}</Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
});
