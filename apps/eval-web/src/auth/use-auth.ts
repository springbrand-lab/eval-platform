import { useSyncExternalStore } from "react";
import { getAuthState, subscribeAuth, type AuthState } from "./session";

export function useAuth(): AuthState {
  return useSyncExternalStore(subscribeAuth, getAuthState, getAuthState);
}
