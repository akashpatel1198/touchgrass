// Stack route types. Routes added incrementally across phase 3 and phase 4.

export type RootStackParamList = {
  Settings: undefined;
  PinGate: { unlock: () => void } | undefined;
  Projects: undefined;
  Sessions: { projectName: string };
  Chat: { sessionId: string; permissionId?: string };
  // Phase 4 §4: FileTree
};
