---
name: product-lifecycle-labeling
description: 使用通用产品生命周期漏斗为需求、PRD、Issue 或 Backlog 打标。适用于用户要求按认知、获客、激活、留存、收入、推荐等行业术语分类；不用于自行设计产品专属漏斗或埋点方案，除非用户明确要求。
---

# 产品生命周期打标

使用扩展 AARRR 作为跨产品统一语言。为每条需求分配一个主要生命周期标签，并在确有必要时补充一个二级标签。

## 一级标签

| Key | 中文 | 判断标准 |
| --- | --- | --- |
| `awareness` | 认知 | 让潜在用户知道产品存在，例如品牌、广告、SEO、营销内容。 |
| `acquisition` | 获客 | 让用户进入产品或成为可识别用户，例如访问、下载、注册、登录、试用。 |
| `activation` | 激活 | 帮助用户第一次体验核心价值，即到达 Aha Moment。 |
| `retention` | 留存 | 帮助用户持续、重复或重新获得核心价值。 |
| `revenue` | 收入／变现 | 促成首次付费、续费、升级、加购或收入扩张。 |
| `referral` | 推荐／传播 | 让现有用户带来新的潜在用户或新用户。 |
| `not_applicable` | 不适用 | 不直接服务某个漏斗阶段的基础设施、安全、合规、性能或内部工程需求。 |

## 二级标签

仅在一级标签不足以支持筛选时使用：

`discovery`、`signup`、`onboarding`、`first_value`、`engagement`、`reactivation`、`churn_prevention`、`monetization`、`expansion`、`sharing`、`offboarding`。

常见映射：

- 注册、登录：`acquisition` + `signup`
- 新手引导：`activation` + `onboarding`
- 首次成功任务：`activation` + `first_value`
- 核心功能使用：`retention` + `engagement`
- 推送召回：`retention` + `reactivation`
- 流失预警：`retention` + `churn_prevention`
- 付费墙、订阅：`revenue` + `monetization`
- 升级、加购：`revenue` + `expansion`
- 邀请好友：`referral` + `sharing`

## 判定规则

1. 按需求希望改变的用户行为或业务指标打标，不按页面名称、组件位置或实现团队打标。
2. 每条需求只给一个主要一级标签。若它包含多个可独立验收的目标，先建议拆成多条需求。
3. 注册成功属于获客，不等于激活。激活必须对应用户首次感受到产品核心价值。
4. Engagement 不是一级标签；持续使用、使用深度和习惯形成归入留存。
5. Conversion 不是固定阶段；它描述任意两个事件或阶段之间的转化。
6. Monetization 是能力名称；一级数据标签统一使用 `revenue`。
7. 只有分享行为旨在带来新用户时才标为 `referral`。协作、导出或私下发送如果主要提升现有用户价值，通常标为 `retention`。
8. Revenue 和 Referral 是激活或留存后可能出现的结果，不要求固定先后顺序。
9. 基础设施、安全、可访问性、性能、合规等需求默认使用 `not_applicable`；若需求明确服务某个漏斗指标，则按该目标阶段打标。
10. 信息不足时说明缺少的成功指标，并给出最可能的标签；不要凭页面位置武断分类。

## 输出格式

单条需求：

```yaml
需求: <原需求标题>
lifecycle_stage: activation
中文标签: 激活
lifecycle_detail: onboarding
判断依据: <一句话说明它希望改变的用户行为或指标>
```

多条需求使用表格：

| 需求 | 一级标签 | 中文标签 | 二级标签 | 判断依据 |
| --- | --- | --- | --- | --- |

二级标签不适用时写 `—`。保持原需求标题，不擅自改写需求范围。

## 边界

- 只完成分类、解释和必要的拆分建议。
- 除非用户明确要求，不创建或修改 Issue、PRD、看板标签、分析事件或外部系统数据。
- 如果项目已有正式标签词表，优先复用其 Key；指出它与本 Skill 词表的映射，不并行创造同义标签。
