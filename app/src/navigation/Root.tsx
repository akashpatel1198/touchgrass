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

import {
  DarkTheme,
  NavigationContainer,
  createNavigationContainerRef,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import * as Linking from "expo-linking";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { hasPin } from "../auth/pin";
import { LockProvider, useLockState } from "../auth/useLockState";
import { parseDeepLink, type ParsedDeepLink } from "../lib/deepLink";
import { ChatScreen } from "../screens/ChatScreen";
import { FileSummaryScreen } from "../screens/FileSummaryScreen";
import { FileTreeScreen } from "../screens/FileTreeScreen";
import { PinEntryScreen } from "../screens/PinEntryScreen";
import { PinSetScreen } from "../screens/PinSetScreen";
import { ProjectsScreen } from "../screens/ProjectsScreen";
import { SessionsScreen } from "../screens/SessionsScreen";
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
const navigationRef = createNavigationContainerRef<RootStackParamList>();

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
  const pendingLinkRef = useRef<ParsedDeepLink | null>(null);
  const [pendingTick, setPendingTick] = useState(0);

  const reload = useCallback(async () => {
    const [config, pin] = await Promise.all([loadConfig(), hasPin()]);
    setPartial(config);
    setPinIsSet(pin);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Deep links: capture both cold-launch (`getInitialURL`) and warm-resume
  // (`addEventListener("url")`). Stash in a ref; the consume effect below
  // navigates once the unlocked stack is mounted.
  useEffect(() => {
    let cancelled = false;
    void Linking.getInitialURL().then((url) => {
      if (cancelled) return;
      const parsed = parseDeepLink(url);
      if (parsed) {
        pendingLinkRef.current = parsed;
        setPendingTick((t) => t + 1);
      }
    });
    const sub = Linking.addEventListener("url", ({ url }) => {
      const parsed = parseDeepLink(url);
      if (parsed) {
        pendingLinkRef.current = parsed;
        setPendingTick((t) => t + 1);
      }
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  // Consume the pending deep link once we're unlocked and the navigator is
  // ready. While locked, the link stays parked — the user has to enter their
  // PIN before we route into the session.
  useEffect(() => {
    if (!unlocked) return;
    const link = pendingLinkRef.current;
    if (!link) return;
    if (!navigationRef.isReady()) return;
    pendingLinkRef.current = null;
    navigationRef.navigate("Chat", {
      sessionId: link.sessionId,
      permissionId: link.permissionId,
    });
  }, [unlocked, pendingTick]);

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

  let stack: React.ReactNode;
  if (!isComplete(partial)) {
    stack = (
      <Stack.Screen name="Settings">
        {() => <SettingsScreen initial={partial} onSaved={onConfigSaved} />}
      </Stack.Screen>
    );
  } else if (!pinIsSet) {
    stack = (
      <Stack.Screen name="PinGate">
        {() => <PinSetScreen onPinSet={onPinSet} />}
      </Stack.Screen>
    );
  } else if (!unlocked) {
    stack = (
      <Stack.Screen name="PinGate">
        {() => (
          <PinEntryScreen onUnlock={unlock} onForgotComplete={onForgotComplete} />
        )}
      </Stack.Screen>
    );
  } else {
    // Unlocked: register Projects + Sessions + Chat so navigation pushes work.
    stack = (
      <>
        <Stack.Screen name="Projects">
          {() => (
            <ProjectsScreen
              config={partial as ClientConfig}
              onResetConfig={onResetConfig}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="Sessions" component={SessionsScreen} />
        <Stack.Screen name="Chat" component={ChatScreen} />
        <Stack.Screen name="FileTree" component={FileTreeScreen} />
        <Stack.Screen name="FileSummary" component={FileSummaryScreen} />
      </>
    );
  }

  return (
    <NavigationContainer
      ref={navigationRef}
      theme={navTheme}
      onReady={() => {
        // Re-trigger the consume effect now that the navigator is mounted.
        if (pendingLinkRef.current) setPendingTick((t) => t + 1);
      }}
    >
      <Stack.Navigator screenOptions={{ headerShown: false }}>{stack}</Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
});
