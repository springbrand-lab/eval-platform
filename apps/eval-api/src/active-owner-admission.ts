/** Keeps a token-free admission service while one owner's HTTP requests are active. */
export function createActiveOwnerAdmission<T>(factory: (ownerUserId: string) => T) {
  const active = new Map<string, { value: T; requests: number }>();
  return {
    acquire(ownerUserId: string): { readonly admission: T; readonly release: () => void } {
      let entry = active.get(ownerUserId);
      if (!entry) {
        entry = { value: factory(ownerUserId), requests: 0 };
        active.set(ownerUserId, entry);
      }
      const current = entry;
      current.requests += 1;
      let released = false;
      return {
        admission: current.value,
        release() {
          if (released) return;
          released = true;
          current.requests -= 1;
          if (current.requests === 0 && active.get(ownerUserId) === current) active.delete(ownerUserId);
        },
      };
    },
  };
}
