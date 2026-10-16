export const TOKEN_FIELDS = [
  ["total", "总 Token"], ["cacheRead", "缓存读取 Token"], ["cacheWrite", "缓存写入 Token"],
  ["input", "输入 Token"], ["output", "输出 Token"], ["reasoning", "推理 Token"],
] as const;

export const COST_FIELDS = [
  ["chargedUnits", "实际积分"], ["modelDebitedUnits", "模型积分"], ["actionChargedUnits", "Action 积分"],
  ["providerUsd", "模型成本"], ["ratedUnits", "计价积分"], ["shortfallUnits", "余额不足积分"], ["platformOwnedUnits", "平台承担积分"],
] as const;

export const OPERATION_FIELDS = [
  ["count", "次数"], ["completed", "成功"], ["failed", "失败"], ["cancelled", "取消"], ["inProgress", "进行中"], ["unknown", "未知"],
] as const;
