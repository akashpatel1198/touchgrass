// Persisted client config. The bearer token lives in expo-secure-store (treated as
// a credential); the rest in AsyncStorage. Both APIs are async — callers should
// `await loadConfig()` once on app startup and pass the result down.

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

const BASE_URL_KEY = "touchgrass.baseUrl";
const NTFY_TOPIC_KEY = "touchgrass.ntfyTopic";
const LAST_PROJECT_KEY = "touchgrass.lastProject";
const BEARER_KEY = "touchgrass_bearer"; // SecureStore keys can't have dots

export interface ClientConfig {
  baseUrl: string;
  bearerToken: string;
  ntfyTopic: string;
}

export interface PartialClientConfig {
  baseUrl: string | null;
  bearerToken: string | null;
  ntfyTopic: string | null;
}

export async function loadConfig(): Promise<PartialClientConfig> {
  const [baseUrl, ntfyTopic, bearerToken] = await Promise.all([
    AsyncStorage.getItem(BASE_URL_KEY),
    AsyncStorage.getItem(NTFY_TOPIC_KEY),
    SecureStore.getItemAsync(BEARER_KEY),
  ]);
  return { baseUrl, ntfyTopic, bearerToken };
}

export function isComplete(
  config: PartialClientConfig,
): config is ClientConfig {
  return !!config.baseUrl && !!config.bearerToken && !!config.ntfyTopic;
}

export async function saveConfig(config: ClientConfig): Promise<void> {
  await Promise.all([
    AsyncStorage.setItem(BASE_URL_KEY, config.baseUrl),
    AsyncStorage.setItem(NTFY_TOPIC_KEY, config.ntfyTopic),
    SecureStore.setItemAsync(BEARER_KEY, config.bearerToken),
  ]);
}

export async function clearConfig(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(BASE_URL_KEY),
    AsyncStorage.removeItem(NTFY_TOPIC_KEY),
    AsyncStorage.removeItem(LAST_PROJECT_KEY),
    SecureStore.deleteItemAsync(BEARER_KEY),
  ]);
}

export async function getLastProject(): Promise<string | null> {
  return AsyncStorage.getItem(LAST_PROJECT_KEY);
}

export async function setLastProject(name: string): Promise<void> {
  await AsyncStorage.setItem(LAST_PROJECT_KEY, name);
}
