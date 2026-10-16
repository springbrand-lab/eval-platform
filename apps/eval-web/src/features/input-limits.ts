import { useQuery } from "@tanstack/react-query";
import { getInputLimits, inputLimitsKey } from "@/api-sdk/input-limits-api";

export function useInputLimits() {
  return useQuery({ queryKey: inputLimitsKey, queryFn: ({ signal }) => getInputLimits(signal), staleTime: Infinity });
}
