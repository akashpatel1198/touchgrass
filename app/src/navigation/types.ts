// Stack route types. Routes added incrementally across §1–§4 of phase 3.

export type RootStackParamList = {
  Settings: undefined;
  PinGate: { unlock: () => void } | undefined;
  Projects: undefined;
  Sessions: { projectName: string };
  // Phase 4: Chat, FileTree
};
